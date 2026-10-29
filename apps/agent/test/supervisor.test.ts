import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCommand, AgentReport, ProfileCommit } from "@cg/rpc";
import {
  Context,
  Deferred,
  type Duration,
  Effect,
  Layer,
  Logger,
  Queue,
  References,
} from "effect";
import { TestClock } from "effect/testing";
import { AgentConfig } from "../src/config";
import {
  type ContainerInfo,
  type ContainerSpec,
  DockerClient,
  DockerError,
  type DockerClientShape,
} from "../src/DockerClient";
import {
  PACK_OUTPUT,
  PROFILE_MAX_BYTES,
  saveProfile,
} from "../src/profile/HomeProfile";
import {
  ProfileCommitError,
  ProfileCommitter,
} from "../src/profile/ProfileCommitter";
import { ProfileStore, ProfileStoreError } from "../src/profile/ProfileStore";
import {
  CLOUD_LOG,
  commands,
  failReasons,
  GPU_FAILURE_LINE,
  parseGameExit,
  SessionSupervisor,
  type SessionSupervisorShape,
} from "../src/SessionSupervisor";
import { DiskSpaceError, FreeSpace } from "../src/DiskSpace";
import { PrefixTemplates } from "../src/PrefixTemplate";
import { defaultHostProbe, HostProbe } from "../src/WorkerMonitor";
import { tarOfFile, testConfig, testSteamLogin, unusedDocker } from "./fakes";
import { findTarEntry } from "./tar";

const bytes = (text: string) => new TextEncoder().encode(text);

const MiB = 2 ** 20;

/** Строка `nvidia-smi` (`NVIDIA_SMI_ARGS`) с занятой памятью и загрузкой GPU. */
const smiLine = (usedMib: number, util: number) =>
  `NVIDIA GeForce GTX 1650 SUPER, 4096, ${usedMib}, ${util}, 0, 40, 550.163.01\n`;

/** `nvidia-smi -q -x -d PIDS` с процессами `[pid, тип, МиБ]`. */
const gpuProcessesXml = (
  processes: ReadonlyArray<readonly [number, string, number]>,
) =>
  [
    "<nvidia_smi_log>",
    '<gpu id="00000000:07:00.0">',
    "<processes>",
    ...processes.map(
      ([pid, type, mib]) =>
        `<process_info><pid>${pid}</pid><type>${type}</type><process_name>p${pid}</process_name><used_memory>${mib} MiB</used_memory></process_info>`,
    ),
    "</processes>",
    "</gpu>",
    "</nvidia_smi_log>",
  ].join("\n");

/** Ошибка dockerd, когда процесс контейнера висит в D-состоянии. */
const hung = (operation: string) =>
  new DockerError({
    operation,
    status: 500,
    message: "tried to kill container, but did not receive an exit event",
  });

/** Фейковый dockerd, хранилище профилей и оркестратор: состояние и общий журнал вызовов. */
const makeFake = () => {
  const scratch = mkdtempSync(join(tmpdir(), "cg-supervisor-"));
  const state = {
    scratch,
    calls: [] as string[],
    created: [] as ContainerSpec[],
    /** Selkies отвечает на /api/status. */
    selkies: true,
    /** Процесс игры жив (pgrep). */
    game: false,
    /** Число строк «Upload complete, result OK» в cloud_log.txt. */
    cloud: 0,
    logs: "",
    failCreate: false,
    /** Контейнер исчез: exec отвечает 409. */
    gone: false,
    existing: [] as ContainerInfo[],
    /** Контейнеры-помощники (`cg.helper`), оставшиеся с прошлого запуска. */
    helpers: [] as ContainerInfo[],
    /** Ответы `inspect` по имени контейнера (нет — контейнера нет). */
    inspected: {} as Record<string, ContainerInfo>,
    /** Подменённый код выхода pgrep. */
    pgrepExit: undefined as number | undefined,
    /** Содержимое `/tmp/cg-game-exit` (нет — файла нет). */
    gameExit: undefined as string | undefined,
    /** Файлы в контейнере сессии для `getArchive` (полный путь → текст). */
    home: {} as Record<string, string>,
    /** Сбой подсчёта маркеров: `exit` — grep вышел с кодом 2, `docker` — exec упал. */
    cloudFail: undefined as "exit" | "docker" | undefined,
    /** Закрыт — `grep` журнала облака ждёт его открытия. */
    cloudGate: undefined as Deferred.Deferred<void> | undefined,
    /**
     * Ответы `cg-session-stage` по очереди: строка — stdout (с переводом строки),
     * `DockerError` — exec упал, `{ exitCode }` — скрипт вышел с этим кодом.
     * Очередь пуста — повторяется последний ответ (сначала `steam`).
     */
    stages: [] as Array<string | DockerError | { exitCode: number }>,
    lastStage: "steam" as string | DockerError | { exitCode: number },
    /** Число вызовов `cg-session-stage` (в `calls` не пишутся: опрос частый). */
    stageChecks: 0,
    /** Закрыт — `docker start` контейнера сессии ждёт его открытия. */
    startGate: undefined as Deferred.Deferred<void> | undefined,
    /** Код выхода помощника по имени (нет — 0). */
    helperExit: {} as Record<string, number>,
    /** Записи лога уровня Warn и выше: `[уровень, сообщение…]`. */
    logged: [] as Array<string>,
    /** Число любых обращений к DockerClient. */
    dockerCalls: 0,
    /** Тома, которые есть в dockerd (`volumeExists`). */
    volumes: [] as string[],
    /** Тома с метками для `listVolumes`. */
    labelledVolumes: [] as Array<{
      name: string;
      labels: Record<string, string>;
    }>,
    /** Архивы, положенные в контейнеры (`putArchive`). */
    put: [] as Array<{ container: string; path: string; tar: Uint8Array }>,
    /** Что пакует cg-profile-pack в контейнере сессии и в помощнике импорта. */
    packed: bytes("session-home-tar"),
    legacy: bytes("legacy-home-tar"),
    /** Размер упакованного архива по `archiveSize` (нет — настоящий размер). */
    packedSize: undefined as number | undefined,
    legacySize: undefined as number | undefined,
    packExit: 0,
    /** Объекты профилей в хранилище (расшифрованные tar). */
    profiles: { "profiles/u1/v7.cgp": bytes("profile-v7-tar") } as Record<
      string,
      Uint8Array
    >,
    uploaded: [] as Array<{ userId: string; tar: Uint8Array }>,
    putFail: false,
    commits: [] as ProfileCommit[],
    commit: "accept" as "accept" | "reject" | "fail",
    /**
     * Сколько ближайших `stop`/`remove` контейнеров сессий (`cg-session-*`) и
     * `removeVolume` падают, как при процессе в D-состоянии.
     */
    stopFails: 0,
    removeFails: 0,
    removeVolumeFails: 0,
    /**
     * Замеры ресурсов игры: `docker stats` (счётчики CPU растут на шаг за
     * вызов), `docker top` и вывод `nvidia-smi`; `undefined` у `smi`/
     * `gpuProcesses` — `nvidia-smi` не ответил.
     */
    metrics: {
      memoryBytes: 512 * MiB,
      cpuStep: 0,
      systemStep: 120_000_000_000,
      onlineCpus: 12,
      statsCalls: 0,
      statsFail: false,
      /** Сколько «идёт» каждый `docker stats` (по TestClock): медленный замер. */
      statsDelay: undefined as Duration.Input | undefined,
      topPids: [] as number[],
      topFail: false,
      smi: smiLine(300, 0) as string | undefined,
      gpuProcesses: gpuProcessesXml([]) as string | undefined,
    },
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
  const docker: DockerClientShape = {
    ...unusedDocker,
    create: (spec) =>
      Effect.suspend(() => {
        record(`create ${spec.name}`);
        if (state.failCreate && spec.name.startsWith("cg-session-"))
          return Effect.fail(
            new DockerError({
              operation: "create",
              status: 404,
              message: "No such image",
            }),
          );
        state.created.push(spec);
        return Effect.succeed(`id-${spec.name}`);
      }),
    start: (name) =>
      Effect.suspend(() => {
        record(`start ${name}`);
        return state.startGate !== undefined && name.startsWith("cg-session-")
          ? Deferred.await(state.startGate)
          : Effect.void;
      }),
    wait: (name) =>
      Effect.sync(() => {
        record(`wait ${name}`);
        return state.helperExit[name] ?? 0;
      }),
    stop: (name, timeoutSec) =>
      Effect.suspend(() => {
        record(`stop ${name} ${timeoutSec}`);
        if (name.startsWith("cg-session-") && state.stopFails > 0) {
          state.stopFails--;
          return Effect.fail(hung("stop"));
        }
        return Effect.void;
      }),
    remove: (name) =>
      Effect.suspend(() => {
        record(`remove ${name}`);
        if (name.startsWith("cg-session-") && state.removeFails > 0) {
          state.removeFails--;
          return Effect.fail(hung("remove"));
        }
        return Effect.void;
      }),
    inspect: (name) =>
      Effect.sync(() => {
        record(`inspect ${name}`);
        return (
          state.inspected[name] ??
          state.existing.find((container) => container.name === name)
        );
      }),
    logs: () =>
      Effect.sync(() => {
        state.dockerCalls++;
        return state.logs;
      }),
    listByLabel: (label) =>
      Effect.sync(() => {
        record(`list ${label}`);
        return label === "cg.helper" ? state.helpers : state.existing;
      }),
    createVolume: (volume) =>
      Effect.sync(() => record(`createVolume ${volume.name}`)),
    removeVolume: (name) =>
      Effect.suspend(() => {
        record(`removeVolume ${name}`);
        if (state.removeVolumeFails > 0) {
          state.removeVolumeFails--;
          return Effect.fail(hung("removeVolume"));
        }
        return Effect.void;
      }),
    volumeExists: (name) =>
      Effect.sync(() => {
        record(`volumeExists ${name}`);
        return state.volumes.includes(name);
      }),
    listVolumes: (label) =>
      Effect.sync(() => {
        record(`listVolumes ${label}`);
        return state.labelledVolumes;
      }),
    putArchive: (container, path, tar) =>
      Effect.sync(() => {
        record(`putArchive ${container} ${path}`);
        state.put.push({ container, path, tar });
      }),
    getArchive: (container, path) =>
      Effect.suspend(() => {
        record(`getArchive ${container} ${path}`);
        const text = state.home[path];
        if (text !== undefined)
          return Effect.succeed(
            tarOfFile(path.slice(path.lastIndexOf("/") + 1), bytes(text)),
          );
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
          tarOfFile(
            "cg-profile.tar",
            container.endsWith("-import") ? state.legacy : state.packed,
          ),
        );
      }),
    archiveSize: (container, path) =>
      Effect.suspend(() => {
        record(`archiveSize ${container} ${path}`);
        // Обёртка игры в образе сессии (setLaunchOptions).
        if (path === "/usr/local/bin/cg-game-exit") return Effect.succeed(1024);
        if (path !== PACK_OUTPUT)
          return Effect.fail(
            new DockerError({
              operation: "archiveSize",
              status: 404,
              message: "no such file",
            }),
          );
        return Effect.succeed(
          container.endsWith("-import")
            ? (state.legacySize ?? state.legacy.length)
            : (state.packedSize ?? state.packed.length),
        );
      }),
    stats: () =>
      Effect.suspend(() => {
        const m = state.metrics;
        if (m.statsFail)
          return Effect.fail(
            new DockerError({ operation: "stats", message: "timeout" }),
          );
        m.statsCalls++;
        const delay =
          m.statsDelay === undefined ? Effect.void : Effect.sleep(m.statsDelay);
        return Effect.as(delay, {
          memoryBytes: m.memoryBytes,
          cpuNanos: m.statsCalls * m.cpuStep,
          systemNanos: m.statsCalls * m.systemStep,
          onlineCpus: m.onlineCpus,
        });
      }),
    top: () =>
      state.metrics.topFail
        ? Effect.fail(new DockerError({ operation: "top", message: "timeout" }))
        : Effect.sync(() => state.metrics.topPids),
    exec: (name, cmd) =>
      Effect.suspend(() => {
        state.dockerCalls++;
        if (cmd[0] === "/usr/local/bin/cg-session-stage") state.stageChecks++;
        else if (cmd[0] === "pkill" || cmd[0]?.startsWith("/usr/local/bin/cg-"))
          state.calls.push(`exec ${name} ${cmd.join(" ")}`);
        if (state.gone)
          return Effect.fail(
            new DockerError({
              operation: "exec",
              status: 409,
              message: "container is not running",
            }),
          );
        switch (cmd[0]) {
          case "curl":
            if (cmd.at(-1) !== "http://localhost:8080/api/status")
              return Effect.succeed({ exitCode: 2, stdout: "" });
            return Effect.succeed({
              exitCode: state.selkies ? 0 : 7,
              stdout: "",
            });
          case "pgrep":
            if (cmd.join(" ") !== "pgrep -f AppId=1794680( |$)")
              return Effect.succeed({ exitCode: 2, stdout: "" });
            return Effect.succeed({
              exitCode: state.pgrepExit ?? (state.game ? 0 : 1),
              stdout: state.game ? "42\n" : "",
            });
          case "grep":
            // Ровно такой вызов: считаем маркеры выгрузки в журнале облака Steam.
            if (
              cmd.join("|") !==
              ["grep", "-cF", "Upload complete, result OK", CLOUD_LOG].join("|")
            )
              return Effect.succeed({ exitCode: 2, stdout: "" });
            if (state.cloudFail === "exit")
              return Effect.succeed({ exitCode: 2, stdout: "" });
            if (state.cloudFail === "docker")
              return Effect.fail(
                new DockerError({ operation: "exec", message: "timeout" }),
              );
            return (
              state.cloudGate === undefined
                ? Effect.void
                : Deferred.await(state.cloudGate)
            ).pipe(
              Effect.andThen(
                Effect.sync(() => ({
                  exitCode: state.cloud > 0 ? 0 : 1,
                  stdout: `${state.cloud}\n`,
                })),
              ),
            );
          case "cat":
            if (cmd.join(" ") !== "cat /tmp/cg-game-exit")
              return Effect.succeed({ exitCode: 2, stdout: "" });
            return Effect.succeed(
              state.gameExit === undefined
                ? { exitCode: 1, stdout: "" }
                : { exitCode: 0, stdout: state.gameExit },
            );
          case "pkill":
            if (cmd.join(" ") !== "pkill -TERM -f AppId=1794680( |$)")
              return Effect.succeed({ exitCode: 2, stdout: "" });
            state.game = false;
            return Effect.succeed({ exitCode: 0, stdout: "" });
          case "/usr/local/bin/cg-session-stage": {
            if (cmd.join(" ") !== "/usr/local/bin/cg-session-stage 1794680")
              return Effect.succeed({ exitCode: 2, stdout: "" });
            const answer = state.stages.shift() ?? state.lastStage;
            state.lastStage = answer;
            if (answer instanceof DockerError) return Effect.fail(answer);
            return Effect.succeed(
              typeof answer === "string"
                ? { exitCode: 0, stdout: `${answer}\n` }
                : { exitCode: answer.exitCode, stdout: "" },
            );
          }
          case "/usr/local/bin/cg-steam-shutdown":
            return Effect.succeed({ exitCode: 0, stdout: "" });
          case "/usr/local/bin/cg-profile-pack":
            return Effect.succeed({ exitCode: state.packExit, stdout: "" });
          default:
            return Effect.succeed({ exitCode: 127, stdout: "" });
        }
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
      Effect.suspend(() => {
        state.calls.push(`store.put ${userId}`);
        if (state.putFail)
          return Effect.fail(
            new ProfileStoreError({
              operation: "put",
              message: "connection refused",
            }),
          );
        state.uploaded.push({ userId, tar });
        return Effect.succeed({
          objectKey: `profiles/${userId}/new.cgp`,
          sizeBytes: tar.length + 32,
        });
      }),
    remove: (objectKey) =>
      Effect.sync(() => void state.calls.push(`store.remove ${objectKey}`)),
  });
  const committer = ProfileCommitter.of({
    commit: (payload) =>
      Effect.suspend(() => {
        state.calls.push(`commit ${payload.objectKey}`);
        state.commits.push(payload);
        if (state.commit === "fail")
          return Effect.fail(
            new ProfileCommitError({ message: "orchestrator unreachable" }),
          );
        return Effect.succeed(state.commit === "accept");
      }),
    attach: () => Effect.void,
  });
  return { state, docker, store, committer, disk };
};

type Fake = ReturnType<typeof makeFake>;

interface Harness {
  readonly fake: Fake;
  readonly supervisor: SessionSupervisorShape;
  /**
   * Отчёты, накопившиеся к этому моменту, кроме `SessionStage` и
   * `SessionMetrics` (их проверяют свои тесты через `drainAll`).
   */
  readonly drain: Effect.Effect<Array<AgentReport>>;
  /** Все отчёты, накопившиеся к этому моменту. */
  readonly drainAll: Effect.Effect<Array<AgentReport>>;
  readonly tick: (duration: Duration.Input) => Effect.Effect<void>;
}

/**
 * Супервизор на фейках и TestClock; `setup` готовит фейк до старта.
 * `templates` — фейк `PrefixTemplates`: `ensure` пишет `templates.ensure
 * <appId>` в журнал вызовов (нет — сервис по умолчанию, без записи).
 */
const run = (
  body: (h: Harness) => Effect.Effect<void, unknown>,
  setup: (fake: Fake) => void = () => {},
  options: { readonly templates?: boolean } = {},
) => {
  const fake = makeFake();
  setup(fake);
  const program = Effect.gen(function* () {
    const context = yield* Layer.build(
      SessionSupervisor.layer.pipe(
        Layer.provide(Layer.succeed(DockerClient, fake.docker)),
        Layer.provide(Layer.succeed(ProfileStore, fake.store)),
        Layer.provide(Layer.succeed(ProfileCommitter, fake.committer)),
        Layer.provide(
          Layer.succeed(
            AgentConfig,
            testConfig({ scratchDir: fake.state.scratch }),
          ),
        ),
      ),
    );
    const supervisor = Context.get(context, SessionSupervisor);
    const drainAll = Queue.clear(supervisor.reports);
    const drain = drainAll.pipe(
      Effect.map((reports) =>
        reports.filter(
          (report) =>
            report._tag !== "SessionStage" && report._tag !== "SessionMetrics",
        ),
      ),
    );
    const tick = (duration: Duration.Input) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(duration);
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      });
    yield* tick("0 seconds");
    yield* body({ fake, supervisor, drain, drainAll, tick });
  });
  return Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provideService(HostProbe, {
        ...defaultHostProbe,
        nvidiaSmi: Effect.sync(() => fake.state.metrics.smi),
        nvidiaSmiProcesses: Effect.sync(() => fake.state.metrics.gpuProcesses),
      }),
      Effect.provideService(FreeSpace, (dir) =>
        Effect.suspend(() => {
          fake.disk.checked.push(dir);
          return fake.disk.fail
            ? Effect.fail(new DiskSpaceError({ dir, message: "EIO" }))
            : Effect.succeed(fake.disk.freeBytes);
        }),
      ),
      (effect) =>
        options.templates === true
          ? Effect.provideService(effect, PrefixTemplates, {
              ensure: (appId) =>
                Effect.sync(() => {
                  fake.state.calls.push(`templates.ensure ${appId}`);
                  return "built" as const;
                }),
              building: () => false,
            })
          : effect,
      Effect.provide(
        Logger.layer([
          Logger.make(({ logLevel, message }) => {
            fake.state.logged.push(JSON.stringify([logLevel, message]));
          }),
        ]),
      ),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
      Effect.ensuring(
        Effect.sync(() =>
          rmSync(fake.state.scratch, { recursive: true, force: true }),
        ),
      ),
    ),
  );
};

