import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { AgentCommand, AgentReport, ProfileCommit } from "@cg/rpc";
import {
  Context,
  type Duration,
  Effect,
  Layer,
  Option,
  Queue,
  References,
} from "effect";
import { TestClock } from "effect/testing";
import { AgentConfig, type AgentConfigValues } from "../src/config";
import {
  type ContainerInfo,
  type ContainerSpec,
  DockerClient,
  DockerError,
  type DockerClientShape,
} from "../src/DockerClient";
import {
  Installer,
  type InstallerShape,
  installReasons,
  parseAppManifest,
  stubManifest,
} from "../src/Installer";
import { extractSingleFile } from "../src/profile/codec";
import { ProfileCommitter } from "../src/profile/ProfileCommitter";
import { ProfileStore, ProfileStoreError } from "../src/profile/ProfileStore";
import { DiskSpaceError, FreeSpace } from "../src/DiskSpace";
import { tarOfFile, testConfig, unusedDocker } from "./fakes";

const bytes = (text: string) => new TextEncoder().encode(text);
const STEAMAPPS = "/home/ubuntu/.local/share/Steam/steamapps";

/** `appmanifest_*.acf` в формате Steam (вложенный блок — как у настоящего). */
const acf = (fields: Record<string, string>) =>
  [
    '"AppState"',
    "{",
    ...Object.entries(fields).map(([key, value]) => `\t"${key}"\t\t"${value}"`),
    '\t"InstalledDepots"',
    "\t{",
    '\t\t"1"',
    "\t\t{",
    '\t\t\t"manifest"\t\t"42"',
    '\t\t\t"size"\t\t"999"',
    "\t\t}",
    "\t}",
    "}",
    "",
  ].join("\n");

const installed = (appId: number, installdir: string, extra = {}) =>
  acf({
    appid: String(appId),
    Universe: "1",
    name: installdir,
    StateFlags: "4",
    installdir,
    SizeOnDisk: "1000",
    buildid: "1",
    ...extra,
  });

