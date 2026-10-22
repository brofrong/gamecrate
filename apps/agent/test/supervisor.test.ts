import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCommand, AgentReport, ProfileCommit } from "@cg/rpc";
import {
  Context,
  Deferred,
  type Duration,
  Effect,
  Layer,
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
  ProfileCommitError,
  ProfileCommitter,
} from "../src/profile/ProfileCommitter";
import { ProfileStore, ProfileStoreError } from "../src/profile/ProfileStore";
import {
  CLOUD_LOG,
  commands,
  failReasons,
  GPU_FAILURE_LINE,
  SessionSupervisor,
  type SessionSupervisorShape,
} from "../src/SessionSupervisor";
import { tarOfFile, testConfig, unusedDocker } from "./fakes";

const bytes = (text: string) => new TextEncoder().encode(text);

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
    /** Сбой подсчёта маркеров: `exit` — grep вышел с кодом 2, `docker` — exec упал. */
    cloudFail: undefined as "exit" | "docker" | undefined,
    /** Закрыт — `grep` журнала облака ждёт его открытия. */
    cloudGate: undefined as Deferred.Deferred<void> | undefined,
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
    start: (name) => Effect.sync(() => record(`start ${name}`)),
    wait: (name) =>
      Effect.sync(() => {
        record(`wait ${name}`);
        return 0;
      }),
    stop: (name, timeoutSec) =>
      Effect.sync(() => record(`stop ${name} ${timeoutSec}`)),
    remove: (name) => Effect.sync(() => record(`remove ${name}`)),
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
    removeVolume: (name) => Effect.sync(() => record(`removeVolume ${name}`)),
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
      Effect.sync(() => {
        record(`getArchive ${container} ${path}`);
        return tarOfFile(
          "cg-profile.tar",
          container.endsWith("-import") ? state.legacy : state.packed,
        );
      }),
    exec: (name, cmd) =>
      Effect.suspend(() => {
        state.dockerCalls++;
        if (cmd[0] === "pkill" || cmd[0]?.startsWith("/usr/local/bin/cg-"))
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
          case "pkill":
            if (cmd.join(" ") !== "pkill -TERM -f AppId=1794680( |$)")
              return Effect.succeed({ exitCode: 2, stdout: "" });
            state.game = false;
            return Effect.succeed({ exitCode: 0, stdout: "" });
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
  return { state, docker, store, committer };
};

type Fake = ReturnType<typeof makeFake>;

interface Harness {
  readonly fake: Fake;
  readonly supervisor: SessionSupervisorShape;
  /** Все отчёты, накопившиеся к этому моменту. */
  readonly drain: Effect.Effect<Array<AgentReport>>;
  readonly tick: (duration: Duration.Input) => Effect.Effect<void>;
}

/** Супервизор на фейках и TestClock; `setup` готовит фейк до старта. */
const run = (
  body: (h: Harness) => Effect.Effect<void, unknown>,
  setup: (fake: Fake) => void = () => {},
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
    const drain = Queue.clear(supervisor.reports);
    const tick = (duration: Duration.Input) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(duration);
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      });
    yield* tick("0 seconds");
    yield* body({ fake, supervisor, drain, tick });
  });
  return Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provideService(References.MinimumLogLevel, "None"),
      Effect.ensuring(
        Effect.sync(() =>
          rmSync(fake.state.scratch, { recursive: true, force: true }),
        ),
      ),
    ),
  );
};

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

const start: Extract<AgentCommand, { _tag: "StartSession" }> = {
  _tag: "StartSession",
  sessionId: "s1",
  userId: "u1",
  appId: 1794680,
  slot: 1,
  udpPort: 59001,
  profile: null,
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
        expect(h.fake.state.created).toHaveLength(1);
        const spec = h.fake.state.created[0];
        expect(spec).toEqual({
          name: "cg-session-s1",
          image: "cg-session:550.163.01",
          env: {
            CG_APP_ID: "1794680",
            SELKIES_WEBRTC_UDP_MUX_PORT: "59001",
            SELKIES_WEBRTC_PUBLIC_IP: "203.0.113.7",
            PASSWD: expect.any(String),
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
        const passwords = h.fake.state.created.map((spec) => spec.env.PASSWD);
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
          { _tag: "GameState", sessionId: "s1", running: false },
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
        expect(h.fake.state.created).toHaveLength(1);
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
            "exec cg-session-lost /usr/local/bin/cg-profile-pack",
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
          { _tag: "GameState", sessionId: "s1", running: false },
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
            { _tag: "GameState", sessionId: "a", running: false },
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
          { _tag: "GameState", sessionId: "s1", running: false },
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
          "store.get profiles/u1/v7.cgp",
          "putArchive cg-session-s1 /home/ubuntu",
          "start cg-session-s1",
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

  it("start imports legacy cg-home volume when no profile", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.supervisor.handle(start);
          yield* h.tick("0 seconds");
          expect(callsFrom(h.fake, "create cg-session-s1")).toEqual([
            "create cg-session-s1",
            "volumeExists cg-home-u1",
            "remove cg-session-s1-import",
            "create cg-session-s1-import",
            "start cg-session-s1-import",
            "wait cg-session-s1-import",
            "getArchive cg-session-s1-import /tmp/cg-profile.tar",
            "remove cg-session-s1-import",
            "putArchive cg-session-s1 /home/ubuntu",
            "start cg-session-s1",
          ]);
          expect(h.fake.state.created[1]).toEqual({
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
          "volumeExists cg-home-u1",
          "start cg-session-s1",
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
        expect(callsFrom(h.fake, "remove cg-session-s1")).toEqual(
          removedWithLayers("s1").slice(1),
        );
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
          "exec cg-session-s1 /usr/local/bin/cg-profile-pack",
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

  it("rejected commit deletes uploaded object", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* startReady(h);
          yield* h.supervisor.handle({ _tag: "StopSession", sessionId: "s1" });
          yield* h.tick("0 seconds");
          // Профиля не было: база null.
          expect(h.fake.state.commits[0]?.baseVersion).toBeNull();
          expect(callsFrom(h.fake, "commit profiles/u1/new.cgp")).toEqual([
            "commit profiles/u1/new.cgp",
            "store.remove profiles/u1/new.cgp",
            ...removedWithLayers("s1"),
          ]);
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
            expect(calls.at(-1)).toBe("stop cg-session-s1 15");
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