/** Созданные контейнеры сессий (без помощников). */
const sessionSpecs = (fake: Fake) =>
  fake.state.created.filter((spec) => spec.labels["cg.helper"] === undefined);

/** Вызовы после первого `from` (включительно). */
const callsFrom = (fake: Fake, from: string) =>
  fake.state.calls.slice(fake.state.calls.indexOf(from));

/** Остановка контейнера сессии `id` с сохранённым профилем: удалить его и слои. */
const removedWithLayers = (id: string) => [
  `stop cg-session-${id} 15`,
  `remove cg-session-${id}`,
  `removeVolume cg-s-${id}-client`,
  `removeVolume cg-s-${id}-apps`,
  `remove cg-s-${id}-cleanup`,
  `create cg-s-${id}-cleanup`,
  `start cg-s-${id}-cleanup`,
  `wait cg-s-${id}-cleanup`,
  `remove cg-s-${id}-cleanup`,
];

/** Помощник, который держит тома слоёв `id` смонтированными до старта контейнера. */
const held = (id: string) => [
  `remove cg-s-${id}-hold`,
  `create cg-s-${id}-hold`,
  `start cg-s-${id}-hold`,
];

/** Помощник, снимающий метку volatile со слоёв оставленного контейнера `id`. */
const unmarked = (id: string) => [
  `remove cg-s-${id}-unmark`,
  `create cg-s-${id}-unmark`,
  `start cg-s-${id}-unmark`,
  `wait cg-s-${id}-unmark`,
  `remove cg-s-${id}-unmark`,
];

const start: Extract<AgentCommand, { _tag: "StartSession" }> = {
  _tag: "StartSession",
  sessionId: "s1",
  userId: "u1",
  appId: 1794680,
  slot: 1,
  udpPort: 59001,
  profile: null,
  steamLogin: null,
};

const streamUrl = "http://cg-session-s1:8080";

/** Старт сессии и ожидание StreamReady (Selkies уже отвечает). */
const startReady = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.supervisor.handle(start);
    yield* h.tick("0 seconds");
    expect(yield* h.drain).toEqual([
      { _tag: "StreamReady", sessionId: "s1", streamUrl },
    ]);
  });