/** Фейковый dockerd (с «Steam» в контейнере), хранилище профилей и оркестратор. */
const makeFake = () => {
  const root = mkdtempSync(join(tmpdir(), "cg-installer-"));
  const library = join(root, "library");
  const lower = join(library, "steamapps");
  const installScratch = join(root, "install");
  const scratch = join(root, "scratch");
  mkdirSync(join(lower, "common"), { recursive: true });
  mkdirSync(installScratch);
  mkdirSync(scratch);
  const state = {
    root,
    library,
    lower,
    installScratch,
    /** SCRATCH_DIR (NVMe): там слой клиента установщика, `.install/<jobId>`. */
    scratch,
    /** `remove` этого контейнера падает (контейнер остаётся, тома смонтированы). */
    failRemove: undefined as string | undefined,
    calls: [] as string[],
    dockerCalls: 0,
    created: [] as ContainerSpec[],
    put: [] as Array<{ container: string; path: string; tar: Uint8Array }>,
    /** Что отдаёт `cat` манифеста целевой игры (нет — файла нет). */
    manifest: undefined as string | undefined,
    /** Что отдаёт grep строк байтов/состояния всех `appmanifest_*.acf`. */
    allManifests: "",
    /** Контейнер установщика исчез: exec отвечает 409. */
    gone: false,
    /** `putArchive` заготовки падает дефектом (ошибка в коде, не в Docker). */
    dieOnStub: false,
    /** Контейнеры `cg.install`, оставшиеся с прошлого запуска. */
    existing: [] as ContainerInfo[],
    labelledVolumes: [] as Array<{
      name: string;
      labels: Record<string, string>;
    }>,
    /** Содержимое библиотеки в момент каждого `removeVolume`. */
    libraryAtRemoveVolume: [] as Array<Array<string>>,
    profiles: { "profiles/u1/v7.cgp": bytes("profile-v7-tar") } as Record<
      string,
      Uint8Array
    >,
    commits: [] as ProfileCommit[],
  };
  /** Свободно на ФС scratch (`FreeSpace`) и каталоги, которые проверялись. */
  const disk = {
    freeBytes: 1024 * 1024 * 1024 * 1024,
    /** statfs не удался. */
    fail: false,
    checked: [] as string[],
  };
  const record = (call: string) => {
    state.dockerCalls++;
    state.calls.push(call);
  };
  const specs = new Map<string, ContainerSpec>();
  const docker: DockerClientShape = {
    ...unusedDocker,
    create: (spec) =>
      Effect.sync(() => {
        record(`create ${spec.name}`);
        state.created.push(spec);
        specs.set(spec.name, spec);
        return `id-${spec.name}`;
      }),
    start: (name) => Effect.sync(() => record(`start ${name}`)),
    wait: (name) =>
      Effect.sync(() => {
        record(`wait ${name}`);
        // Помощник очистки: `rm -rf <путь>…` от root.
        const entrypoint = specs.get(name)?.entrypoint ?? [];
        if (entrypoint[0] === "rm")
          for (const path of entrypoint.slice(2))
            rmSync(path, { recursive: true, force: true });
        return 0;
      }),
    stop: (name, timeoutSec) =>
      Effect.sync(() => record(`stop ${name} ${timeoutSec}`)),
    remove: (name) =>
      Effect.suspend(() => {
        record(`remove ${name}`);
        return name === state.failRemove
          ? Effect.fail(
              new DockerError({
                operation: "remove",
                status: 500,
                message: "device or resource busy",
              }),
            )
          : Effect.void;
      }),
    listByLabel: (label) =>
      Effect.sync(() => {
        record(`list ${label}`);
        return label === "cg.install" ? state.existing : [];
      }),
    createVolume: (volume) =>
      Effect.sync(() => record(`createVolume ${volume.name}`)),
    removeVolume: (name) =>
      Effect.sync(() => {
        record(`removeVolume ${name}`);
        state.libraryAtRemoveVolume.push(tree(state.lower));
      }),
    listVolumes: (label) =>
      Effect.sync(() => {
        record(`listVolumes ${label}`);
        return label === "cg.install" ? state.labelledVolumes : [];
      }),
    volumeExists: (name) =>
      Effect.sync(() => {
        record(`volumeExists ${name}`);
        return false;
      }),
    putArchive: (container, path, tar) =>
      Effect.sync(() => {
        record(`putArchive ${container} ${path}`);
        if (state.dieOnStub && path === STEAMAPPS)
          throw new Error("unexpected bug");
        state.put.push({ container, path, tar });
      }),
    getArchive: (container, path) =>
      Effect.sync(() => {
        record(`getArchive ${container} ${path}`);
        return tarOfFile("cg-profile.tar", bytes("installer-home-tar"));
      }),
    archiveSize: (container, path) =>
      Effect.sync(() => {
        record(`archiveSize ${container} ${path}`);
        return bytes("installer-home-tar").length;
      }),
    exec: (name, cmd) =>
      Effect.suspend(() => {
        state.dockerCalls++;
        if (cmd[0]?.startsWith("/usr/local/bin/cg-"))
          state.calls.push(`exec ${name} ${cmd.join(" ")}`);
        if (state.gone)
          return Effect.fail(
            new DockerError({
              operation: "exec",
              status: 409,
              message: "container is not running",
            }),
          );
        if (cmd[0] === "sh") {
          const expected = [
            "sh",
            "-c",
            `grep -sHE '"(StateFlags|BytesDownloaded|BytesToDownload|BytesStaged|BytesToStage)"' ${STEAMAPPS}/appmanifest_*.acf`,
          ];
          if (cmd.join("|") !== expected.join("|"))
            return Effect.succeed({ exitCode: 2, stdout: "" });
          return Effect.succeed({ exitCode: 0, stdout: state.allManifests });
        }
        if (cmd[0] === "cat") {
          if (cmd.join(" ") !== `cat ${STEAMAPPS}/appmanifest_736260.acf`)
            return Effect.succeed({ exitCode: 2, stdout: "" });
          return Effect.succeed(
            state.manifest === undefined
              ? { exitCode: 1, stdout: "" }
              : { exitCode: 0, stdout: state.manifest },
          );
        }
        return Effect.succeed({ exitCode: 0, stdout: "" });
      }),
  };
  const store = ProfileStore.of({
    get: (objectKey) =>
      Effect.suspend(() => {
        state.calls.push(`store.get ${objectKey}`);
        const tar = state.profiles[objectKey];
        return tar === undefined
          ? Effect.fail(
              new ProfileStoreError({ operation: "get", message: "NoSuchKey" }),
            )
          : Effect.succeed(tar);
      }),
    put: (userId, tar) =>
      Effect.sync(() => {
        state.calls.push(`store.put ${userId}`);
        return {
          objectKey: `profiles/${userId}/new.cgp`,
          sizeBytes: tar.length,
        };
      }),
    remove: (objectKey) =>
      Effect.sync(() => void state.calls.push(`store.remove ${objectKey}`)),
  });
  const committer = ProfileCommitter.of({
    commit: (payload) =>
      Effect.sync(() => {
        state.calls.push(`commit ${payload.objectKey}`);
        state.commits.push(payload);
        return true;
      }),
    attach: () => Effect.void,
  });
  return { state, docker, store, committer, disk };
};

type Fake = ReturnType<typeof makeFake>;

/** Дерево каталога: `путь` для каталогов, `путь=содержимое` для файлов, `путь->цель` для ссылок. */
const tree = (dir: string): Array<string> => {
  if (!existsSync(dir)) return [];
  const out: Array<string> = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const name = relative(dir, full);
      if (entry.isSymbolicLink()) out.push(`${name}->`);
      else if (entry.isDirectory()) {
        out.push(`${name}/`);
        walk(full);
      } else out.push(`${name}=${readFileSync(full, "utf8")}`);
    }
  };
  walk(dir);
  return out.sort();
};

