import { describe, expect, it } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { AgentCommand, AgentReport, ProfileCommit } from "@cg/rpc";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Logger,
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
  CONNECTION_LOG,
  downloadingBytes,
  DownloadingBytes,
  Installer,
  type InstallerShape,
  installReasons,
  parseAppManifest,
  STALL_TIMEOUT,
  stubManifest,
} from "../src/Installer";
import { extractSingleFile } from "../src/profile/codec";
import { PACK_OUTPUT } from "../src/profile/HomeProfile";
import { ProfileCommitter } from "../src/profile/ProfileCommitter";
import { ProfileStore, ProfileStoreError } from "../src/profile/ProfileStore";
import { DiskSpaceError, FreeSpace } from "../src/DiskSpace";
import { PrefixTemplates, type TemplateOutcome } from "../src/PrefixTemplate";
import { tarOfFile, testConfig, testSteamLogin, unusedDocker } from "./fakes";
import { findTarEntry } from "./tar";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/steam-logs/${name}`, import.meta.url), "utf8");

/** Строка принятого входа (спека §5.4, проба на brofrong). */
const LOGGED_ON = fixture("connection_log_logged_on.txt");
/** Клиент ждёт учётных данных: никакого входа нет. */
const WAITING_FOR_CREDENTIALS = fixture("connection_log_waiting.txt");

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
    /** `putArchive` посева входа в `/home/ubuntu` отвечает ошибкой Docker (не 404). */
    failSeed: false,
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
    /**
     * Журнал подключения клиента Steam (спека §5.4): растёт по ходу теста.
     * По умолчанию пуст до старта контейнера (без осевших строк шаблона).
     */
    connectionLog: "",
    /**
     * `start` сразу дописывает в журнал принятый вход (симулирует клиента,
     * который мгновенно вошёл сохранённым токеном) — так большинству тестов
     * не нужно заботиться о детекции входа; тесты самой детекции отключают.
     */
    autoLogin: true,
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
    start: (name) =>
      Effect.sync(() => {
        record(`start ${name}`);
        if (state.autoLogin && name.startsWith("cg-install-"))
          state.connectionLog += LOGGED_ON;
      }),
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
      Effect.suspend(() => {
        record(`putArchive ${container} ${path}`);
        if (state.dieOnStub && path === STEAMAPPS)
          throw new Error("unexpected bug");
        if (state.failSeed && path === "/home/ubuntu")
          return Effect.fail(
            new DockerError({
              operation: "putArchive",
              status: 500,
              message: "no space left on device",
            }),
          );
        state.put.push({ container, path, tar });
        return Effect.void;
      }),
    getArchive: (container, path) =>
      Effect.suspend(() => {
        record(`getArchive ${container} ${path}`);
        // Файлы входа Steam (посев) до записи отсутствуют: пустой дом.
        if (path !== PACK_OUTPUT)
          return Effect.fail(
            new DockerError({
              operation: "getArchive",
              status: 404,
              message: "no such file",
            }),
          );
        return Effect.succeed(
          tarOfFile("cg-profile.tar", bytes("installer-home-tar")),
        );
      }),
    archiveSize: (container, path) =>
      Effect.suspend(() => {
        record(`archiveSize ${container} ${path}`);
        if (path === PACK_OUTPUT)
          return Effect.succeed(bytes("installer-home-tar").length);
        if (path === CONNECTION_LOG)
          return Effect.succeed(Buffer.byteLength(state.connectionLog));
        return Effect.fail(
          new DockerError({
            operation: "archiveSize",
            status: 404,
            message: "no such file",
          }),
        );
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
        if (cmd[0] === "tail") {
          const match = /^\+(\d+)$/.exec(cmd[2] ?? "");
          if (match === null || cmd[3] !== CONNECTION_LOG)
            return Effect.succeed({ exitCode: 2, stdout: "" });
          const skip = Number(match[1]) - 1;
          return Effect.succeed({
            exitCode: 0,
            stdout: state.connectionLog.slice(skip),
          });
        }
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
  /**
   * Отчёты, накопившиеся к этому моменту, кроме `InstallStage` (этапы
   * проверяют свои тесты через `drainAll`).
   */
  readonly drain: Effect.Effect<Array<AgentReport>>;
  /** Все отчёты, накопившиеся к этому моменту. */
  readonly drainAll: Effect.Effect<Array<AgentReport>>;
  readonly tick: (duration: Duration.Input) => Effect.Effect<void>;
}

const run = (
  body: (h: Harness) => Effect.Effect<void, unknown>,
  options: {
    readonly setup?: (fake: Fake) => void;
    readonly config?: Partial<AgentConfigValues>;
    /** Сюда пишется лог установщика (уровень и `Bun.inspect` сообщения); нет — лог выключен. */
    readonly logs?: Array<{ level: string; text: string }>;
    /**
     * Фейк `PrefixTemplates.ensure`: вызов пишется в журнал (`templates.ensure
     * <appId>`); нет — сервис по умолчанию (`skipped`, без записи).
     */
    readonly templates?: (
      appId: number,
      fake: Fake,
    ) => Effect.Effect<TemplateOutcome>;
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
    const drainAll = Queue.clear(installer.reports);
    const drain = drainAll.pipe(
      Effect.map((reports) =>
        reports.filter((report) => report._tag !== "InstallStage"),
      ),
    );
    const tick = (duration: Duration.Input) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(duration);
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      });
    yield* tick("0 seconds");
    yield* body({ fake, installer, drain, drainAll, tick });
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
      // Настоящая `downloadingBytes` — промис внутри цикла опроса, driven
      // TestClock: гонка с реальным event loop (см. её тест ниже отдельно,
      // без TestClock). Здесь, в опросе `watch`, подменяем синхронным
      // обходом тех же каталогов — детерминированно и без лишней моли в тесте.
      Effect.provideService(DownloadingBytes, (dir) =>
        Effect.sync(() => {
          let total = 0;
          const walk = (path: string) => {
            let entries;
            try {
              entries = readdirSync(path, { withFileTypes: true });
            } catch {
              return;
            }
            for (const entry of entries) {
              const full = join(path, entry.name);
              if (entry.isDirectory()) walk(full);
              else if (entry.isFile()) {
                try {
                  total += statSync(full).size;
                } catch {
                  // гонка со Steam/права — пропускаем
                }
              }
            }
          };
          walk(dir);
          return total;
        }),
      ),
      (effect) => {
        const ensure = options.templates;
        return ensure === undefined
          ? effect
          : Effect.provideService(effect, PrefixTemplates, {
              ensure: (appId) =>
                Effect.suspend(() => {
                  fake.state.calls.push(`templates.ensure ${appId}`);
                  return ensure(appId, fake);
                }),
            });
      },
      (effect) => {
        const logs = options.logs;
        if (logs === undefined)
          return Effect.provideService(
            effect,
            References.MinimumLogLevel,
            "None",
          );
        const capture = Logger.make(({ logLevel, message }) => {
          logs.push({ level: logLevel, text: Bun.inspect(message) });
        });
        return effect.pipe(
          Effect.provide(Logger.layer([capture])),
          Effect.provideService(References.MinimumLogLevel, "All"),
        );
      },
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
          // Архивы до старта и старт — по одному монтированию тома клиента
          // (volatile), которое держит помощник.
          "remove cg-i-j1-hold",
          "create cg-i-j1-hold",
          "start cg-i-j1-hold",
          "store.get profiles/u1/v7.cgp",
          "putArchive cg-install-j1 /home/ubuntu",
          `putArchive cg-install-j1 ${STEAMAPPS}`,
          `archiveSize cg-install-j1 ${CONNECTION_LOG}`,
          "start cg-install-j1",
          "remove cg-i-j1-hold",
        ]);
        // Слой клиента Steam — на SCRATCH_DIR (NVMe: pressure-vessel копирует
        // рантайм с fsync), в подкаталоге `.install`, который не id сессии;
        // слой steamapps — в INSTALL_SCRATCH_DIR (ФС библиотеки, перенос `rename`).
        for (const dir of ["upper", "work"]) {
          expect(
            existsSync(
              join(h.fake.state.scratch, ".install", "j1", "client", dir),
            ),
          ).toBe(true);
          expect(
            existsSync(join(h.fake.state.installScratch, "j1", "apps", dir)),
          ).toBe(true);
          expect(
            existsSync(join(h.fake.state.installScratch, "j1", "client", dir)),
          ).toBe(false);
          expect(
            existsSync(
              join(h.fake.state.scratch, ".install", "j1", "apps", dir),
            ),
          ).toBe(false);
        }
        expect(readdirSync(h.fake.state.scratch)).toEqual([".install"]);
        expect(
          h.fake.state.created.filter(
            (spec) => spec.labels["cg.helper"] === undefined,
          ),
        ).toEqual([
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
          // Помощник hold, оставшийся от падения агента посреди старта, держит
          // тома смонтированными: убрать его до томов, иначе 409.
          expect(calls).toContain("remove cg-i-old-hold");
          expect(calls.indexOf("remove cg-i-old-hold")).toBeLessThan(
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

  it("installer with empty profile and a Steam login seeds and starts", () =>
    run((h) =>
      Effect.gen(function* () {
        const steamLogin = testSteamLogin();
        yield* h.installer.install({
          ...install,
          profile: null,
          steamLogin,
        });
        yield* h.tick("0 seconds");
        // Вход вписан, посев и старт прошли — установщик жив, причина
        // steamLogin не отправлена (есть чем войти).
        expect(h.installer.running()).toEqual(["j1"]);
        expect(yield* h.drain).toEqual([]);
        expect(h.fake.state.calls).toContain("start cg-install-j1");
        const seeded = h.fake.state.put.find((p) => p.path === "/home/ubuntu");
        if (seeded === undefined) throw new Error("no login seed archive");
        const local = findTarEntry(seeded.tar, "local.vdf");
        if (local === undefined) throw new Error("no local.vdf in archive");
        expect(new TextDecoder().decode(local)).toContain("ConnectCache");
      }),
    ));

  it("installer fails with steamLogin when Steam does not log on in time", () => {
    const logs: Array<{ level: string; text: string }> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          h.fake.state.autoLogin = false;
          yield* h.installer.install(install);
          yield* h.tick("0 seconds");
          // Клиент начал подключаться (журнал пошёл), но входа нет.
          h.fake.state.connectionLog += WAITING_FOR_CREDENTIALS;
          yield* h.tick("2 seconds");
          // Таймаут отсчитывается от первых строк журнала, а не от старта.
          yield* h.tick("88 seconds");
          expect(yield* h.drain).toEqual([]);
          yield* h.tick("2 seconds");
          expect(yield* h.drain).toEqual([failed(installReasons.steamLogin)]);
          expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
            removedWithScratch,
          );
          // До загрузки не дошли — профиль не сохраняется.
          expect(h.fake.state.calls).not.toContain("store.put u1");
          // Вход взят из профиля, этим запуском не вписан — предупреждения о
          // сломанном посеве нет.
          expect(
            logs.some((line) =>
              line.text.includes("Seeded Steam login was not accepted"),
            ),
          ).toBe(false);
        }),
      { logs },
    );
  });

  it("seeded login that Steam does not accept fails with steamLogin and a warning", () => {
    const logs: Array<{ level: string; text: string }> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          h.fake.state.autoLogin = false;
          yield* h.installer.install({
            ...install,
            profile: null,
            steamLogin: testSteamLogin(),
          });
          yield* h.tick("0 seconds");
          h.fake.state.connectionLog += WAITING_FOR_CREDENTIALS;
          yield* h.tick("2 seconds");
          yield* h.tick("90 seconds");
          expect(yield* h.drain).toEqual([failed(installReasons.steamLogin)]);
          const warning = logs.find((line) =>
            line.text.includes("Seeded Steam login was not accepted"),
          );
          expect(warning?.level).toBe("Warn");
          expect(warning?.text).toContain("j1");
          expect(warning?.text).toContain("u1");
        }),
      { logs },
    );
  });

  it("Steam bootstrap before the connection log does not eat the logon timeout", () =>
    run((h) =>
      Effect.gen(function* () {
        h.fake.state.autoLogin = false;
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        // Клиент обновляется/распаковывается: журнал подключения пока пуст —
        // это не «не вошёл», 90 с ещё не пошли.
        yield* h.tick("5 minutes");
        expect(yield* h.drain).toEqual([]);
        expect(h.installer.running()).toEqual(["j1"]);
        h.fake.state.connectionLog += LOGGED_ON;
        yield* h.tick("2 seconds");
        steamInstalls(h.fake);
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallFinished",
            jobId: "j1",
            sizeBytes: 88382496,
            buildId: "12345",
          },
        ]);
      }),
    ));

  it("installer waits for Steam's logon attempt before the logon timeout", () =>
    run((h) =>
      Effect.gen(function* () {
        h.fake.state.autoLogin = false;
        yield* h.installer.install(install); // steamLoginTimeoutSeconds: 90
        yield* h.tick("0 seconds");
        // t0: клиент начал подключаться (журнал пошёл), но ещё не позвал
        // LogOn() — на части железа UI Steam готовится к этому ~80 с.
        h.fake.state.connectionLog +=
          "[2026-10-26 12:34:16] Client version 1792618285\n" +
          "[2026-10-26 12:34:16] CCMInterface::SetSteamID [U:1:1]\n";
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([]);
        // t0+80s: только теперь клиент зовёт LogOn(). Таймаут прежнего кода
        // отсчитывался от t0 и истёк бы на t0+90 — до ответа сервера.
        yield* h.tick("78 seconds");
        h.fake.state.connectionLog +=
          "[2026-10-26 12:35:36] [Logged Off, 4, 0] [U:1:1] LogOn() called; " +
          "not connected yet, scheduling connection.\n";
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([]);
        // t0+100s: сервер ответил `'OK'` — через 20 с после попытки, задолго
        // до steamLoginTimeoutSeconds (90), который отсчитывается от попытки.
        yield* h.tick("18 seconds");
        expect(yield* h.drain).toEqual([]);
        h.fake.state.connectionLog +=
          "[2026-10-26 12:37:16] RecvMsgClientLogOnResponse() : [U:1:1] 'OK'\n";
        yield* h.tick("2 seconds");
        steamInstalls(h.fake);
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallFinished",
            jobId: "j1",
            sizeBytes: 88382496,
            buildId: "12345",
          },
        ]);
      }),
    ));

  it("installer fails with steamLogin when Steam never attempts to log on", () => {
    const logs: Array<{ level: string; text: string }> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          h.fake.state.autoLogin = false;
          yield* h.installer.install({
            ...install,
            profile: null,
            steamLogin: testSteamLogin(),
          });
          yield* h.tick("0 seconds");
          // Клиент начал подключаться, но так и не позвал LogOn(): застрял в
          // своём окне входа (посев не распознан) — это не STALL_TIMEOUT.
          h.fake.state.connectionLog +=
            "[2026-10-23 10:00:01] Initializing connection manager\n" +
            "[2026-10-23 10:00:02] UI Request: connect\n";
          yield* h.tick("2 seconds");
          expect(yield* h.drain).toEqual([]);
          yield* h.tick("4 minutes");
          expect(yield* h.drain).toEqual([]);
          yield* h.tick("58 seconds");
          expect(yield* h.drain).toEqual([]);
          yield* h.tick("2 seconds");
          expect(yield* h.drain).toEqual([failed(installReasons.steamLogin)]);
          const warning = logs.find((line) =>
            line.text.includes("Seeded Steam login was not accepted"),
          );
          expect(warning?.level).toBe("Warn");
        }),
      { logs },
    );
  });

  it("connection log that never appears fails as stalled after STALL_TIMEOUT", () => {
    const logs: Array<{ level: string; text: string }> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          // Тест считает 10 минут — ровно STALL_TIMEOUT.
          expect(Duration.toMillis(STALL_TIMEOUT)).toBe(10 * 60_000);
          h.fake.state.autoLogin = false;
          yield* h.installer.install({
            ...install,
            profile: null,
            steamLogin: testSteamLogin(),
          });
          yield* h.tick("0 seconds");
          yield* h.tick("9 minutes");
          expect(yield* h.drain).toEqual([]);
          yield* h.tick("1 minute");
          expect(yield* h.drain).toEqual([failed(installReasons.stalled)]);
          expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
            removedWithScratch,
          );
          // Клиент так и не начал подключаться — это не отказ во входе:
          // предупреждения о посеве нет.
          expect(
            logs.some((line) =>
              line.text.includes("Seeded Steam login was not accepted"),
            ),
          ).toBe(false);
        }),
      { logs },
    );
  });

  it("failed login seed write fails with profileRestore and never logs the secrets", () => {
    const logs: Array<{ level: string; text: string }> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          h.fake.state.failSeed = true;
          yield* h.installer.install({
            ...install,
            profile: null,
            steamLogin: testSteamLogin({
              accountName: "s3cr3t-account-name",
              refreshToken: "SECRET-REFRESH-TOKEN",
            }),
          });
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            failed(installReasons.profileRestore),
          ]);
          expect(h.fake.state.calls).not.toContain("start cg-install-j1");
          expect(callsFrom(h.fake, "remove cg-install-j1")).toEqual(
            removedWithScratch,
          );
          const text = logs.map((line) => line.text).join("\n");
          // Причина сбоя в логе есть…
          expect(text).toContain("putArchive failed (500)");
          // …а токена и имени аккаунта — нет.
          expect(text).not.toContain("SECRET-REFRESH-TOKEN");
          expect(text).not.toContain("s3cr3t-account-name");
        }),
      { logs },
    );
  });

  it("installer ignores Logged On lines written before start", () =>
    run((h) =>
      Effect.gen(function* () {
        h.fake.state.autoLogin = false;
        // Строки шаблона клиента, осевшие в overlay до старта этого контейнера.
        h.fake.state.connectionLog = LOGGED_ON;
        yield* h.installer.install({
          ...install,
          steamLoginTimeoutSeconds: 5,
        });
        yield* h.tick("0 seconds");
        // После старта дописаны строки без входа (старый `'OK'` до смещения не считается).
        h.fake.state.connectionLog += WAITING_FOR_CREDENTIALS;
        yield* h.tick("2 seconds");
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([failed(installReasons.steamLogin)]);
      }),
    ));

  it("installer proceeds after logon and commits steamLoginSeeded", () =>
    run((h) =>
      Effect.gen(function* () {
        h.fake.state.autoLogin = false;
        const steamLogin = testSteamLogin();
        yield* h.installer.install({
          ...install,
          profile: null,
          steamLogin,
        });
        yield* h.tick("0 seconds");
        // Контейнер жив, вход пока не пришёл.
        expect(h.installer.running()).toEqual(["j1"]);
        expect(yield* h.drain).toEqual([]);
        h.fake.state.connectionLog += LOGGED_ON;
        yield* h.tick("2 seconds");
        steamInstalls(h.fake);
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallFinished",
            jobId: "j1",
            sizeBytes: 88382496,
            buildId: "12345",
          },
        ]);
        expect(h.fake.state.commits).toEqual([
          {
            userId: "u1",
            baseVersion: null,
            objectKey: "profiles/u1/new.cgp",
            sizeBytes: bytes("installer-home-tar").length,
            steamLoginSeeded: true,
          },
        ]);
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

  it("finished install asks for the prefix template before InstallFinished", () => {
    const logs: Array<{ level: string; text: string }> = [];
    let libraryAtEnsure: Array<string> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.installer.install(install);
          yield* h.tick("0 seconds");
          steamInstalls(h.fake);
          yield* h.tick("2 seconds");
          expect(callsFrom(h.fake, "removeVolume cg-i-j1-client")).toEqual([
            "removeVolume cg-i-j1-client",
            "removeVolume cg-i-j1-apps",
            "templates.ensure 736260",
            "remove cg-i-j1-cleanup",
            "create cg-i-j1-cleanup",
            "start cg-i-j1-cleanup",
            "wait cg-i-j1-cleanup",
            "remove cg-i-j1-cleanup",
          ]);
          // Манифест цели уже перенесён в библиотеку, когда спрашивают шаблон.
          expect(libraryAtEnsure).toContain(
            `appmanifest_736260.acf=${h.fake.state.manifest}`,
          );
          expect(yield* h.drain).toEqual([
            {
              _tag: "InstallFinished",
              jobId: "j1",
              sizeBytes: 88382496,
              buildId: "12345",
            },
          ]);
          const finished = logs.find((line) =>
            line.text.includes("Install finished"),
          );
          expect(finished?.text).toContain('prefixTemplate: "built"');
        }),
      {
        logs,
        templates: (_appId, fake) =>
          Effect.sync(() => {
            libraryAtEnsure = tree(fake.state.lower);
            return "built" as const;
          }),
      },
    );
  });

  it("slow template build does not hold InstallFinished longer than 2 minutes", () => {
    const logs: Array<{ level: string; text: string }> = [];
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.installer.install(install);
          yield* h.tick("0 seconds");
          steamInstalls(h.fake);
          yield* h.tick("2 seconds");
          expect(h.fake.state.calls).toContain("templates.ensure 736260");
          yield* h.tick("119 seconds");
          expect(yield* h.drain).toEqual([]);
          expect(h.installer.running()).toEqual(["j1"]);
          yield* h.tick("1 second");
          expect(yield* h.drain).toEqual([
            {
              _tag: "InstallFinished",
              jobId: "j1",
              sizeBytes: 88382496,
              buildId: "12345",
            },
          ]);
          expect(h.installer.running()).toEqual([]);
          expect(layerDirsExist(h.fake)).toEqual([false, false]);
          const finished = logs.find((line) =>
            line.text.includes("Install finished"),
          );
          expect(finished?.text).toContain('prefixTemplate: "pending"');
        }),
      { logs, templates: () => Effect.never },
    );
  });

  it("failed install does not ask for a template", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.installer.install(install);
          yield* h.tick("0 seconds");
          steamInstalls(h.fake);
          rmSync(join(upperOf(h.fake), "common", "Baba Is You"), {
            recursive: true,
          });
          yield* h.tick("2 seconds");
          expect(yield* h.drain).toEqual([failed(installReasons.promote)]);
          expect(h.fake.state.calls).not.toContain("templates.ensure 736260");
        }),
      { templates: () => Effect.succeed("built") },
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

/** Этапы `InstallStage` из отчётов (остальные отбрасываются). */
const stagesOf = (reports: ReadonlyArray<AgentReport>) =>
  reports.flatMap((report) =>
    report._tag === "InstallStage" ? [[report.jobId, report.stage]] : [],
  );

describe("Installer stages", () => {
  it("reports preparing, login, library, downloading, moving in order", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        // Контейнер поднят и клиент сразу вошёл (autoLogin): Steam готовит
        // загрузку, размера у цели ещё нет.
        expect(stagesOf(yield* h.drainAll)).toEqual([
          ["j1", "preparing"],
          ["j1", "login"],
          ["j1", "library"],
        ]);
        // Steam начал обновление цели: размер загрузки известен.
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "88",
          BytesDownloaded: "0",
        });
        yield* h.tick("2 seconds");
        expect(stagesOf(yield* h.drainAll)).toEqual([["j1", "downloading"]]);
        steamInstalls(h.fake);
        yield* h.tick("2 seconds");
        expect(stagesOf(yield* h.drainAll)).toEqual([["j1", "moving"]]);
      }),
    ));

  it("stays in library while the target has no download size", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        yield* h.drainAll;
        // Steam записал манифест цели, но загрузку ещё не посчитал
        // (данные библиотеки, общие компоненты Windows).
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "0",
          BytesDownloaded: "0",
        });
        for (let i = 0; i < 5; i++) yield* h.tick("2 seconds");
        expect(stagesOf(yield* h.drainAll)).toEqual([]);
      }),
    ));

  it("goes from library straight to moving when the size never showed up", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        yield* h.drainAll;
        steamInstalls(h.fake);
        yield* h.tick("2 seconds");
        expect(stagesOf(yield* h.drainAll)).toEqual([["j1", "moving"]]);
      }),
    ));

  it("reports login before a slow Steam logon, library only after it", () =>
    run((h) =>
      Effect.gen(function* () {
        h.fake.state.autoLogin = false;
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        expect(stagesOf(yield* h.drainAll)).toEqual([
          ["j1", "preparing"],
          ["j1", "login"],
        ]);
        h.fake.state.connectionLog += LOGGED_ON;
        yield* h.tick("2 seconds");
        expect(stagesOf(yield* h.drainAll)).toEqual([["j1", "library"]]);
      }),
    ));
});

/** Разреженный файл: один байт в конце, `size` — `apparent` байт. */
const writeSparse = (path: string, apparent: number) => {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, "x", apparent - 1);
  } finally {
    closeSync(fd);
  }
};

/** ФС под `tmpdir()` хранит разреженные файлы без выделения всего размера. */
const sparseSupported = (() => {
  const dir = mkdtempSync(join(tmpdir(), "cg-sparse-probe-"));
  try {
    const path = join(dir, "probe");
    writeSparse(path, 64 * 1024 * 1024);
    const stat = statSync(path);
    return stat.blocks * 512 < stat.size;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe("downloadingBytes", () => {
  it("sums allocated bytes of files under the dir and is 0 without it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-downloading-"));
    try {
      expect(
        await Effect.runPromise(downloadingBytes(join(dir, "missing"))),
      ).toBe(0);
      write(dir, { "a.bin": "x".repeat(5), "sub/b.bin": "x".repeat(7) });
      // Выделяется блоками: не меньше записанного.
      expect(
        await Effect.runPromise(downloadingBytes(dir)),
      ).toBeGreaterThanOrEqual(12);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Если ФС выделяет разреженному файлу весь размер, проверять нечего.
  it.skipIf(!sparseSupported)(
    "counts a preallocated sparse file by allocated, not apparent size",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cg-downloading-"));
      try {
        const apparent = 64 * 1024 * 1024;
        writeSparse(join(dir, "big.bin"), apparent);
        expect(statSync(join(dir, "big.bin")).size).toBe(apparent);
        expect(await Effect.runPromise(downloadingBytes(dir))).toBeLessThan(
          apparent / 16,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("Installer download progress", () => {
  it("uses downloading bytes when they are ahead of the manifest", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "100",
          BytesDownloaded: "10",
        });
        write(join(upperOf(h.fake), "downloading", "736260"), {
          "part.bin": "x".repeat(40),
        });
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallProgress",
            jobId: "j1",
            bytesDownloaded: 40,
            bytesTotal: 100,
          },
        ]);
      }),
    ));

  it("never decreases and never exceeds the total", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        const downloading = join(upperOf(h.fake), "downloading", "736260");
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "100",
          BytesDownloaded: "10",
        });
        // Каталог «downloading» уже больше общего размера (временно, до
        // перезаписи манифеста Steam) — отчёт не должен превысить total.
        write(downloading, { "part.bin": "x".repeat(140) });
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "InstallProgress",
            jobId: "j1",
            bytesDownloaded: 100,
            bytesTotal: 100,
          },
        ]);
        // Файлы ушли из «downloading» (например, Steam их переместил), а
        // манифест отстаёт — отчёт не должен уменьшиться.
        rmSync(downloading, { recursive: true, force: true });
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "100",
          BytesDownloaded: "50",
        });
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([]);
      }),
    ));

  it("caps at a shrinking total even though reports never decrease otherwise", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.installer.install(install);
        yield* h.tick("0 seconds");
        // Steam поднял процент (без downloading-каталога — тут он не при чём).
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "100",
          BytesDownloaded: "90",
        });
        yield* h.tick("2 seconds");
        // Steam пересчитал зависимости: BytesToDownload и BytesDownloaded
        // оба упали. «Не меньше прежнего» не должно вытолкнуть отчёт за
        // новый total — предел побеждает плавность.
        h.fake.state.manifest = acf({
          appid: "736260",
          StateFlags: "1026",
          BytesToDownload: "50",
          BytesDownloaded: "40",
        });
        yield* h.tick("2 seconds");
        const reports = (yield* h.drain).filter(
          (r): r is Extract<AgentReport, { _tag: "InstallProgress" }> =>
            r._tag === "InstallProgress",
        );
        expect(reports.map((r) => [r.bytesDownloaded, r.bytesTotal])).toEqual([
          [90, 100],
          [50, 50],
        ]);
        for (const r of reports)
          expect(r.bytesDownloaded).toBeLessThanOrEqual(r.bytesTotal);
      }),
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