describe("SessionSupervisor", () => {
  it("start creates container with slot port, labels, overlay mounts and env", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.supervisor.handle(start);
        yield* h.tick("0 seconds");
        expect(sessionSpecs(h.fake)).toHaveLength(1);
        const spec = sessionSpecs(h.fake)[0];
        expect(spec).toEqual({
          name: "cg-session-s1",
          image: "cg-session:550.163.01",
          env: {
            CG_APP_ID: "1794680",
            SELKIES_WEBRTC_UDP_MUX_PORT: "59001",
            SELKIES_WEBRTC_PUBLIC_IP: "203.0.113.7",
            PASSWD: expect.any(String),
            SELKIES_MANUAL_WIDTH: "1920",
            SELKIES_MANUAL_HEIGHT: "1080",
            DISPLAY_SIZEW: "1920",
            DISPLAY_SIZEH: "1080",
          },
          labels: {
            "cg.session": "s1",
            "cg.slot": "1",
            "cg.app": "1794680",
            "cg.user": "u1",
            "cg.base-version": "",
          },
          network: "cg-sessions",
          udpPorts: [59001],
          // Тома дома cg-home-* больше нет: клиент Steam и библиотека — overlay-тома сессии.
          binds: [
            "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01:/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1:ro",
            "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01:/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so:ro",
          ],
          mounts: [
            {
              volume: "cg-s-s1-client",
              target: "/home/ubuntu/.local/share/Steam",
            },
            {
              volume: "cg-s-s1-apps",
              target: "/home/ubuntu/.local/share/Steam/steamapps",
            },
          ],
          runtime: "nvidia",
          gpus: true,
          shmSizeBytes: 2 * 1024 * 1024 * 1024,
          // Ни sudo, ни su, ни pkexec в контейнере не поднимают права.
          securityOpt: ["no-new-privileges:true"],
          // Каталог для интерпозера геймпадов: без sudo entrypoint его не создаст.
          tmpfs: { "/dev/input": "mode=1777,size=64k,nosuid,nodev,noexec" },
        });
      }),
    ));

  it("session env gets the commanded display size", () =>
    run((h) =>
      Effect.gen(function* () {
        const envOf = (sessionId: string) =>
          sessionSpecs(h.fake).find(
            (spec) => spec.name === `cg-session-${sessionId}`,
          )?.env;

        // Разрешение из белого списка — ровно оно.
        yield* h.supervisor.handle({
          ...start,
          sessionId: "s-1440p",
          display: { width: 2560, height: 1440 },
        });
        yield* h.tick("0 seconds");
        expect(envOf("s-1440p")).toMatchObject({
          SELKIES_MANUAL_WIDTH: "2560",
          SELKIES_MANUAL_HEIGHT: "1440",
          DISPLAY_SIZEW: "2560",
          DISPLAY_SIZEH: "1440",
        });

        // Размер не из белого списка — умолчание 1920×1080.
        yield* h.supervisor.handle({
          ...start,
          sessionId: "s-bad",
          slot: 0,
          udpPort: 59000,
          display: { width: 1000, height: 700 },
        });
        yield* h.tick("0 seconds");
        expect(envOf("s-bad")).toMatchObject({
          SELKIES_MANUAL_WIDTH: "1920",
          SELKIES_MANUAL_HEIGHT: "1080",
          DISPLAY_SIZEW: "1920",
          DISPLAY_SIZEH: "1080",
        });

        // Поля нет вовсе (старый оркестратор) — тоже умолчание.
        yield* h.supervisor.handle({
          ...start,
          sessionId: "s-none",
          slot: 1,
          udpPort: 59001,
        });
        yield* h.tick("0 seconds");
        expect(envOf("s-none")).toMatchObject({
          SELKIES_MANUAL_WIDTH: "1920",
          SELKIES_MANUAL_HEIGHT: "1080",
          DISPLAY_SIZEW: "1920",
          DISPLAY_SIZEH: "1080",
        });
      }),
    ));

  it("start with less than MIN_FREE_GB free on the scratch FS fails without touching Docker", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const before = h.fake.state.dockerCalls;
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          expect(failReasons.noSpace).toBe("На сервере закончилось место");
          expect(yield* h.drain).toEqual([
            { _tag: "Failed", sessionId: "s1", reason: failReasons.noSpace },
          ]);
          expect(h.fake.disk.checked).toEqual([h.fake.state.scratch]);
          expect(h.fake.state.dockerCalls).toBe(before);
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => {
        fake.disk.freeBytes = 20 * 1024 * 1024 * 1024 - 1;
      },
    ));

  it("start with exactly MIN_FREE_GB free goes ahead", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          expect(h.fake.disk.checked).toEqual([h.fake.state.scratch]);
        }),
      (fake) => {
        fake.disk.freeBytes = 20 * 1024 * 1024 * 1024;
      },
    ));

  it("free space that cannot be measured does not block the start", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          expect(h.fake.disk.checked).toEqual([h.fake.state.scratch]);
        }),
      (fake) => {
        fake.disk.fail = true;
      },
    ));

  it("each session container gets its own random account password", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.supervisor.handle(start);
        yield* h.supervisor.handle({
          ...start,
          sessionId: "s2",
          slot: 0,
          udpPort: 59000,
        });
        yield* h.tick("0 seconds");
        const passwords = sessionSpecs(h.fake).map((spec) => spec.env.PASSWD);
        expect(passwords).toHaveLength(2);
        for (const password of passwords) {
          expect(password).toMatch(/^[A-Za-z0-9_-]{32,}$/);
          expect(password).not.toBe("mypasswd");
        }
        expect(passwords[0]).not.toBe(passwords[1]);
        // Пароль не уходит ни в отчёты, ни в снимок.
        const visible = JSON.stringify([
          yield* h.drain,
          yield* h.supervisor.snapshot,
        ]);
        for (const password of passwords)
          expect(visible).not.toContain(password ?? "?");
      }),
    ));

  it("reports StreamReady when selkies answers", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          // Сессия видна с момента приёма команды: в снимке и в heartbeat.
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
          yield* h.tick("10 seconds");
          expect(yield* h.drain).toEqual([]);
          h.fake.state.selkies = true;
          yield* h.tick("2 seconds");
          expect(yield* h.drain).toEqual([
            { _tag: "StreamReady", sessionId: "s1", streamUrl },
          ]);
          yield* h.tick("20 seconds");
          expect(yield* h.drain).toEqual([
            { _tag: "Heartbeat", sessionIds: ["s1"] },
          ]);
        }),
      (fake) => {
        fake.state.selkies = false;
      },
    ));

  it("stream that never gets ready fails after 120 s and removes the container", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("118 seconds");
          expect(
            (yield* h.drain).filter((r) => r._tag !== "Heartbeat"),
          ).toEqual([]);
          yield* h.tick("4 seconds");
          expect(
            (yield* h.drain).filter((r) => r._tag !== "Heartbeat"),
          ).toEqual([
            {
              _tag: "Failed",
              sessionId: "s1",
              reason: failReasons.streamTimeout,
            },
          ]);
          expect(h.fake.state.calls).toContain("remove cg-session-s1");
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => {
        fake.state.selkies = false;
      },
    ));

  it("GPU compositor failure line in the log reports Failed", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("2 seconds");
          h.fake.state.logs = `x\n${GPU_FAILURE_LINE}; compositing in software\n`;
          yield* h.tick("2 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Failed",
              sessionId: "s1",
              reason: "На сервере не работает захват экрана GPU",
            },
          ]);
          expect(h.fake.state.calls).toContain("remove cg-session-s1");
        }),
      (fake) => {
        fake.state.selkies = false;
      },
    ));

  it("reports GameState on pgrep changes only", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        yield* h.tick("5 seconds");
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([]);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([
          { _tag: "GameState", sessionId: "s1", running: true },
        ]);
        yield* h.tick("5 seconds");
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([]);
        expect((yield* h.supervisor.snapshot)[0]?.gameRunning).toBe(true);
      }),
    ));

  it("game exit waits for cloud marker then removes container", () =>
    run((h) =>
      Effect.gen(function* () {
        h.fake.state.cloud = 3;
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        h.fake.state.game = false;
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([
          { _tag: "GameState", sessionId: "s1", running: true },
          {
            _tag: "GameState",
            sessionId: "s1",
            running: false,
            end: "unknown",
          },
        ]);
        yield* h.tick("10 seconds");
        expect(yield* h.drain).toEqual([]);
        expect(h.fake.state.calls).not.toContain("stop cg-session-s1 15");
        h.fake.state.cloud = 4;
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "Stopped",
            sessionId: "s1",
            cloudSynced: true,
            profileSaved: true,
          },
        ]);
        expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual(
          removedWithLayers("s1"),
        );
        expect(yield* h.supervisor.snapshot).toEqual([]);
      }),
    ));

  it("cloud marker timeout still stops with cloudSynced false", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        h.fake.state.game = false;
        yield* h.tick("5 seconds");
        yield* h.drain;
        yield* h.tick("56 seconds");
        expect(h.fake.state.calls).not.toContain("remove cg-session-s1");
        yield* h.tick("6 seconds");
        expect((yield* h.drain).filter((r) => r._tag !== "Heartbeat")).toEqual([
          {
            _tag: "Stopped",
            sessionId: "s1",
            cloudSynced: false,
            profileSaved: true,
          },
        ]);
        expect(h.fake.state.calls).toContain("remove cg-session-s1");
      }),
    ));

  it("stop while playing closes the game, waits for the marker, then stops", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        yield* h.drain;
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect(h.fake.state.calls).toContain(
          "exec cg-session-s1 pkill -TERM -f AppId=1794680( |$)",
        );
        h.fake.state.cloud = 1;
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "Stopped",
            sessionId: "s1",
            cloudSynced: true,
            profileSaved: true,
          },
        ]);
      }),
    ));

  it("stop before the game ever ran stops at once without waiting for the cloud", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "Stopped",
            sessionId: "s1",
            cloudSynced: false,
            profileSaved: true,
          },
        ]);
        expect(h.fake.state.calls).toContain("remove cg-session-s1");
      }),
    ));

  it("docker failure reports Failed", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Failed",
              sessionId: "s1",
              reason: failReasons.dockerStart,
            },
          ]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
          // Контейнер не создан, другого с этим именем нет — слои убираются.
          expect(callsFrom(h.fake, "inspect cg-session-s1")).toEqual([
            "inspect cg-session-s1",
            ...removedWithLayers("s1").slice(2),
          ]);
          expect(h.fake.state.calls).not.toContain("remove cg-session-s1");
        }),
      (fake) => {
        fake.state.failCreate = true;
      },
    ));

  it("failed create never removes an existing container of that name", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Failed",
              sessionId: "s1",
              reason: failReasons.dockerStart,
            },
          ]);
          // Остановленный контейнер с несохранённым профилем и его слои целы.
          const calls = h.fake.state.calls;
          expect(calls).not.toContain("remove cg-session-s1");
          expect(calls).not.toContain("removeVolume cg-s-s1-client");
          expect(calls).not.toContain("create cg-s-s1-cleanup");
        }),
      (fake) => {
        fake.state.failCreate = true;
        fake.state.inspected = {
          "cg-session-s1": {
            name: "cg-session-s1",
            labels: { "cg.session": "s1" },
            running: false,
          },
        };
      },
    ));

  it("container that disappears mid-game reports Failed", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.gone = true;
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "Failed",
            sessionId: "s1",
            reason: failReasons.containerGone,
          },
        ]);
        // Upper-слои с игрой этой сессии не теряются: контейнер и тома остаются.
        expect(h.fake.state.calls).toContain("stop cg-session-s1 15");
        expect(h.fake.state.calls).not.toContain("remove cg-session-s1");
        expect(h.fake.state.calls).not.toContain("removeVolume cg-s-s1-client");
      }),
    ));

  it("start of a known session re-reports state and creates nothing", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        yield* h.drain;
        yield* h.supervisor.handle(start);
        yield* h.tick("0 seconds");
        expect(sessionSpecs(h.fake)).toHaveLength(1);
        expect(yield* h.drain).toEqual([
          { _tag: "StreamReady", sessionId: "s1", streamUrl },
          { _tag: "GameState", sessionId: "s1", running: true },
        ]);
      }),
    ));

  it("stop of an unknown session reports Stopped without cloud sync", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          for (const sessionId of ["nope", "foreign", "ours", "kept"]) {
            yield* h.supervisor.handle({ _tag: "StopSession", sessionId });
            yield* h.tick("0 seconds");
          }
          expect(yield* h.drain).toEqual(
            ["nope", "foreign", "ours", "kept"].map((sessionId) => ({
              _tag: "Stopped",
              sessionId,
              cloudSynced: false,
              profileSaved: false,
            })),
          );
          // Наш контейнер не удаляется никогда: дом в его слоях. Запущенный без
          // меток профиля (сохранить нечем) только останавливается, остановленный
          // не трогается.
          expect(callsFrom(h.fake, "inspect cg-session-nope")).toEqual([
            "inspect cg-session-nope",
            "inspect cg-session-foreign",
            "inspect cg-session-ours",
            "stop cg-session-ours 15",
            "inspect cg-session-kept",
          ]);
        }),
      (fake) => {
        fake.state.inspected = {
          "cg-session-foreign": {
            name: "cg-session-foreign",
            labels: { "com.example": "x" },
            running: true,
          },
          "cg-session-ours": {
            name: "cg-session-ours",
            labels: { "cg.session": "ours" },
            running: true,
          },
          "cg-session-kept": {
            name: "cg-session-kept",
            labels: { "cg.session": "kept" },
            running: false,
          },
        };
      },
    ));

  it("stop of an untracked running session container saves its profile first", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          // Например, docker stop не удался при прошлой остановке: контейнер жив,
          // но агент его уже не ведёт.
          yield* h.supervisor.handle({
            _tag: "StopSession",
            sessionId: "lost",
          });
          yield* h.tick("0 seconds");
          expect(
            callsFrom(
              h.fake,
              "exec cg-session-lost /usr/local/bin/cg-steam-shutdown",
            ),
          ).toEqual([
            "exec cg-session-lost /usr/local/bin/cg-steam-shutdown",
            "getArchive cg-session-lost /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
            "exec cg-session-lost /usr/local/bin/cg-profile-pack",
            "archiveSize cg-session-lost /tmp/cg-profile.tar",
            "getArchive cg-session-lost /tmp/cg-profile.tar",
            "store.put ul",
            "commit profiles/ul/new.cgp",
            ...removedWithLayers("lost").slice(0, 4),
          ]);
          expect(h.fake.state.commits[0]?.baseVersion).toBe(5);
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "lost",
              cloudSynced: false,
              profileSaved: true,
            },
          ]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => {
        fake.state.inspected = {
          "cg-session-lost": {
            name: "cg-session-lost",
            labels: {
              "cg.session": "lost",
              "cg.slot": "0",
              "cg.app": "1794680",
              "cg.user": "ul",
              "cg.base-version": "5",
            },
            running: true,
          },
        };
      },
    ));

  it("invalid StartSession is rejected without touching Docker", () =>
    run((h) =>
      Effect.gen(function* () {
        const before = h.fake.state.dockerCalls;
        const invalid: Array<Partial<typeof start>> = [
          { sessionId: "../../x" },
          { sessionId: "" },
          { sessionId: "a".repeat(65) },
          { userId: "u1:/etc" },
          { userId: "u 1" },
          { slot: 2 }, // slots = 2 → допустимы 0..1
          { slot: -1, udpPort: 58999 },
          { udpPort: 59002 }, // slot 1 → только 59001
        ];
        for (const patch of invalid)
          yield* h.supervisor.handle({ ...start, ...patch });
        yield* h.tick("0 seconds");
        expect(h.fake.state.dockerCalls).toBe(before);
        expect(yield* h.drain).toEqual(
          invalid.map((patch) => ({
            _tag: "Failed",
            sessionId: patch.sessionId ?? "s1",
            reason: failReasons.invalidCommand,
          })),
        );
        expect(yield* h.supervisor.snapshot).toEqual([]);
        // Невалидный StopSession просто игнорируется.
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "a/b" });
        yield* h.tick("0 seconds");
        expect(h.fake.state.dockerCalls).toBe(before);
        expect(yield* h.drain).toEqual([]);
      }),
    ));

  it("stop right while the game start is being recorded still closes the game and waits for the cloud", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        const gate = yield* Deferred.make<void>();
        h.fake.state.cloudGate = gate;
        h.fake.state.game = true;
        // pgrep видит игру, база облака ещё считается (grep ждёт gate) — и тут StopSession.
        yield* h.tick("5 seconds");
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        yield* Deferred.succeed(gate, undefined);
        yield* h.tick("0 seconds");
        expect(h.fake.state.calls).toContain(
          "exec cg-session-s1 pkill -TERM -f AppId=1794680( |$)",
        );
        expect(h.fake.state.calls).not.toContain("remove cg-session-s1");
        h.fake.state.cloud = 1;
        yield* h.tick("2 seconds");
        expect(yield* h.drain).toEqual([
          { _tag: "GameState", sessionId: "s1", running: true },
          {
            _tag: "Stopped",
            sessionId: "s1",
            cloudSynced: true,
            profileSaved: true,
          },
        ]);
      }),
    ));

  it("pgrep exit codes other than 0 and 1 keep the previous game state", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        yield* h.drain;
        for (const code of [2, 3, 126, 127, -1]) {
          h.fake.state.pgrepExit = code;
          yield* h.tick("5 seconds");
        }
        expect((yield* h.drain).filter((r) => r._tag !== "Heartbeat")).toEqual(
          [],
        );
        expect(h.fake.state.calls).not.toContain("stop cg-session-s1 15");
        expect((yield* h.supervisor.snapshot)[0]?.gameRunning).toBe(true);
        h.fake.state.pgrepExit = 1;
        yield* h.tick("5 seconds");
        expect((yield* h.drain).filter((r) => r._tag !== "Heartbeat")).toEqual([
          {
            _tag: "GameState",
            sessionId: "s1",
            running: false,
            end: "unknown",
          },
        ]);
      }),
    ));

  it("game process pattern is anchored after the appId", () => {
    expect(commands.game(10)).toEqual(["pgrep", "-f", "AppId=10( |$)"]);
    expect(commands.closeGame(10)).toEqual([
      "pkill",
      "-TERM",
      "-f",
      "AppId=10( |$)",
    ]);
    // Тот же шаблон в ERE (procps) и в JS RegExp: проверяем на типичных строках.
    const pattern = new RegExp(commands.game(10)[2] ?? "");
    expect(pattern.test("reaper SteamLaunch AppId=10 -- /g/b.exe")).toBe(true);
    expect(pattern.test("steam-launch-wrapper -- x AppId=10")).toBe(true);
    expect(pattern.test("reaper SteamLaunch AppId=105 -- /g/a.exe")).toBe(
      false,
    );
  });

  it("adopts labelled containers on startup", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(h.fake.state.calls).toContain("list cg.session");
          // Остановленный контейнер (несохранённый профиль) агент не удаляет никогда.
          expect(h.fake.state.calls).not.toContain("remove cg-session-old");
          expect(h.fake.state.calls).toContain("remove cg-session-bad");
          expect(h.fake.state.created).toEqual([]);
          expect(yield* h.supervisor.snapshot).toEqual([
            {
              sessionId: "a",
              slot: 1,
              streamUrl: "http://cg-session-a:8080",
              gameRunning: true,
            },
          ]);
          // Подхваченная сессия ведётся как обычная: игра вышла → облако → стоп.
          yield* h.drain;
          h.fake.state.game = false;
          h.fake.state.cloud = 3;
          yield* h.tick("5 seconds");
          yield* h.tick("2 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "GameState",
              sessionId: "a",
              running: false,
              end: "unknown",
            },
            {
              _tag: "Stopped",
              sessionId: "a",
              cloudSynced: true,
              profileSaved: true,
            },
          ]);
          // Пользователь и базовая версия профиля — из меток контейнера.
          expect(h.fake.state.commits).toEqual([
            {
              userId: "ua",
              baseVersion: 3,
              objectKey: "profiles/ua/new.cgp",
              sizeBytes: expect.any(Number),
              steamLoginSeeded: false,
            },
          ]);
          expect(callsFrom(h.fake, "stop cg-session-a 15")).toEqual(
            removedWithLayers("a"),
          );
        }),
      (fake) => {
        // Слои подхваченной сессии создал прошлый запуск агента.
        mkdirSync(join(fake.state.scratch, "a", "client", "upper"), {
          recursive: true,
        });
        fake.state.game = true;
        fake.state.cloud = 2;
        fake.state.existing = [
          {
            name: "cg-session-a",
            labels: {
              "cg.session": "a",
              "cg.slot": "1",
              "cg.app": "1794680",
              "cg.user": "ua",
              "cg.base-version": "3",
            },
            running: true,
          },
          {
            name: "cg-session-old",
            labels: { "cg.session": "old", "cg.slot": "0", "cg.app": "1" },
            running: false,
          },
          {
            // Контейнер MVP-2 (без cg.user) — подхватывать нечего.
            name: "cg-session-bad",
            labels: { "cg.session": "bad", "cg.slot": "0", "cg.app": "1" },
            running: true,
          },
        ];
      },
    ));

  it("cloud upload during play is not taken for the final sync on game exit", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        // Steam выгрузил облако посреди игры (или при запуске) — это не итоговая выгрузка.
        h.fake.state.cloud = 1;
        yield* h.tick("5 seconds");
        h.fake.state.game = false;
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([
          { _tag: "GameState", sessionId: "s1", running: true },
          {
            _tag: "GameState",
            sessionId: "s1",
            running: false,
            end: "unknown",
          },
        ]);
        yield* h.tick("10 seconds");
        expect((yield* h.drain).filter((r) => r._tag !== "Heartbeat")).toEqual(
          [],
        );
        expect(h.fake.state.calls).not.toContain("stop cg-session-s1 15");
        // Итоговая выгрузка после выхода — маркер вырос относительно последнего опроса.
        h.fake.state.cloud = 2;
        yield* h.tick("2 seconds");
        expect((yield* h.drain).filter((r) => r._tag !== "Heartbeat")).toEqual([
          {
            _tag: "Stopped",
            sessionId: "s1",
            cloudSynced: true,
            profileSaved: true,
          },
        ]);
      }),
    ));

  it("stop mid-game takes the cloud baseline right before SIGTERM", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        yield* h.drain;
        // Выгрузка посреди игры, между опросами игры: только база перед SIGTERM её учтёт.
        h.fake.state.cloud = 1;
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect(h.fake.state.calls).toContain(
          "exec cg-session-s1 pkill -TERM -f AppId=1794680( |$)",
        );
        yield* h.tick("58 seconds");
        expect((yield* h.drain).filter((r) => r._tag !== "Heartbeat")).toEqual(
          [],
        );
        yield* h.tick("4 seconds");
        expect((yield* h.drain).filter((r) => r._tag !== "Heartbeat")).toEqual([
          {
            _tag: "Stopped",
            sessionId: "s1",
            cloudSynced: false,
            profileSaved: true,
          },
        ]);
      }),
    ));

  for (const failure of ["exit", "docker"] as const)
    it(`failed cloud count (${failure}) is unknown: full wait, cloudSynced false`, () =>
      run((h) =>
        Effect.gen(function* () {
          h.fake.state.cloud = 5;
          h.fake.state.cloudFail = failure;
          yield* startReady(h);
          h.fake.state.game = true;
          yield* h.tick("5 seconds");
          yield* h.drain;
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          // Подсчёт снова работает, но база неизвестна: 5 старых маркеров — не выгрузка.
          h.fake.state.cloudFail = undefined;
          yield* h.tick("2 seconds");
          yield* h.tick("54 seconds");
          expect(
            (yield* h.drain).filter((r) => r._tag !== "Heartbeat"),
          ).toEqual([]);
          expect(h.fake.state.calls).not.toContain("remove cg-session-s1");
          yield* h.tick("6 seconds");
          expect(
            (yield* h.drain).filter((r) => r._tag !== "Heartbeat"),
          ).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: true,
            },
          ]);
        }),
      ));

  it("start restores profile before container start", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.supervisor.handle({
          ...start,
          profile: { version: 7, objectKey: "profiles/u1/v7.cgp" },
        });
        yield* h.tick("0 seconds");
        expect(callsFrom(h.fake, "createVolume cg-s-s1-client")).toEqual([
          "createVolume cg-s-s1-client",
          "createVolume cg-s-s1-apps",
          "create cg-session-s1",
          ...held("s1"),
          "store.get profiles/u1/v7.cgp",
          "putArchive cg-session-s1 /home/ubuntu",
          "archiveSize cg-session-s1 /usr/local/bin/cg-game-exit",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "start cg-session-s1",
          "remove cg-s-s1-hold",
        ]);
        expect(h.fake.state.put[0]?.tar).toEqual(bytes("profile-v7-tar"));
        // Каталоги слоёв созданы агентом заранее.
        for (const layer of ["client", "apps"])
          for (const dir of ["upper", "work"])
            expect(
              existsSync(join(h.fake.state.scratch, "s1", layer, dir)),
            ).toBe(true);
        expect(h.fake.state.created[0]?.labels["cg.base-version"]).toBe("7");
        expect(yield* h.drain).toEqual([
          { _tag: "StreamReady", sessionId: "s1", streamUrl },
        ]);
      }),
    ));

  it("session seeds the Steam login before start", () =>
    run((h) =>
      Effect.gen(function* () {
        const steamLogin = testSteamLogin();
        yield* h.supervisor.handle({ ...start, steamLogin });
        yield* h.tick("0 seconds");
        // Архивы до старта и сам старт — по одному монтированию volatile-томов,
        // которое держит помощник cg-s-s1-hold.
        expect(callsFrom(h.fake, "create cg-session-s1")).toEqual([
          "create cg-session-s1",
          ...held("s1"),
          "volumeExists cg-home-u1",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/local.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/config.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.steam/registry.vdf",
          "putArchive cg-session-s1 /home/ubuntu",
          "archiveSize cg-session-s1 /usr/local/bin/cg-game-exit",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "start cg-session-s1",
          "remove cg-s-s1-hold",
        ]);
        const seeded = h.fake.state.put.find((p) => p.path === "/home/ubuntu");
        if (seeded === undefined) throw new Error("no login seed archive");
        const local = findTarEntry(seeded.tar, "local.vdf");
        if (local === undefined) throw new Error("no local.vdf in archive");
        expect(new TextDecoder().decode(local)).toContain("ConnectCache");
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect(h.fake.state.commits[0]?.steamLoginSeeded).toBe(true);
      }),
    ));

  it("session commit echoes the putAt of the seed it used", () =>
    run((h) =>
      Effect.gen(function* () {
        const putAt = "2026-10-29T10:00:00.123Z";
        yield* h.supervisor.handle({
          ...start,
          steamLogin: testSteamLogin({ putAt }),
        });
        yield* h.tick("0 seconds");
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect(h.fake.state.commits[0]?.steamLoginSeeded).toBe(true);
        expect(h.fake.state.commits[0]?.steamLoginPutAt).toBe(putAt);
      }),
    ));

  it("session commit has no putAt without a seed or its label", () =>
    run((h) =>
      Effect.gen(function* () {
        // Старый оркестратор: вход без метки.
        yield* h.supervisor.handle({ ...start, steamLogin: testSteamLogin() });
        yield* h.tick("0 seconds");
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        // Без посева.
        yield* h.supervisor.handle({ ...start, sessionId: "s2" });
        yield* h.tick("0 seconds");
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s2" });
        yield* h.tick("0 seconds");
        expect(h.fake.state.commits).toHaveLength(2);
        for (const commit of h.fake.state.commits)
          expect("steamLoginPutAt" in commit).toBe(false);
      }),
    ));

  it("StartSession with steamLoginResetAt clears login before seeding and echoes it", () =>
    run((h) =>
      Effect.gen(function* () {
        const steamLogin = testSteamLogin();
        const steamLoginResetAt = "2026-10-28T10:00:00.000Z";
        yield* h.supervisor.handle({ ...start, steamLogin, steamLoginResetAt });
        yield* h.tick("0 seconds");
        // Восстановление профиля (его в этой сессии нет — пустой дом) →
        // стирание (четыре чтения, дом пуст — запись не нужна) → посев
        // (ещё четыре чтения и запись) → старт.
        expect(callsFrom(h.fake, "create cg-session-s1")).toEqual([
          "create cg-session-s1",
          ...held("s1"),
          "volumeExists cg-home-u1",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/local.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/config.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.steam/registry.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/local.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/config.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.steam/registry.vdf",
          "putArchive cg-session-s1 /home/ubuntu",
          "archiveSize cg-session-s1 /usr/local/bin/cg-game-exit",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "start cg-session-s1",
          "remove cg-s-s1-hold",
        ]);
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect(h.fake.state.commits[0]?.steamLoginResetAt).toBe(
          steamLoginResetAt,
        );
      }),
    ));

  it("StartSession without steamLoginResetAt does not clear and the commit omits it", () =>
    run((h) =>
      Effect.gen(function* () {
        const steamLogin = testSteamLogin();
        yield* h.supervisor.handle({ ...start, steamLogin });
        yield* h.tick("0 seconds");
        // Без steamLoginResetAt — только посев, одно чтение каждого файла.
        expect(callsFrom(h.fake, "create cg-session-s1")).toEqual([
          "create cg-session-s1",
          ...held("s1"),
          "volumeExists cg-home-u1",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/local.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/config.vdf",
          "getArchive cg-session-s1 /home/ubuntu/.steam/registry.vdf",
          "putArchive cg-session-s1 /home/ubuntu",
          "archiveSize cg-session-s1 /usr/local/bin/cg-game-exit",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "start cg-session-s1",
          "remove cg-s-s1-hold",
        ]);
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect("steamLoginResetAt" in (h.fake.state.commits[0] ?? {})).toBe(
          false,
        );
      }),
    ));

  it("session without a Steam login does not touch login files", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.supervisor.handle(start);
        yield* h.tick("0 seconds");
        expect(h.fake.state.put).toEqual([]);
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect(h.fake.state.commits[0]?.steamLoginSeeded).toBe(false);
      }),
    ));

  it("start imports legacy cg-home volume when no profile", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          expect(callsFrom(h.fake, "create cg-session-s1")).toEqual([
            "create cg-session-s1",
            ...held("s1"),
            "volumeExists cg-home-u1",
            "remove cg-session-s1-import",
            "create cg-session-s1-import",
            "start cg-session-s1-import",
            "wait cg-session-s1-import",
            "archiveSize cg-session-s1-import /tmp/cg-profile.tar",
            "getArchive cg-session-s1-import /tmp/cg-profile.tar",
            "remove cg-session-s1-import",
            "putArchive cg-session-s1 /home/ubuntu",
            "archiveSize cg-session-s1 /usr/local/bin/cg-game-exit",
            "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
            "start cg-session-s1",
            "remove cg-s-s1-hold",
          ]);
          expect(
            h.fake.state.created.find(
              (spec) => spec.name === "cg-session-s1-import",
            ),
          ).toEqual({
            name: "cg-session-s1-import",
            image: "cg-session:550.163.01",
            env: { HOME: "/home/ubuntu" },
            labels: { "cg.helper": "import" },
            network: "none",
            udpPorts: [],
            binds: [],
            // Старый том только читается.
            mounts: [
              { volume: "cg-home-u1", target: "/home/ubuntu", readOnly: true },
            ],
            runtime: "runc",
            gpus: false,
            shmSizeBytes: 64 * 1024 * 1024,
            securityOpt: ["no-new-privileges:true"],
            tmpfs: {},
            user: "1000",
            entrypoint: ["/usr/local/bin/cg-profile-pack"],
          });
          // В контейнер сессии — содержимое tar из помощника.
          expect(h.fake.state.put).toEqual([
            {
              container: "cg-session-s1",
              path: "/home/ubuntu",
              tar: bytes("legacy-home-tar"),
            },
          ]);
          expect(h.fake.state.calls).not.toContain("removeVolume cg-home-u1");
        }),
      (fake) => {
        fake.state.volumes = ["cg-home-u1"];
      },
    ));

  it("first login starts with an empty home", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        expect(callsFrom(h.fake, "create cg-session-s1")).toEqual([
          "create cg-session-s1",
          ...held("s1"),
          "volumeExists cg-home-u1",
          "archiveSize cg-session-s1 /usr/local/bin/cg-game-exit",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "start cg-session-s1",
          "remove cg-s-s1-hold",
        ]);
        expect(h.fake.state.put).toEqual([]);
      }),
    ));

  it("profile that cannot be restored fails the session before start", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.supervisor.handle({
          ...start,
          profile: { version: 2, objectKey: "profiles/u1/missing.cgp" },
        });
        yield* h.tick("0 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "Failed",
            sessionId: "s1",
            reason: failReasons.profileRestore,
          },
        ]);
        expect(h.fake.state.calls).not.toContain("start cg-session-s1");
        // Помощник отпустил тома до удаления контейнера и слоёв.
        expect(callsFrom(h.fake, "create cg-s-s1-hold")).toEqual([
          ...held("s1").slice(1),
          "store.get profiles/u1/missing.cgp",
          "remove cg-s-s1-hold",
          ...removedWithLayers("s1").slice(1),
        ]);
      }),
    ));

  it("stop saves profile then removes container and layers", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.supervisor.handle({
          ...start,
          profile: { version: 7, objectKey: "profiles/u1/v7.cgp" },
        });
        yield* h.tick("0 seconds");
        yield* h.drain;
        yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
        yield* h.tick("0 seconds");
        expect(
          callsFrom(
            h.fake,
            "exec cg-session-s1 /usr/local/bin/cg-steam-shutdown",
          ),
        ).toEqual([
          "exec cg-session-s1 /usr/local/bin/cg-steam-shutdown",
          "getArchive cg-session-s1 /home/ubuntu/.local/share/Steam/config/loginusers.vdf",
          "exec cg-session-s1 /usr/local/bin/cg-profile-pack",
          "archiveSize cg-session-s1 /tmp/cg-profile.tar",
          "getArchive cg-session-s1 /tmp/cg-profile.tar",
          "store.put u1",
          "commit profiles/u1/new.cgp",
          ...removedWithLayers("s1"),
        ]);
        expect(h.fake.state.uploaded).toEqual([
          { userId: "u1", tar: bytes("session-home-tar") },
        ]);
        expect(h.fake.state.commits).toEqual([
          {
            userId: "u1",
            baseVersion: 7,
            objectKey: "profiles/u1/new.cgp",
            sizeBytes: bytes("session-home-tar").length + 32,
            steamLoginSeeded: false,
          },
        ]);
        expect(yield* h.drain).toEqual([
          {
            _tag: "Stopped",
            sessionId: "s1",
            cloudSynced: false,
            profileSaved: true,
          },
        ]);
      }),
    ));

  it("session that had a prefix asks for a template after its container is removed", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          // Proton создал префикс игры в upper слоя apps сессии.
          mkdirSync(
            join(
              h.fake.state.scratch,
              "s1",
              "apps",
              "upper",
              "compatdata",
              "1794680",
            ),
            { recursive: true },
          );
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual([
            ...removedWithLayers("s1"),
            "templates.ensure 1794680",
          ]);
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: true,
            },
          ]);
        }),
      () => {},
      { templates: true },
    ));

  it("session without a prefix in its upper does not ask for a template", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual(
            removedWithLayers("s1"),
          );
          expect(h.fake.state.calls).not.toContain("templates.ensure 1794680");
        }),
      () => {},
      { templates: true },
    ));

  it("profile-unsaved session does not ask for a template", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          mkdirSync(
            join(
              h.fake.state.scratch,
              "s1",
              "apps",
              "upper",
              "compatdata",
              "1794680",
            ),
            { recursive: true },
          );
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual([
            "stop cg-session-s1 15",
            ...unmarked("s1"),
          ]);
          expect(h.fake.state.calls).not.toContain("templates.ensure 1794680");
        }),
      (fake) => {
        fake.state.commit = "reject";
      },
      { templates: true },
    ));

  it("rejected commit deletes uploaded object and keeps the container like profile-unsaved", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          // Профиля не было: база null.
          expect(h.fake.state.commits[0]?.baseVersion).toBeNull();
          // Объект удалён, контейнер только остановлен: его дом — единственная
          // копия прогресса этой сессии.
          expect(callsFrom(h.fake, "commit profiles/u1/new.cgp")).toEqual([
            "commit profiles/u1/new.cgp",
            "store.remove profiles/u1/new.cgp",
            "stop cg-session-s1 15",
            ...unmarked("s1"),
          ]);
          const calls = h.fake.state.calls;
          expect(calls).not.toContain("remove cg-session-s1");
          expect(calls).not.toContain("removeVolume cg-s-s1-client");
          expect(existsSync(join(h.fake.state.scratch, "s1"))).toBe(true);
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: false,
            },
          ]);
        }),
      (fake) => {
        fake.state.commit = "reject";
      },
    ));

  for (const failure of ["upload", "pack", "commit"] as const)
    it(`profile ${failure} failure keeps container`, () =>
      run(
        (h) =>
          Effect.gen(function* () {
            yield* startReady(h);
            yield* h.supervisor.handle({
              _tag: "StopSession",
              sessionId: "s1",
            });
            yield* h.tick("0 seconds");
            const calls = h.fake.state.calls;
            // Слои остаются, но с них снята метка volatile: `docker start` по
            // README смонтирует их снова.
            expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual([
              "stop cg-session-s1 15",
              ...unmarked("s1"),
            ]);
            expect(calls).not.toContain("remove cg-session-s1");
            expect(calls).not.toContain("removeVolume cg-s-s1-client");
            expect(calls).not.toContain("removeVolume cg-s-s1-apps");
            expect(calls).not.toContain("create cg-s-s1-cleanup");
            expect(existsSync(join(h.fake.state.scratch, "s1"))).toBe(true);
            expect(yield* h.drain).toEqual([
              {
                _tag: "Stopped",
                sessionId: "s1",
                cloudSynced: false,
                profileSaved: false,
              },
            ]);
            expect(yield* h.supervisor.snapshot).toEqual([]);
          }),
        (fake) => {
          if (failure === "upload") fake.state.putFail = true;
          if (failure === "pack") fake.state.packExit = 2;
          if (failure === "commit") fake.state.commit = "fail";
        },
      ));

  it("profile archive over 200 MiB is not loaded: container kept, profileSaved false", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          const calls = h.fake.state.calls;
          expect(
            callsFrom(
              h.fake,
              "exec cg-session-s1 /usr/local/bin/cg-profile-pack",
            ),
          ).toEqual([
            "exec cg-session-s1 /usr/local/bin/cg-profile-pack",
            "archiveSize cg-session-s1 /tmp/cg-profile.tar",
            "stop cg-session-s1 15",
            ...unmarked("s1"),
          ]);
          expect(calls).not.toContain(
            "getArchive cg-session-s1 /tmp/cg-profile.tar",
          );
          expect(calls).not.toContain("store.put u1");
          expect(calls).not.toContain("remove cg-session-s1");
          expect(existsSync(join(h.fake.state.scratch, "s1"))).toBe(true);
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: false,
            },
          ]);
        }),
      (fake) => {
        fake.state.packedSize = PROFILE_MAX_BYTES + 1;
      },
    ));

  it("failure after stream ready unmarks kept layers", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.gone = true;
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([
          {
            _tag: "Failed",
            sessionId: "s1",
            reason: failReasons.containerGone,
          },
        ]);
        expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual([
          "stop cg-session-s1 15",
          ...unmarked("s1"),
        ]);
        expect(h.fake.state.calls).not.toContain("remove cg-session-s1");
        const helper = h.fake.state.created.find(
          (spec) => spec.name === "cg-s-s1-unmark",
        );
        expect(helper?.user).toBe("0");
        expect(helper?.entrypoint?.slice(-2)).toEqual([
          join(h.fake.state.scratch, "s1/client/work/work/incompat"),
          join(h.fake.state.scratch, "s1/apps/work/work/incompat"),
        ]);
      }),
    ));

  it("failed unmark keeps the container and still reports Stopped", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: false,
            },
          ]);
          expect(h.fake.state.calls).toContain("wait cg-s-s1-unmark");
          expect(h.fake.state.calls).not.toContain("remove cg-session-s1");
          expect(h.fake.state.logged.join("\n")).toContain(
            "Unmarking kept session layers failed",
          );
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => {
        fake.state.putFail = true;
        fake.state.helperExit["cg-s-s1-unmark"] = 1;
      },
    ));

  it("startup unmarks stopped session containers", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          // Агент мог упасть между остановкой и снятием метки.
          expect(
            callsFrom(h.fake, "remove cg-s-old-unmark").slice(0, 5),
          ).toEqual(unmarked("old"));
          const calls = h.fake.state.calls;
          expect(calls).not.toContain("remove cg-session-old");
          expect(calls).not.toContain("start cg-session-old");
          expect(calls).not.toContain("removeVolume cg-s-old-client");
          expect(existsSync(join(h.fake.state.scratch, "old"))).toBe(true);
        }),
      (fake) => {
        mkdirSync(join(fake.state.scratch, "old", "client", "work"), {
          recursive: true,
        });
        fake.state.existing = [
          {
            name: "cg-session-old",
            labels: { "cg.session": "old" },
            running: false,
          },
        ];
      },
    ));

  it("startup removes leftover helpers before unmarking stopped sessions", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          // Агент упал посреди старта: тома ещё держит помощник hold. Метку
          // снимать можно только с размонтированных томов.
          const calls = h.fake.state.calls;
          expect(calls).toContain("remove cg-s-old-hold");
          expect(calls.indexOf("remove cg-s-old-hold")).toBeLessThan(
            calls.indexOf("create cg-s-old-unmark"),
          );
        }),
      (fake) => {
        mkdirSync(join(fake.state.scratch, "old", "client", "work"), {
          recursive: true,
        });
        fake.state.existing = [
          {
            name: "cg-session-old",
            labels: { "cg.session": "old" },
            running: false,
          },
        ];
        fake.state.helpers = [
          {
            name: "cg-s-old-hold",
            labels: { "cg.helper": "hold" },
            running: true,
          },
        ];
      },
    ));

  it("StopSession for an unknown container without profile labels unmarks after stop", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "x" });
          yield* h.tick("0 seconds");
          expect(callsFrom(h.fake, "stop cg-session-x 15")).toEqual([
            "stop cg-session-x 15",
            ...unmarked("x"),
          ]);
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "x",
              cloudSynced: false,
              profileSaved: false,
            },
          ]);
        }),
      (fake) => {
        mkdirSync(join(fake.state.scratch, "x", "apps", "work"), {
          recursive: true,
        });
        fake.state.inspected = {
          "cg-session-x": {
            name: "cg-session-x",
            labels: { "cg.session": "x" },
            running: true,
          },
        };
      },
    ));

  it("profile archive of exactly 200 MiB is still saved", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(h.fake.state.calls).toContain("store.put u1");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: true,
            },
          ]);
        }),
      (fake) => {
        fake.state.packedSize = PROFILE_MAX_BYTES;
      },
    ));

  it("saveProfile names the archive size when it is over the limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fake = makeFake();
        fake.state.packedSize = 300 * 1024 * 1024;
        const error = yield* Effect.flip(
          saveProfile({
            container: "cg-session-s1",
            userId: "u1",
            baseVersion: 7,
            steamLoginSeeded: false,
          }).pipe(
            Effect.provideService(DockerClient, fake.docker),
            Effect.provideService(ProfileStore, fake.store),
            Effect.provideService(ProfileCommitter, fake.committer),
          ),
        );
        expect(error.stage).toBe("size");
        expect(error.message).toContain("314572800 bytes");
        expect(error.message).toContain("300 MiB");
        expect(error.message).toContain("limit 200 MiB");
      }).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
    ));

  it("legacy cg-home over 200 MiB fails the start with a clear reason", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Failed",
              sessionId: "s1",
              reason: failReasons.profileTooLarge,
            },
          ]);
          expect(failReasons.profileTooLarge).toBe(
            "Профиль пользователя слишком большой (больше 200 МиБ)",
          );
          const calls = h.fake.state.calls;
          expect(calls).toContain(
            "archiveSize cg-session-s1-import /tmp/cg-profile.tar",
          );
          expect(calls).not.toContain(
            "getArchive cg-session-s1-import /tmp/cg-profile.tar",
          );
          expect(calls).not.toContain("start cg-session-s1");
          // Помощник импорта убран, старый том не тронут.
          expect(calls.at(-1)).not.toBe("start cg-session-s1-import");
          expect(calls).not.toContain("removeVolume cg-home-u1");
        }),
      (fake) => {
        fake.state.volumes = ["cg-home-u1"];
        fake.state.legacySize = PROFILE_MAX_BYTES + 1;
      },
    ));

  it("agent start removes orphan cg-s volumes and scratch", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const calls = h.fake.state.calls;
          // Тома и scratch без контейнера — убраны.
          for (const id of ["gone", "gone2"])
            expect(calls).toContain(`removeVolume cg-s-${id}-client`);
          expect(calls).toContain("create cg-s-gone2-cleanup");
          expect(h.fake.state.created).toContainEqual(
            expect.objectContaining({
              name: "cg-s-gone2-cleanup",
              entrypoint: ["rm", "-rf", join(h.fake.state.scratch, "gone2")],
            }),
          );
          // У остановленного контейнера слои его — не трогаются, сам он тоже.
          expect(calls).not.toContain("removeVolume cg-s-kept-client");
          expect(calls).not.toContain("create cg-s-kept-cleanup");
          expect(calls).not.toContain("remove cg-session-kept");
          // Посторонние каталоги в scratch не трогаются.
          expect(calls).not.toContain("removeVolume cg-s-not an id-client");
          // Слой клиента установщика (`<SCRATCH_DIR>/.install/<jobId>`) — не
          // сессия: его убирает только Installer.
          expect(calls.filter((call) => call.includes(".install"))).toEqual([]);
          expect(calls.filter((call) => call.includes("cg-s-j1"))).toEqual([]);
          expect(
            h.fake.state.created.filter((spec) =>
              spec.entrypoint?.some((arg) => arg.includes(".install")),
            ),
          ).toEqual([]);
          expect(
            existsSync(
              join(h.fake.state.scratch, ".install", "j1", "client", "upper"),
            ),
          ).toBe(true);
          // Забытые помощники убраны.
          expect(calls).toContain("remove cg-session-x-import");
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => {
        const scratch = fake.state.scratch;
        mkdirSync(join(scratch, "gone2", "client", "work"), {
          recursive: true,
        });
        mkdirSync(join(scratch, "kept", "apps", "upper"), { recursive: true });
        mkdirSync(join(scratch, "not an id"), { recursive: true });
        mkdirSync(join(scratch, ".install", "j1", "client", "upper"), {
          recursive: true,
        });
        fake.state.labelledVolumes = [
          { name: "cg-s-gone-client", labels: { "cg.session": "gone" } },
          { name: "cg-s-gone-apps", labels: { "cg.session": "gone" } },
          { name: "cg-s-kept-client", labels: { "cg.session": "kept" } },
        ];
        fake.state.existing = [
          {
            name: "cg-session-kept",
            labels: { "cg.session": "kept", "cg.slot": "0", "cg.app": "1" },
            running: false,
          },
        ];
        fake.state.helpers = [
          {
            name: "cg-session-x-import",
            labels: { "cg.helper": "import" },
            running: false,
          },
        ];
      },
    ));
});