const write = (base: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
};

/** upper apps-слоя установки `jobId` (туда пишет Steam в контейнере). */
const upperOf = (fake: Fake, jobId = "j1") =>
  join(fake.state.installScratch, jobId, "apps", "upper");

/** upper слоя клиента Steam установки `jobId` — на SCRATCH_DIR (NVMe). */
const clientUpperOf = (fake: Fake, jobId = "j1") =>
  join(fake.state.scratch, ".install", jobId, "client", "upper");

/** Есть ли каталоги слоёв установки: [клиент на SCRATCH_DIR, apps на INSTALL_SCRATCH_DIR]. */
const layerDirsExist = (fake: Fake, jobId = "j1") => [
  existsSync(join(fake.state.scratch, ".install", jobId)),
  existsSync(join(fake.state.installScratch, jobId)),
];

interface Harness {
  readonly fake: Fake;
  readonly installer: InstallerShape;
  readonly drain: Effect.Effect<Array<AgentReport>>;
  readonly tick: (duration: Duration.Input) => Effect.Effect<void>;
}

const run = (
  body: (h: Harness) => Effect.Effect<void, unknown>,
  options: {
    readonly setup?: (fake: Fake) => void;
    readonly config?: Partial<AgentConfigValues>;
  } = {},
) => {
  const fake = makeFake();
  options.setup?.(fake);
  const program = Effect.gen(function* () {
    const context = yield* Layer.build(
      Installer.layer.pipe(
        Layer.provide(Layer.succeed(DockerClient, fake.docker)),
        Layer.provide(Layer.succeed(ProfileStore, fake.store)),
        Layer.provide(Layer.succeed(ProfileCommitter, fake.committer)),
        Layer.provide(
          Layer.succeed(
            AgentConfig,
            testConfig({
              roles: ["worker", "gamestore"],
              libraryDir: fake.state.library,
              scratchDir: fake.state.scratch,
              installScratchDir: Option.some(fake.state.installScratch),
              ...options.config,
            }),
          ),
        ),
      ),
    );
    const installer = Context.get(context, Installer);
    const drain = Queue.clear(installer.reports);
    const tick = (duration: Duration.Input) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(duration);
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      });
    yield* tick("0 seconds");
    yield* body({ fake, installer, drain, tick });
  });
  return Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provideService(FreeSpace, (dir) =>
        Effect.suspend(() => {
          fake.disk.checked.push(dir);
          return fake.disk.fail
            ? Effect.fail(new DiskSpaceError({ dir, message: "EIO" }))
            : Effect.succeed(fake.disk.freeBytes);
        }),
      ),
      Effect.provideService(References.MinimumLogLevel, "None"),
      Effect.ensuring(
        Effect.sync(() =>
          rmSync(fake.state.root, { recursive: true, force: true }),
        ),
      ),
    ),
  );
};

type InstallGame = Extract<AgentCommand, { _tag: "InstallGame" }>;

const install: InstallGame = {
  _tag: "InstallGame",
  jobId: "j1",
  appId: 736260,
  userId: "u1",
  profile: { version: 7, objectKey: "profiles/u1/v7.cgp" },
  steamLogin: null,
  steamLoginTimeoutSeconds: 90,
};

const callsFrom = (fake: Fake, from: string) =>
  fake.state.calls.slice(fake.state.calls.indexOf(from));

/** Steam докачал цель (и зависимость) в upper: манифесты со StateFlags 4 и каталоги. */
const steamInstalls = (fake: Fake) => {
  const target = installed(736260, "Baba Is You", {
    SizeOnDisk: "88382496",
    buildid: "12345",
    BytesToDownload: "88382496",
    BytesDownloaded: "88382496",
  });
  write(upperOf(fake), {
    "appmanifest_736260.acf": target,
    "common/Baba Is You/Chowdren": "game",
    "common/Baba Is You/Data/levels.ld": "levels",
    "appmanifest_1628350.acf": installed(1628350, "SteamLinuxRuntime_sniper"),
    "common/SteamLinuxRuntime_sniper/run": "runtime",
  });
  fake.state.manifest = target;
};

/** Отчёт о сбое задачи `j1`. */
const failed = (reason: string, jobId = "j1"): AgentReport => ({
  _tag: "InstallFailed",
  jobId,
  reason,
});

/** Контейнер `j1` и его тома удалены, затем scratch — помощником от root. */
const removedWithScratch = [
  "remove cg-install-j1",
  "removeVolume cg-i-j1-client",
  "removeVolume cg-i-j1-apps",
  "remove cg-i-j1-cleanup",
  "create cg-i-j1-cleanup",
  "start cg-i-j1-cleanup",
  "wait cg-i-j1-cleanup",
  "remove cg-i-j1-cleanup",
];