/** Этапы `SessionStage` из отчётов (остальные отбрасываются). */
const stagesOf = (reports: ReadonlyArray<AgentReport>) =>
  reports.flatMap((report) =>
    report._tag === "SessionStage" ? [[report.sessionId, report.stage]] : [],
  );

describe("SessionSupervisor stages", () => {
  it("start reports computer, then steam after the container starts", () =>
    run((h) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        h.fake.state.startGate = gate;
        yield* h.supervisor.handle(start);
        yield* h.tick("0 seconds");
        // docker start ещё не вернулся: только `computer`, опроса нет.
        expect(h.fake.state.calls).toContain("start cg-session-s1");
        expect(yield* h.drainAll).toEqual([
          { _tag: "SessionStage", sessionId: "s1", stage: "computer" },
        ]);
        expect(h.fake.state.stageChecks).toBe(0);
        yield* Deferred.succeed(gate, undefined);
        yield* h.tick("0 seconds");
        expect(yield* h.drainAll).toEqual([
          { _tag: "SessionStage", sessionId: "s1", stage: "steam" },
          { _tag: "StreamReady", sessionId: "s1", streamUrl },
        ]);
      }),
    ));

  it("computer is reported before the container is created", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          expect(yield* h.drainAll).toEqual([
            { _tag: "SessionStage", sessionId: "s1", stage: "computer" },
            {
              _tag: "Failed",
              sessionId: "s1",
              reason: failReasons.dockerStart,
            },
          ]);
        }),
      (fake) => {
        fake.state.failCreate = true;
      },
    ));

  it("stage polling reports each new stage once and stops at visible", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          for (let i = 0; i < 5; i++) yield* h.tick("2 seconds");
          expect(stagesOf(yield* h.drainAll)).toEqual([
            ["s1", "computer"],
            ["s1", "steam"],
            ["s1", "login"],
            ["s1", "prepare"],
            ["s1", "loading"],
            ["s1", "visible"],
          ]);
          expect(h.fake.state.stageChecks).toBe(6);
          // После `visible` скрипт больше не вызывается.
          yield* h.tick("10 seconds");
          expect(h.fake.state.stageChecks).toBe(6);
          expect(stagesOf(yield* h.drainAll)).toEqual([]);
        }),
      (fake) => {
        fake.state.stages = [
          "steam",
          "login",
          "login",
          "prepare",
          "loading",
          "visible",
        ];
      },
    ));

  it("stage polling slows down while the stage stays the same", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          const checksOver = (seconds: number) =>
            Effect.gen(function* () {
              const before = h.fake.state.stageChecks;
              for (let i = 0; i < seconds; i++) yield* h.tick("1 second");
              return h.fake.state.stageChecks - before;
            });
          // Первые 3 минуты на одном этапе — каждые 2 с.
          expect(yield* checksOver(60)).toBe(30);
          yield* checksOver(120);
          // Дольше — каждые 10 с: окно игры так и не нашлось, скрипт дорогой.
          expect(yield* checksOver(60)).toBe(6);
          // Новый этап — снова часто.
          h.fake.state.lastStage = "loading";
          yield* checksOver(10);
          expect(stagesOf(yield* h.drainAll).at(-1)).toEqual(["s1", "loading"]);
          expect(yield* checksOver(20)).toBe(10);
        }),
      (fake) => {
        fake.state.lastStage = "prepare";
      },
    ));

  it("stage never goes back", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          yield* h.tick("2 seconds");
          yield* h.tick("2 seconds");
          yield* h.tick("2 seconds");
          expect(stagesOf(yield* h.drainAll)).toEqual([
            ["s1", "computer"],
            ["s1", "steam"],
            ["s1", "prepare"],
            ["s1", "loading"],
          ]);
        }),
      (fake) => {
        fake.state.stages = ["prepare", "login", "loading"];
      },
    ));

  it("stage check failure keeps polling", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          for (let i = 0; i < 4; i++) yield* h.tick("2 seconds");
          const reports = yield* h.drainAll;
          expect(stagesOf(reports)).toEqual([
            ["s1", "computer"],
            ["s1", "steam"],
            ["s1", "login"],
            ["s1", "prepare"],
          ]);
          expect(reports.map((report) => report._tag)).not.toContain("Failed");
          expect(h.fake.state.stageChecks).toBe(5);
          const warnings = h.fake.state.logged.filter((line) =>
            line.includes("Stage check failed"),
          );
          // Упавший exec, ненулевой код выхода, неизвестный этап.
          expect(warnings).toHaveLength(3);
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
        }),
      (fake) => {
        fake.state.stages = [
          "login",
          new DockerError({ operation: "exec", message: "timeout" }),
          { exitCode: 1 },
          "computer",
          "prepare",
        ];
      },
    ));

  it("gone container stops stage polling without failing the session", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          yield* h.tick("10 seconds");
          // Решать, что контейнера нет, — проверкам Selkies и игры, не опросу этапов.
          expect(h.fake.state.stageChecks).toBe(1);
          expect(
            (yield* h.drainAll).map((report) => report._tag),
          ).not.toContain("Failed");
          expect(
            h.fake.state.logged.filter((line) =>
              line.includes("Stage check failed"),
            ),
          ).toEqual([]);
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
        }),
      (fake) => {
        fake.state.stages = [
          new DockerError({
            operation: "exec",
            status: 409,
            message: "container is not running",
          }),
        ];
      },
    ));

  it("missing stage script stops polling after one warning", async () => {
    // 127 — скрипта нет (старый образ), 126 — он не исполняемый.
    for (const exitCode of [127, 126])
      await run(
        (h) =>
          Effect.gen(function* () {
            yield* h.supervisor.handle(start);
            yield* h.tick("0 seconds");
            for (let i = 0; i < 5; i++) yield* h.tick("2 seconds");
            expect(h.fake.state.stageChecks).toBe(1);
            const warnings = h.fake.state.logged.filter((line) =>
              line.includes("Stage"),
            );
            expect(warnings).toHaveLength(1);
            expect(stagesOf(yield* h.drainAll)).toEqual([
              ["s1", "computer"],
              ["s1", "steam"],
            ]);
            expect(
              (yield* h.supervisor.snapshot).map((s) => s.sessionId),
            ).toEqual(["s1"]);
          }),
        (fake) => {
          fake.state.stages = [{ exitCode }];
        },
      );
  });

  it("game start reports prepare before GameState", () =>
    run((h) =>
      Effect.gen(function* () {
        // Скрипт этапов застрял на `steam` (например, старый образ).
        yield* h.supervisor.handle(start);
        yield* h.tick("0 seconds");
        expect(stagesOf(yield* h.drainAll)).toEqual([
          ["s1", "computer"],
          ["s1", "steam"],
        ]);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        expect(yield* h.drainAll).toEqual([
          { _tag: "SessionStage", sessionId: "s1", stage: "prepare" },
          { _tag: "GameState", sessionId: "s1", running: true },
        ]);
      }),
    ));

  it("game start does not repeat prepare or step back from a later stage", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          yield* h.tick("2 seconds");
          expect(stagesOf(yield* h.drainAll)).toEqual([
            ["s1", "computer"],
            ["s1", "steam"],
            ["s1", "loading"],
          ]);
          h.fake.state.game = true;
          yield* h.tick("5 seconds");
          expect(yield* h.drainAll).toEqual([
            { _tag: "GameState", sessionId: "s1", running: true },
          ]);
        }),
      (fake) => {
        fake.state.stages = ["steam", "loading"];
      },
    ));

  it("adopted session resumes stage polling", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(stagesOf(yield* h.drainAll)).toEqual([["a", "loading"]]);
          yield* h.tick("2 seconds");
          expect(stagesOf(yield* h.drainAll)).toEqual([["a", "visible"]]);
          yield* h.tick("10 seconds");
          expect(h.fake.state.stageChecks).toBe(2);
        }),
      (fake) => {
        fake.state.game = true;
        fake.state.stages = ["loading", "visible"];
        fake.state.existing = [
          {
            name: "cg-session-a",
            labels: {
              "cg.session": "a",
              "cg.slot": "1",
              "cg.app": "1794680",
              "cg.user": "ua",
              "cg.base-version": "3",
            },
            running: true,
          },
        ];
      },
    ));

  it("no stage reports after Stopped", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("2 seconds");
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          const reports = yield* h.drainAll;
          expect(reports.at(-1)?._tag).toBe("Stopped");
          expect(stagesOf(reports)).toEqual([
            ["s1", "computer"],
            ["s1", "steam"],
            ["s1", "login"],
          ]);
          const checks = h.fake.state.stageChecks;
          h.fake.state.stages = ["prepare", "visible"];
          yield* h.tick("10 seconds");
          expect(h.fake.state.stageChecks).toBe(checks);
          expect(stagesOf(yield* h.drainAll)).toEqual([]);
        }),
      (fake) => {
        fake.state.stages = ["steam", "login"];
      },
    ));

  it("stage command does not match the game process pattern", () => {
    expect(commands.stage(1794680)).toEqual([
      "/usr/local/bin/cg-session-stage",
      "1794680",
    ]);
    const pattern = new RegExp(commands.game(1794680)[2] ?? "");
    expect(pattern.test(commands.stage(1794680).join(" "))).toBe(false);
  });
});

/** Отчёты без `Heartbeat`. */
const withoutHeartbeats = (reports: ReadonlyArray<AgentReport>) =>
  reports.filter((report) => report._tag !== "Heartbeat");

/** Остановленный или запущенный контейнер `s9` прошлого запуска агента с меткой `profile-saved`. */
const savedProfileContainer = (fake: Fake, running: boolean) => {
  mkdirSync(join(fake.state.scratch, "s9", "client", "upper"), {
    recursive: true,
  });
  writeFileSync(join(fake.state.scratch, "s9", "profile-saved"), "");
  fake.state.existing = [
    {
      name: "cg-session-s9",
      labels: {
        "cg.session": "s9",
        "cg.user": "u1",
        "cg.base-version": "7",
        "cg.slot": "1",
        "cg.app": "1794680",
      },
      running,
    },
  ];
};

describe("stuck container", () => {
  it("hung stop after a saved profile: Stopped with cleanupPending, kill and remove retried every 30 s", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle({
            ...start,
            profile: { version: 7, objectKey: "profiles/u1/v7.cgp" },
          });
          yield* h.tick("0 seconds");
          yield* h.drain;
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: true,
              cleanupPending: true,
            },
          ]);
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
          expect(
            existsSync(join(h.fake.state.scratch, "s1", "profile-saved")),
          ).toBe(true);
          // Слот держится: heartbeat называет сессию.
          yield* h.tick("30 seconds");
          expect(yield* h.drain).toEqual([
            { _tag: "Heartbeat", sessionIds: ["s1"] },
          ]);
          yield* h.tick("30 seconds");
          expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual([
            "stop cg-session-s1 15",
            "remove cg-session-s1",
            "remove cg-session-s1",
            ...removedWithLayers("s1").slice(1),
          ]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
          expect(withoutHeartbeats(yield* h.drain)).toEqual([]);
          yield* h.tick("30 seconds");
          expect(yield* h.drain).toEqual([
            { _tag: "Heartbeat", sessionIds: [] },
          ]);
        }),
      (fake) => {
        fake.state.stopFails = 1;
        fake.state.removeFails = 2;
      },
    ));

  it("layer cleanup failure keeps the session until the layers are gone", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: true,
              cleanupPending: true,
            },
          ]);
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
          yield* h.tick("30 seconds");
          expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual([
            "stop cg-session-s1 15",
            "remove cg-session-s1",
            "removeVolume cg-s-s1-client",
            ...removedWithLayers("s1").slice(1),
          ]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
          expect(withoutHeartbeats(yield* h.drain)).toEqual([]);
        }),
      (fake) => {
        fake.state.removeVolumeFails = 1;
      },
    ));

  it("stuck container is given up after 60 minutes but keeps the slot and is retried every 5 minutes", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: true,
              cleanupPending: true,
            },
          ]);
          yield* h.tick("59 minutes");
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
          expect(h.fake.state.logged.join("\n")).not.toContain(
            "session-container-stuck",
          );
          yield* h.tick("1 minute");
          // Сдались: лог, но слот держится — сессия в snapshot и heartbeat.
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
          expect(h.fake.state.logged.join("\n")).toContain(
            "session-container-stuck",
          );
          expect(h.fake.state.logged.join("\n")).toContain(
            "Session container cleanup failed, retrying",
          );
          // Слои занятого контейнера не трогаются.
          expect(h.fake.state.calls).not.toContain(
            "removeVolume cg-s-s1-client",
          );
          expect(withoutHeartbeats(yield* h.drain)).toEqual([]);
          const removes = () =>
            h.fake.state.calls.filter((call) => call === "remove cg-session-s1")
              .length;
          const before = removes();
          // Дальше попытки раз в 5 минут.
          yield* h.tick("4 minutes");
          expect(removes()).toBe(before);
          yield* h.tick("1 minute");
          expect(removes()).toBe(before + 1);
          yield* h.tick("5 minutes");
          expect(removes()).toBe(before + 2);
          expect(
            h.fake.state.logged.filter((line) =>
              line.includes("session-container-stuck"),
            ),
          ).toHaveLength(1);
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
          expect(yield* h.drain).toContainEqual({
            _tag: "Heartbeat",
            sessionIds: ["s1"],
          });
          // Контейнер наконец убрался — сессия уходит, слот выпускается.
          h.fake.state.removeFails = 0;
          yield* h.tick("5 minutes");
          expect(removes()).toBe(before + 3);
          expect(h.fake.state.calls).toContain("removeVolume cg-s-s1-client");
          expect(yield* h.supervisor.snapshot).toEqual([]);
          expect(withoutHeartbeats(yield* h.drain)).toEqual([]);
          yield* h.tick("30 seconds");
          expect(yield* h.drain).toEqual([
            { _tag: "Heartbeat", sessionIds: [] },
          ]);
        }),
      (fake) => {
        fake.state.removeFails = Number.POSITIVE_INFINITY;
      },
    ));

  it("profile-unsaved session with a hung stop retries stop only and never removes", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: false,
              profileSaved: false,
              cleanupPending: true,
            },
          ]);
          expect(
            existsSync(join(h.fake.state.scratch, "s1", "profile-saved")),
          ).toBe(false);
          yield* h.tick("60 seconds");
          expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual([
            "stop cg-session-s1 15",
            "stop cg-session-s1 15",
            "stop cg-session-s1 15",
            ...unmarked("s1"),
          ]);
          expect(h.fake.state.calls).not.toContain("remove cg-session-s1");
          expect(yield* h.supervisor.snapshot).toEqual([]);
          expect(withoutHeartbeats(yield* h.drain)).toEqual([]);
        }),
      (fake) => {
        fake.state.putFail = true;
        fake.state.stopFails = 2;
      },
    ));

  it("failed session whose container cannot be removed reports Failed with cleanupPending", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("118 seconds");
          expect(withoutHeartbeats(yield* h.drain)).toEqual([]);
          yield* h.tick("4 seconds");
          expect(withoutHeartbeats(yield* h.drain)).toEqual([
            {
              _tag: "Failed",
              sessionId: "s1",
              reason: failReasons.streamTimeout,
              cleanupPending: true,
            },
          ]);
          expect(
            (yield* h.supervisor.snapshot).map((s) => s.sessionId),
          ).toEqual(["s1"]);
          yield* h.tick("30 seconds");
          expect(callsFrom(h.fake, "remove cg-session-s1")).toEqual([
            "remove cg-session-s1",
            ...removedWithLayers("s1").slice(1),
          ]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
          expect(withoutHeartbeats(yield* h.drain)).toEqual([]);
        }),
      (fake) => {
        fake.state.selkies = false;
        fake.state.removeFails = 1;
      },
    ));

  it("prefix template is checked only after a retried remove succeeds", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          mkdirSync(
            join(
              h.fake.state.scratch,
              "s1",
              "apps",
              "upper",
              "compatdata",
              "1794680",
            ),
            { recursive: true },
          );
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(h.fake.state.calls).not.toContain("templates.ensure 1794680");
          yield* h.tick("30 seconds");
          expect(callsFrom(h.fake, "stop cg-session-s1 15")).toEqual([
            "stop cg-session-s1 15",
            "remove cg-session-s1",
            ...removedWithLayers("s1").slice(1),
            "templates.ensure 1794680",
          ]);
        }),
      (fake) => {
        fake.state.removeFails = 1;
      },
      { templates: true },
    ));

  it("agent start removes a stopped session container whose profile was saved", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          // Профиль уже сохранён: контейнер не останавливается, а удаляется сразу.
          expect(callsFrom(h.fake, "remove cg-session-s9")).toEqual(
            removedWithLayers("s9").slice(1),
          );
          expect(h.fake.state.calls).not.toContain("stop cg-session-s9 15");
          expect(h.fake.state.calls).not.toContain("create cg-s-s9-unmark");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s9",
              cloudSynced: false,
              profileSaved: true,
            },
          ]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => savedProfileContainer(fake, false),
    ));

  it("agent start removes a running session container whose profile was saved", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          expect(callsFrom(h.fake, "remove cg-session-s9")).toEqual(
            removedWithLayers("s9").slice(1),
          );
          // Профиль второй раз не снимается.
          expect(h.fake.state.calls).not.toContain(
            "exec cg-session-s9 /usr/local/bin/cg-profile-pack",
          );
          expect(h.fake.state.commits).toEqual([]);
          expect(h.fake.state.calls).not.toContain("create cg-s-s9-unmark");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s9",
              cloudSynced: false,
              profileSaved: true,
            },
          ]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => savedProfileContainer(fake, true),
    ));

  it("stop of an unknown session whose profile was saved removes it without packing again", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s9" });
          yield* h.tick("0 seconds");
          expect(callsFrom(h.fake, "remove cg-session-s9")).toEqual(
            removedWithLayers("s9").slice(1),
          );
          expect(h.fake.state.calls).not.toContain(
            "exec cg-session-s9 /usr/local/bin/cg-profile-pack",
          );
          expect(h.fake.state.calls).not.toContain("stop cg-session-s9 15");
          expect(h.fake.state.commits).toEqual([]);
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s9",
              cloudSynced: false,
              profileSaved: true,
            },
          ]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => {
        // Не в списке при старте (adopt его не видит) — только `inspect` по имени.
        savedProfileContainer(fake, true);
        const [container] = fake.state.existing;
        fake.state.existing = [];
        if (container !== undefined)
          fake.state.inspected["cg-session-s9"] = container;
      },
    ));

  it("two close stops of an unknown session whose profile was saved settle it once", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s9" });
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s9" });
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual([
            {
              _tag: "Stopped",
              sessionId: "s9",
              cloudSynced: false,
              profileSaved: true,
              cleanupPending: true,
            },
          ]);
          yield* h.tick("30 seconds");
          expect(
            h.fake.state.calls.filter(
              (call) => call === "remove cg-session-s9",
            ),
          ).toHaveLength(2);
          expect(withoutHeartbeats(yield* h.drain)).toEqual([]);
          expect(yield* h.supervisor.snapshot).toEqual([]);
        }),
      (fake) => {
        savedProfileContainer(fake, true);
        const [container] = fake.state.existing;
        fake.state.existing = [];
        if (container !== undefined)
          fake.state.inspected["cg-session-s9"] = container;
        fake.state.removeFails = 1;
      },
    ));
});