describe("Installer", () => {
  it("writes stub manifest before starting the installer container", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        expect(h.installer.running()).toEqual(["j1"]);
        expect(callsFrom(h.fake, "createVolume cg-i-j1-client")).toEqual([
          "createVolume cg-i-j1-client",
          "createVolume cg-i-j1-apps",
          "create cg-install-j1",
          "store.get profiles/u1/v7.cgp",
          "putArchive cg-install-j1 /home/ubuntu",
          `putArchive cg-install-j1 ${STEAMAPPS}`,
          "start cg-install-j1",
        ]);
        // Слой клиента Steam — на SCRATCH_DIR (NVMe: pressure-vessel копирует
        // рантайм с fsync), в подкаталоге `.install`, который не id сессии;
        // слой steamapps — в INSTALL_SCRATCH_DIR (ФС библиотеки, перенос `rename`).
        for (const dir of ["upper", "work"]) {
          expect(
            existsSync(join(h.fake.state.scratch, ".install", "j1", "client", dir)),
          ).toBe(true);
          expect(
            existsSync(join(h.fake.state.installScratch, "j1", "apps", dir)),
          ).toBe(true);
          expect(
            existsSync(join(h.fake.state.installScratch, "j1", "client", dir)),
          ).toBe(false);
          expect(
            existsSync(join(h.fake.state.scratch, ".install", "j1", "apps", dir)),
          ).toBe(false);
        }
        expect(readdirSync(h.fake.state.scratch)).toEqual([".install"]);
        expect(h.fake.state.created).toEqual([
          {
            name: "cg-install-j1",
            image: "cg-session:550.163.01",
            env: { CG_MODE: "install", PASSWD: expect.any(String) },
            labels: { "cg.install": "j1", "cg.app": "736260", "cg.user": "u1" },
            network: "cg-sessions",
            // Стрим не нужен: порт наружу не публикуется.
            udpPorts: [],
            binds: [
              "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01:/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1:ro",
              "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01:/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so:ro",
            ],
            mounts: [
              {
                volume: "cg-i-j1-client",
                target: "/home/ubuntu/.local/share/Steam",
              },
              { volume: "cg-i-j1-apps", target: STEAMAPPS },
            ],
            runtime: "nvidia",
            gpus: true,
            shmSizeBytes: 2 * 1024 * 1024 * 1024,
            securityOpt: ["no-new-privileges:true"],
            tmpfs: { "/dev/input": "mode=1777,size=64k,nosuid,nodev,noexec" },
          },
        ]);
        const stub = h.fake.state.put.find((p) => p.path === STEAMAPPS);
        if (stub === undefined) throw new Error("no stub archive");
        const header = new TextDecoder().decode(stub.tar.subarray(0, 512));
        expect(header.slice(0, 100).replace(/\0+$/, "")).toBe(
          "appmanifest_736260.acf",
        );
        // 0644, uid/gid 1000 (ubuntu): Steam в контейнере перепишет файл.
        expect(header.slice(100, 107)).toBe("0000644");
        expect(header.slice(108, 115)).toBe("0001750");
        expect(header.slice(116, 123)).toBe("0001750");
        const content = new TextDecoder().decode(
          yield* extractSingleFile(stub.tar, "appmanifest_736260.acf"),
        );
        expect(content).toBe(stubManifest(736260));
        expect(content).toBe(
          '"AppState"\n{\n\t"appid"\t\t"736260"\n\t"Universe"\t\t"1"\n\t"installdir"\t\t"736260"\n\t"StateFlags"\t\t"1026"\n}\n',
        );
        // Восстановленный профиль — от его версии.
        expect(h.fake.state.put[0]?.tar).toEqual(bytes("profile-v7-tar"));
      }),
    ));

  it("reports progress from appmanifest bytes", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "88",
          BytesDownloaded: "44",
        });
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallProgress",
            jobId: "j1",
            bytesDownloaded: 44,
            bytesTotal: 88,
          },
        ]);
        // Без изменений — без отчёта.
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([]);
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "88",
          BytesDownloaded: "80",
        });
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallProgress",
            jobId: "j1",
            bytesDownloaded: 80,
            bytesTotal: 88,
          },
        ]);
      }),
    ));

  it("promotes new apps and their dependencies into the library", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        steamInstalls(h.fake);
        // Рантайм pressure-vessel и прочее Steam пишет в upper клиента: в
        // библиотеку оттуда не переносится ничего, даже похожее на игру.
        write(clientUpperOf(h.fake), {
          "ubuntu12_64/steam-runtime-sniper/run": "rt",
          "steamapps/appmanifest_42.acf": installed(42, "Ghost"),
          "steamapps/common/Ghost/x": "x",
        });
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallFinished",
            jobId: "j1",
            sizeBytes: 88382496,
            buildId: "12345",
          },
        ]);
        expect(h.installer.running()).toEqual([]);
        // Steam закрыт штатно, профиль сохранён от базовой версии 7, затем
        // контейнер и тома убраны, и только потом — перенос и scratch.
        expect(
          callsFrom(
            h.fake,
            "exec cg-install-j1 /usr/local/bin/cg-steam-shutdown",
          ),
        ).toEqual([
          "exec cg-install-j1 /usr/local/bin/cg-steam-shutdown",
          "exec cg-install-j1 /usr/local/bin/cg-profile-pack",
          "archiveSize cg-install-j1 /tmp/cg-profile.tar",
          "getArchive cg-install-j1 /tmp/cg-profile.tar",
          "store.put u1",
          "commit profiles/u1/new.cgp",
          "stop cg-install-j1 15",
          ...removedWithScratch,
        ]);
        expect(h.fake.state.commits).toEqual([
          {
            userId: "u1",
            baseVersion: 7,
            objectKey: "profiles/u1/new.cgp",
            sizeBytes: bytes("installer-home-tar").length,
            steamLoginSeeded: false,
          },
        ]);
        // Пока тома не удалены (overlay смонтирован), библиотека не менялась.
        expect(h.fake.state.libraryAtRemoveVolume).toEqual([
          ["common/"],
          ["common/"],
        ]);
        expect(tree(h.fake.state.lower)).toEqual(
          [
            `appmanifest_1628350.acf=${installed(1628350, "SteamLinuxRuntime_sniper")}`,
            `appmanifest_736260.acf=${h.fake.state.manifest}`,
            "common/",
            "common/Baba Is You/",
            "common/Baba Is You/Chowdren=game",
            "common/Baba Is You/Data/",
            "common/Baba Is You/Data/levels.ld=levels",
            "common/SteamLinuxRuntime_sniper/",
            "common/SteamLinuxRuntime_sniper/run=runtime",
          ].sort(),
        );
        // Оба каталога слоёв убраны одним помощником.
        expect(layerDirsExist(h.fake)).toEqual([false, false]);
        expect(
          h.fake.state.created.find((spec) => spec.name === "cg-i-j1-cleanup")
            ?.entrypoint,
        ).toEqual([
          "rm",
          "-rf",
          join(h.fake.state.scratch, ".install", "j1"),
          join(h.fake.state.installScratch, "j1"),
        ]);
      }),
    ));

  it("never promotes apps already in the library or per-user dirs", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const before = tree(h.fake.state.lower);
          yield* h.installer.install(install);
          yield* h.tick("0 seconds");
          steamInstalls(h.fake);
          write(upperOf(h.fake), {
            // Обновление игры, которая уже в библиотеке (Steam сменил ей
            // каталог), и её файлы.
            "appmanifest_1794680.acf": installed(
              1794680,
              "Vampire Survivors 2",
              { buildid: "2" },
            ),
            "common/Vampire Survivors 2/game": "new",
            "common/Vampire Survivors/game": "new",
            "common/Vampire Survivors/extra": "new",
            // Зависимость, которая уже есть в библиотеке (Steam её обновил).
            "appmanifest_1628350.acf": installed(
              1628350,
              "SteamLinuxRuntime_sniper",
              { buildid: "9" },
            ),
            "common/SteamLinuxRuntime_sniper/run": "runtime-v9",
            // Пользовательское и служебное — не переносится никогда.
            "compatdata/736260/pfx/user.reg": "reg",
            "workshop/appworkshop_736260.acf": "ws",
            "shadercache/736260/cache": "sc",
            "common/Steam Controller Configs/42/config.vdf": "cfg",
            "libraryfolders.vdf": "lf",
            // Не докачано.
            "appmanifest_998.acf": acf({
              appid: "998",
              StateFlags: "1026",
              installdir: "Half",
            }),
            "common/Half/part": "x",
            // installdir за пределы common.
            "appmanifest_997.acf": installed(997, ".."),
            // Каталог игры — ссылка, а не каталог.
            "appmanifest_996.acf": installed(996, "Linked"),
            // Манифест не той игры, что в имени файла.
            "appmanifest_995.acf": installed(994, "Other"),
            "common/Other/x": "x",
          });
          symlinkSync(
            join(h.fake.state.root, "elsewhere"),
            join(upperOf(h.fake), "common", "Linked"),
          );
          // Манифест-ссылка не переносится.
          writeFileSync(
            join(h.fake.state.root, "elsewhere.acf"),
            installed(993, "Other"),
          );
          symlinkSync(
            join(h.fake.state.root, "elsewhere.acf"),
            join(upperOf(h.fake), "appmanifest_993.acf"),
          );
          yield* h.tick("2 seconds");
          expect((yield* h.drain).map((r) => r._tag)).toEqual([
            "InstallFinished",
          ]);
          expect(tree(h.fake.state.lower)).toEqual(
            [
              ...before,
              `appmanifest_736260.acf=${h.fake.state.manifest}`,
              "common/Baba Is You/",
              "common/Baba Is You/Chowdren=game",
              "common/Baba Is You/Data/",
              "common/Baba Is You/Data/levels.ld=levels",
            ].sort(),
          );
        }),
      {
        setup: (fake) =>
          write(fake.state.lower, {
            "appmanifest_1794680.acf": installed(1794680, "Vampire Survivors"),
            "common/Vampire Survivors/game": "old",
            "appmanifest_1628350.acf": installed(
              1628350,
              "SteamLinuxRuntime_sniper",
            ),
            "common/SteamLinuxRuntime_sniper/run": "runtime-v1",
          }),
      },
    ));

  it("stalled download fails the job and leaves the library untouched", () =>
    run((h) =>
      Effect.gen(function* () {
        const before = tree(h.fake.state.lower);
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "88",
          BytesDownloaded: "44",
        });
        yield* h.tick("2 seconds");
        expect((yield* h.drain).map((r) => r._tag)).toEqual([
          "InstallProgress",
        ]);
        // Частично скачанное лежит в upper — в библиотеку оно не попадёт.
        write(upperOf(h.fake), {
          "common/Baba Is You/Chowdren": "partial",
        });
        yield* h.tick("9 minutes");
        expect(yield* h.drain).toEqual([]);
        yield* h.tick("1 minute");
        expect(yield* h.drain).toEqual([failed(installReasons.stalled)]);
        expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
          removedWithScratch,
        );
        expect(h.fake.state.calls).not.toContain("store.put u1");
        expect(tree(h.fake.state.lower)).toEqual(before);
        expect(layerDirsExist(h.fake)).toEqual([false, false]);
        expect(h.installer.running()).toEqual([]);
      }),
    ));

  it("staging and state changes keep a long install from stalling", () =>
    run((h) =>
      Effect.gen(function* () {
        const manifest = (fields: Record<string, string>) => {
          h.fake.state.manifest = acf({
            appid: "736260",
            BytesToDownload: "88",
            BytesDownloaded: "88",
            BytesToStage: "88",
            ...fields,
          });
        };
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        // Скачано, дальше Steam распаковывает (BytesStaged) и меняет состояние.
        manifest({ StateFlags: "1026", BytesStaged: "0" });
        yield* h.tick("2 seconds");
        yield* h.tick("8 minutes");
        manifest({ StateFlags: "1026", BytesStaged: "40" });
        yield* h.tick("8 minutes");
        manifest({ StateFlags: "1030", BytesStaged: "40" });
        yield* h.tick("8 minutes");
        // Прогресс — только по байтам загрузки; сбоя нет.
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallProgress",
            jobId: "j1",
            bytesDownloaded: 88,
            bytesTotal: 88,
          },
        ]);
        expect(h.installer.running()).toEqual(["j1"]);
        // Ничего не меняется 10 минут — остановилась.
        yield* h.tick("3 minutes");
        expect(yield* h.drain).toEqual([failed(installReasons.stalled)]);
      }),
    ));

  it("dependency downloads in other manifests keep the install from stalling", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        // Цель ждёт в очереди, пока Steam качает зависимость (свой манифест).
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "88",
          BytesDownloaded: "0",
        });
        const dependency = (bytes: number) => {
          h.fake.state.allManifests = [
            `${STEAMAPPS}/appmanifest_736260.acf:\t"StateFlags"\t\t"1026"`,
            `${STEAMAPPS}/appmanifest_1628350.acf:\t"StateFlags"\t\t"1026"`,
            `${STEAMAPPS}/appmanifest_1628350.acf:\t"BytesDownloaded"\t\t"${bytes}"`,
            "",
          ].join("\n");
        };
        dependency(0);
        yield* h.tick("2 seconds");
        for (const bytes of [10, 20, 30]) {
          yield* h.tick("8 minutes");
          dependency(bytes);
        }
        yield* h.tick("8 minutes");
        // 26 минут без изменений манифеста цели — но зависимость качалась.
        expect((yield* h.drain).map((r) => r._tag)).toEqual([
          "InstallProgress",
        ]);
        expect(h.installer.running()).toEqual(["j1"]);
        // Ещё чуть меньше 2 минут — 10 минут без изменений не прошло.
        yield* h.tick("1 minute");
        expect(yield* h.drain).toEqual([]);
        // Больше ничего не меняется 10 минут — остановилась.
        yield* h.tick("2 minutes");
        expect(yield* h.drain).toEqual([failed(installReasons.stalled)]);
      }),
    ));

  it("unexpected defect fails the job and removes the installer", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.installer.install(install);
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([failed(installReasons.unexpected)]);
          expect(h.fake.state.calls).not.toContain("start cg-install-j1");
          expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
            removedWithScratch,
          );
          expect(h.installer.running()).toEqual([]);
          // Установщик свободен: следующая задача принимается.
          h.fake.state.dieOnStub = false;
          yield* h.installer.install({ ...install, jobId: "j2" });
          yield* h.tick("0 seconds");
          expect(h.installer.running()).toEqual(["j2"]);
          expect(h.fake.state.calls).toContain("start cg-install-j2");
        }),
      {
        setup: (fake) => {
          fake.state.dieOnStub = true;
        },
      },
    ));

  it("reconcile removes orphan installs", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const calls = h.fake.state.calls;
          // Сначала контейнер, потом его тома и scratch.
          expect(calls.indexOf("remove cg-install-old")).toBeLessThan(
            calls.indexOf("removeVolume cg-i-old-client"),
          );
          for (const id of ["old", "stale"])
            for (const call of [
              `removeVolume cg-i-${id}-client`,
              `removeVolume cg-i-${id}-apps`,
              `create cg-i-${id}-cleanup`,
            ])
              expect(calls).toContain(call);
          expect(readdirSync(h.fake.state.installScratch).sort()).toEqual([
            "bad name",
            "note.txt",
          ]);
          // Слои клиента установок на SCRATCH_DIR тоже убраны (и того, чей
          // каталог остался только там), постороннее в `.install` — нет.
          expect(calls).toContain("removeVolume cg-i-nvme-client");
          expect(
            readdirSync(join(h.fake.state.scratch, ".install")).sort(),
          ).toEqual(["bad name", "note.txt"]);
          // Слои сессий в SCRATCH_DIR установщик не трогает никогда.
          expect(readdirSync(h.fake.state.scratch).sort()).toEqual([
            ".install",
            "s-live",
          ]);
          expect(calls.filter((call) => call.includes("s-live"))).toEqual([]);
          expect(tree(h.fake.state.lower)).toEqual([
            "common/",
            "common/Kept/",
            "common/Kept/x=1",
          ]);
          expect(h.installer.running()).toEqual([]);
          expect(yield* h.drain).toEqual([]);
        }),
      {
        setup: (fake) => {
          fake.state.existing = [
            {
              name: "cg-install-old",
              labels: { "cg.install": "old" },
              running: true,
            },
          ];
          fake.state.labelledVolumes = [
            { name: "cg-i-old-client", labels: { "cg.install": "old" } },
            { name: "cg-i-old-apps", labels: { "cg.install": "old" } },
          ];
          write(fake.state.installScratch, {
            "old/apps/upper/appmanifest_1.acf": installed(1, "One"),
            "stale/client/upper/x": "x",
            "bad name/x": "x",
            "note.txt": "x",
          });
          write(join(fake.state.scratch, ".install"), {
            "old/client/upper/x": "x",
            "nvme/client/upper/x": "x",
            "bad name/x": "x",
            "note.txt": "x",
          });
          write(fake.state.scratch, { "s-live/client/upper/x": "x" });
          write(fake.state.lower, { "common/Kept/x": "1" });
        },
      },
    ));

  it("installer container that cannot be removed keeps both layer dirs", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.installer.install(install);
          yield* h.tick("0 seconds");
          yield* h.installer.cancel("j1");
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([failed(installReasons.cancelled)]);
          // Тома ещё смонтированы контейнером: ни тома, ни каталоги не трогаем.
          expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual([
            "remove cg-install-j1",
          ]);
          expect(layerDirsExist(h.fake)).toEqual([true, true]);
          expect(h.installer.running()).toEqual([]);
        }),
      {
        setup: (fake) => {
          fake.state.failRemove = "cg-install-j1";
        },
      },
    ));

  it("install with less than MIN_FREE_GB free on the install scratch FS fails without touching Docker", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const before = h.fake.state.dockerCalls;
          yield* h.installer.install(install);
          yield* h.tick("0 seconds");
          expect(installReasons.noSpace).toBe("На сервере закончилось место");
          expect(yield* h.drain).toEqual([failed(installReasons.noSpace)]);
          expect(h.fake.disk.checked).toEqual([h.fake.state.installScratch]);
          expect(h.fake.state.dockerCalls).toBe(before);
          expect(h.installer.running()).toEqual([]);
          // Слой клиента — на SCRATCH_DIR: место проверяется и там.
          h.fake.disk.checked.length = 0;
          h.fake.disk.freeBytes = 1024 * 1024 * 1024 * 1024;
          yield* h.installer.install({ ...install, jobId: "j2" });
          yield* h.tick("0 seconds");
          expect(h.fake.disk.checked).toEqual([
            h.fake.state.installScratch,
            h.fake.state.scratch,
          ]);
          expect(h.installer.running()).toEqual(["j2"]);
        }),
      {
        setup: (fake) => {
          fake.disk.freeBytes = 5 * 1024 * 1024 * 1024 - 1;
        },
        config: { minFreeGb: 5 },
      },
    ));

  it("second install while one runs fails as busy", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        yield* h.installer.install({ ...install, jobId: "j2", appId: 1 });
        // Повтор той же команды — не вторая установка.
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        expect(yield* h.drain).toEqual([failed(installReasons.busy, "j2")]);
        expect(
          h.fake.state.created.filter((spec) =>
            spec.name.startsWith("cg-install-"),
          ),
        ).toHaveLength(1);
        expect(h.installer.running()).toEqual(["j1"]);
      }),
    ));

  it("cancel removes the installer and its scratch", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("2 seconds");
        yield* h.installer.cancel("j1");
        yield* h.tick("0 seconds");
        expect(yield* h.drain).toEqual([failed(installReasons.cancelled)]);
        expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
          removedWithScratch,
        );
        expect(layerDirsExist(h.fake)).toEqual([false, false]);
        expect(h.fake.state.calls).not.toContain("store.put u1");
        expect(h.installer.running()).toEqual([]);
        // Неизвестная задача: Docker не трогаем, отвечаем сбоем.
        const before = h.fake.state.dockerCalls;
        yield* h.installer.cancel("j9");
        yield* h.installer.cancel("../x");
        yield* h.tick("0 seconds");
        expect(yield* h.drain).toEqual([
          failed(installReasons.cancelled, "j9"),
        ]);
        expect(h.fake.state.dockerCalls).toBe(before);
      }),
    ));

  it("installer container that disappears fails the job", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        h.fake.state.gone = true;
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([failed(installReasons.containerGone)]);
        expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
          removedWithScratch,
        );
      }),
    ));

  it("profile that cannot be restored fails before the installer starts", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install({
          ...install,
          profile: { version: 8, objectKey: "profiles/u1/missing.cgp" },
        });
        yield* h.tick("0 seconds");
        expect(yield* h.drain).toEqual([failed(installReasons.profileRestore)]);
        expect(h.fake.state.calls).not.toContain("start cg-install-j1");
        expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
          removedWithScratch,
        );
      }),
    ));

  it("user without a profile fails at once with a Steam login hint", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install({ ...install, profile: null });
        yield* h.tick("0 seconds");
        expect(installReasons.steamLogin).toBe("Войдите в Steam");
        expect(yield* h.drain).toEqual([failed(installReasons.steamLogin)]);
        // Steam без входа ждал бы невидимый QR — контейнер не запускается.
        expect(h.fake.state.calls).not.toContain("start cg-install-j1");
        expect(h.fake.state.calls).not.toContain(
          `putArchive cg-install-j1 ${STEAMAPPS}`,
        );
        expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
          removedWithScratch,
        );
        expect(h.installer.running()).toEqual([]);
      }),
    ));

  it("target that Steam reports installed but did not unpack fails without touching the library", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        steamInstalls(h.fake);
        rmSync(join(upperOf(h.fake), "common", "Baba Is You"), {
          recursive: true,
        });
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([failed(installReasons.promote)]);
        // Зависимость тоже не перенесена: при сбое библиотека не меняется.
        expect(tree(h.fake.state.lower)).toEqual(["common/"]);
        expect(layerDirsExist(h.fake)).toEqual([false, false]);
      }),
    ));

  it("invalid command is rejected without touching Docker", () =>
    run((h) =>
      Effect.gen(function* () {
        const before = h.fake.state.dockerCalls;
        yield* h.installer.install({ ...install, jobId: "../j" });
        yield* h.installer.install({ ...install, jobId: "j3", userId: "u/1" });
        yield* h.installer.install({ ...install, jobId: "j4", appId: 0 });
        yield* h.tick("0 seconds");
        expect(yield* h.drain).toEqual([
          failed(installReasons.invalidCommand, "../j"),
          failed(installReasons.invalidCommand, "j3"),
          failed(installReasons.invalidCommand, "j4"),
        ]);
        expect(h.fake.state.dockerCalls).toBe(before);
        expect(h.installer.running()).toEqual([]);
      }),
    ));

  it("worker-only agent answers installs with a failure and never touches Docker", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.installer.install(install);
          yield* h.installer.cancel("j1");
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([failed(installReasons.notGamestore)]);
          expect(h.fake.state.dockerCalls).toBe(0);
          expect(h.installer.running()).toEqual([]);
        }),
      { config: { roles: ["worker"], installScratchDir: Option.none() } },
    ));
});

describe("parseAppManifest", () => {
  it("reads top-level AppState fields only", () => {
    expect(
      parseAppManifest(
        installed(736260, "Baba Is You", { SizeOnDisk: "88382496" }),
      ),
    ).toEqual({
      appid: "736260",
      Universe: "1",
      name: "Baba Is You",
      StateFlags: "4",
      installdir: "Baba Is You",
      SizeOnDisk: "88382496",
      buildid: "1",
    });
  });

  it("unescapes quotes and backslashes", () => {
    expect(
      parseAppManifest('"AppState"\n{\n\t"name"\t\t"A \\"B\\" \\\\ C"\n}\n'),
    ).toEqual({ name: 'A "B" \\ C' });
  });

  it("rejects text that is not an AppState block", () => {
    for (const text of ["", "garbage", '"Other"\n{\n}\n', '"AppState"\n{\n'])
      expect(parseAppManifest(text)).toBeUndefined();
  });
});