describe("session metrics", () => {
  /** Отчёты замеров и игры (без этапов и heartbeat'ов). */
  const metricsAndGame = (reports: ReadonlyArray<AgentReport>) =>
    reports.filter(
      (report) =>
        report._tag === "SessionMetrics" ||
        report._tag === "GameState" ||
        report._tag === "Stopped",
    );

  /** Карта занята на 300 МиБ до игры, контейнер — PID 42 и 43. */
  const playing = (fake: Fake) => {
    const m = fake.state.metrics;
    m.memoryBytes = 2048 * MiB;
    // 25 с CPU за 120 с системного времени на 12 ядрах — 2,5 ядра.
    m.cpuStep = 25_000_000_000;
    m.topPids = [42, 43];
    m.gpuProcesses = gpuProcessesXml([
      [42, "C+G", 1885],
      [43, "G", 15],
      [7, "G", 40],
    ]);
  };

  it("game run sends SessionMetrics every 60 s and on exit", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          h.fake.state.game = true;
          yield* h.tick("5 seconds");
          expect(metricsAndGame(yield* h.drainAll)).toEqual([
            { _tag: "GameState", sessionId: "s1", running: true },
          ]);
          // База `gpu_total` снята при старте игры (300 МиБ); дальше карта занята сильнее.
          h.fake.state.metrics.smi = smiLine(2300, 87);
          yield* h.tick("50 seconds");
          expect(metricsAndGame(yield* h.drainAll)).toEqual([]);
          yield* h.tick("10 seconds");
          const minute: Extract<AgentReport, { _tag: "SessionMetrics" }> = {
            _tag: "SessionMetrics",
            sessionId: "s1",
            gameSeconds: 60,
            peakVramBytes: 1900 * MiB,
            peakRamBytes: 2048 * MiB,
            cpuCoresP95: 2.5,
            gpuUtilP95: 87,
            vramSource: "process",
          };
          expect(metricsAndGame(yield* h.drainAll)).toEqual([minute]);
          h.fake.state.game = false;
          yield* h.tick("5 seconds");
          expect(metricsAndGame(yield* h.drainAll)).toEqual([
            { ...minute, gameSeconds: 65 },
            {
              _tag: "GameState",
              sessionId: "s1",
              running: false,
              end: "unknown",
            },
          ]);
          // Игра закрылась — замеры кончились.
          const calls = h.fake.state.metrics.statsCalls;
          yield* h.tick("60 seconds");
          expect(h.fake.state.metrics.statsCalls).toBe(calls);
          expect(
            (yield* h.drainAll).filter((r) => r._tag === "SessionMetrics"),
          ).toEqual([]);
        }),
      playing,
    ));

  it("slow samples keep the 10 s grid and the report at 60 s of play", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          // Каждый замер «идёт» 3 с: сетка замеров и отчёт от него не сдвигаются.
          h.fake.state.metrics.statsDelay = "3 seconds";
          yield* startReady(h);
          h.fake.state.game = true;
          yield* h.tick("5 seconds");
          yield* h.drainAll;
          // Замеры начинаются в 10, 20, … 60 с игры и кончаются через 3 с.
          for (let i = 0; i < 62; i++) yield* h.tick("1 second");
          expect(
            (yield* h.drainAll).filter((r) => r._tag === "SessionMetrics"),
          ).toEqual([]);
          const callsBeforeReport = h.fake.state.metrics.statsCalls;
          yield* h.tick("1 second");
          expect(
            (yield* h.drainAll).filter((r) => r._tag === "SessionMetrics"),
          ).toEqual([expect.objectContaining({ gameSeconds: 63 })]);
          // Начальный снимок CPU + 6 замеров.
          expect(callsBeforeReport).toBe(7);
          // Следующий отчёт — через 60 с после первого, а не через 6 замеров по 13 с.
          for (let i = 0; i < 60; i++) yield* h.tick("1 second");
          expect(
            (yield* h.drainAll).filter((r) => r._tag === "SessionMetrics"),
          ).toEqual([expect.objectContaining({ gameSeconds: 123 })]);
        }),
      playing,
    ));

  it("stop mid-game sends the last SessionMetrics before Stopped", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          h.fake.state.game = true;
          yield* h.tick("5 seconds");
          yield* h.tick("20 seconds");
          yield* h.drainAll;
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          h.fake.state.cloud = 1;
          yield* h.tick("2 seconds");
          expect(metricsAndGame(yield* h.drainAll)).toEqual([
            {
              _tag: "SessionMetrics",
              sessionId: "s1",
              gameSeconds: 20,
              peakVramBytes: 1900 * MiB,
              peakRamBytes: 2048 * MiB,
              cpuCoresP95: 2.5,
              gpuUtilP95: 0,
              vramSource: "process",
            },
            {
              _tag: "Stopped",
              sessionId: "s1",
              cloudSynced: true,
              profileSaved: true,
            },
          ]);
        }),
      playing,
    ));

  it("container pids not on the GPU fall back to gpu_total", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          h.fake.state.game = true;
          yield* h.tick("5 seconds");
          h.fake.state.metrics.smi = smiLine(2300, 87);
          h.fake.state.metrics.topPids = [500, 501];
          yield* h.tick("10 seconds");
          h.fake.state.game = false;
          yield* h.tick("5 seconds");
          expect(
            (yield* h.drainAll).filter((r) => r._tag === "SessionMetrics"),
          ).toEqual([
            expect.objectContaining({
              peakVramBytes: 2000 * MiB,
              vramSource: "gpu_total",
            }),
          ]);
        }),
      playing,
    ));

  it("failed samples give null fields and keep the session", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          h.fake.state.game = true;
          yield* h.tick("5 seconds");
          const m = h.fake.state.metrics;
          m.statsFail = true;
          m.topFail = true;
          m.smi = undefined;
          m.gpuProcesses = undefined;
          yield* h.tick("60 seconds");
          expect(
            (yield* h.drainAll).filter((r) => r._tag === "SessionMetrics"),
          ).toEqual([
            {
              _tag: "SessionMetrics",
              sessionId: "s1",
              gameSeconds: 60,
              peakVramBytes: null,
              peakRamBytes: null,
              cpuCoresP95: null,
              gpuUtilP95: null,
              vramSource: "gpu_total",
            },
          ]);
          expect(
            h.fake.state.logged.filter((line) =>
              line.includes("Session metrics sample failed"),
            ).length,
          ).toBeGreaterThan(0);
          expect((yield* h.supervisor.snapshot)[0]?.gameRunning).toBe(true);
        }),
      playing,
    ));
});

describe("game end", () => {
  it("parseGameExit maps the wrapper's line to the game end", () => {
    expect(parseGameExit("code 0\n")).toBe("quit");
    expect(parseGameExit("code 1\n")).toBe("error");
    expect(parseGameExit("code 127\n")).toBe("error");
    expect(parseGameExit("code 128\n")).toBe("error");
    // bash отдаёт смерть от сигнала n как 128+n.
    expect(parseGameExit("code 139\n")).toBe("crash");
    expect(parseGameExit("code 134")).toBe("crash");
    expect(parseGameExit("code 129\n")).toBe("crash");
    expect(parseGameExit("code 192\n")).toBe("crash");
    // Выше 128+64 — не сигнал, а обычный код (`exit 255`, `exit -1`).
    expect(parseGameExit("code 193\n")).toBe("error");
    expect(parseGameExit("code 255\n")).toBe("error");
    expect(parseGameExit("signal 11\n")).toBe("crash");
    expect(parseGameExit("")).toBe("unknown");
    expect(parseGameExit("code\n")).toBe("unknown");
    expect(parseGameExit("code -1\n")).toBe("unknown");
    expect(parseGameExit("exit 0\n")).toBe("unknown");
  });

  it("GameState after the game exits carries the end", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        h.fake.state.game = false;
        h.fake.state.gameExit = "code 139\n";
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([
          { _tag: "GameState", sessionId: "s1", running: true },
          { _tag: "GameState", sessionId: "s1", running: false, end: "crash" },
        ]);
      }),
    ));

  it("no exit file gives unknown", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* startReady(h);
        h.fake.state.game = true;
        yield* h.tick("5 seconds");
        h.fake.state.game = false;
        yield* h.tick("5 seconds");
        expect(yield* h.drain).toEqual([
          { _tag: "GameState", sessionId: "s1", running: true },
          {
            _tag: "GameState",
            sessionId: "s1",
            running: false,
            end: "unknown",
          },
        ]);
      }),
    ));

  it("launch options get the wrapper before start and lose it before the profile is packed", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          const localConfig =
            "/home/ubuntu/.local/share/Steam/userdata/22202/config/localconfig.vdf";
          expect(
            callsFrom(
              h.fake,
              "archiveSize cg-session-s1 /usr/local/bin/cg-game-exit",
            ),
          ).toEqual([
            "archiveSize cg-session-s1 /usr/local/bin/cg-game-exit",
            `getArchive cg-session-s1 ${loginUsers}`,
            `getArchive cg-session-s1 ${localConfig}`,
            "putArchive cg-session-s1 /home/ubuntu",
            "start cg-session-s1",
            "remove cg-s-s1-hold",
          ]);
          const wrapped = findTarEntry(
            h.fake.state.put[0]!.tar,
            "localconfig.vdf",
          );
          expect(new TextDecoder().decode(wrapped)).toContain(
            '"LaunchOptions"\t\t"/usr/local/bin/cg-game-exit %command% -novid"',
          );

          // Остановка: Steam закрыт → обёртка снята → профиль пакуется.
          h.fake.state.home[localConfig] = new TextDecoder().decode(wrapped);
          h.fake.state.calls.length = 0;
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          expect(h.fake.state.calls.slice(0, 5)).toEqual([
            "exec cg-session-s1 /usr/local/bin/cg-steam-shutdown",
            `getArchive cg-session-s1 ${loginUsers}`,
            `getArchive cg-session-s1 ${localConfig}`,
            "putArchive cg-session-s1 /home/ubuntu",
            "exec cg-session-s1 /usr/local/bin/cg-profile-pack",
          ]);
          const restored = findTarEntry(
            h.fake.state.put[1]!.tar,
            "localconfig.vdf",
          );
          expect(new TextDecoder().decode(restored)).toContain(
            '"LaunchOptions"\t\t"-novid"',
          );
        }),
      (fake) => {
        fake.state.home[loginUsers] =
          '"users"\n{\n\t"76561197960287930"\n\t{\n\t\t"AccountName"\t\t"a"\n\t}\n}\n';
        fake.state.home[
          "/home/ubuntu/.local/share/Steam/userdata/22202/config/localconfig.vdf"
        ] =
          '"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "1794680" { "LaunchOptions" "-novid" } } } } } }';
      },
    ));
});

const loginUsers = "/home/ubuntu/.local/share/Steam/config/loginusers.vdf";
