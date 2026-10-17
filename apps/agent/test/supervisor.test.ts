import { describe, expect, it } from "bun:test";
import type { AgentCommand, AgentReport } from "@cg/rpc";
import {
  Context,
  Deferred,
  type Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
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
  CLOUD_LOG,
  commands,
  failReasons,
  GPU_FAILURE_LINE,
  SessionSupervisor,
  type SessionSupervisorShape,
} from "../src/SessionSupervisor";

const config: AgentConfigValues = {
  workerId: "w1",
  orchestratorUrl: "ws://orchestrator:3001/agent",
  agentToken: Redacted.make("x".repeat(32)),
  publicIp: "203.0.113.7",
  slots: 2,
  udpPortBase: 59000,
  sessionImage: "cg-session:550.163.01",
  sessionNetwork: "cg-sessions",
  gbmAllocatorPath: Option.some(
    "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01",
  ),
  dockerSocket: "/var/run/docker.sock",
};

/** Фейковый dockerd: состояние контейнеров и журнал вызовов. */
const makeFake = () => {
  const state = {
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
    /** Ответы `inspect` по имени контейнера (нет — контейнера нет). */
    inspected: {} as Record<string, ContainerInfo>,
    /** Подменённый код выхода pgrep. */
    pgrepExit: undefined as number | undefined,
    /** Закрыт — `grep` журнала облака ждёт его открытия. */
    cloudGate: undefined as Deferred.Deferred<void> | undefined,
    /** Число любых обращений к DockerClient. */
    dockerCalls: 0,
  };
  const shape: DockerClientShape = {
    createAndStart: (spec) =>
      Effect.suspend(() => {
        state.dockerCalls++;
        state.calls.push(`create ${spec.name}`);
        if (state.failCreate)
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
    stop: (name, timeoutSec) =>
      Effect.sync(() => {
        state.dockerCalls++;
        state.calls.push(`stop ${name} ${timeoutSec}`);
      }),
    remove: (name) =>
      Effect.sync(() => {
        state.dockerCalls++;
        state.calls.push(`remove ${name}`);
      }),
    inspect: (name) =>
      Effect.sync(() => {
        state.dockerCalls++;
        state.calls.push(`inspect ${name}`);
        return state.inspected[name];
      }),
    logs: () =>
      Effect.sync(() => {
        state.dockerCalls++;
        return state.logs;
      }),
    listByLabel: (label) =>
      Effect.sync(() => {
        state.dockerCalls++;
        state.calls.push(`list ${label}`);
        return state.existing;
      }),
    exec: (name, cmd) =>
      Effect.suspend(() => {
        state.dockerCalls++;
        if (cmd[0] === "pkill")
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
          default:
            return Effect.succeed({ exitCode: 127, stdout: "" });
        }
      }),
  };
  return { state, shape };
};

type Fake = ReturnType<typeof makeFake>;

interface Harness {
  readonly fake: Fake;
  readonly supervisor: SessionSupervisorShape;
  /** Все отчёты, накопившиеся к этому моменту. */
  readonly drain: Effect.Effect<Array<AgentReport>>;
  readonly tick: (duration: Duration.Input) => Effect.Effect<void>;
}

/** Супервизор на фейковом Docker и TestClock; `setup` готовит фейк до старта. */
const run = (
  body: (h: Harness) => Effect.Effect<void, unknown>,
  setup: (fake: Fake) => void = () => {},
) => {
  const fake = makeFake();
  setup(fake);
  const program = Effect.gen(function* () {
    const context = yield* Layer.build(
      SessionSupervisor.layer.pipe(
        Layer.provide(Layer.succeed(DockerClient, fake.shape)),
        Layer.provide(Layer.succeed(AgentConfig, config)),
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
    ),
  );
};

const start: Extract<AgentCommand, { _tag: "StartSession" }> = {
  _tag: "StartSession",
  sessionId: "s1",
  userId: "u1",
  appId: 1794680,
  slot: 1,
  udpPort: 59001,
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
  it("start creates container with slot port, labels, volume and env", () =>
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
          },
          labels: { "cg.session": "s1", "cg.slot": "1", "cg.app": "1794680" },
          network: "cg-sessions",
          udpPorts: [59001],
          binds: [
            "cg-home-u1:/home/ubuntu",
            "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01:/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1:ro",
            "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01:/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so:ro",
          ],
          runtime: "nvidia",
          gpus: true,
          shmSizeBytes: 2 * 1024 * 1024 * 1024,
        });
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
          { _tag: "Stopped", sessionId: "s1", cloudSynced: true },
        ]);
        const calls = h.fake.state.calls;
        expect(calls.slice(calls.indexOf("stop cg-session-s1 15"))).toEqual([
          "stop cg-session-s1 15",
          "remove cg-session-s1",
        ]);
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
          { _tag: "Stopped", sessionId: "s1", cloudSynced: false },
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
          { _tag: "Stopped", sessionId: "s1", cloudSynced: true },
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
          { _tag: "Stopped", sessionId: "s1", cloudSynced: false },
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
        }),
      (fake) => {
        fake.state.failCreate = true;
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
          for (const sessionId of ["nope", "foreign", "ours"])
            yield* h.supervisor.handle({ _tag: "StopSession", sessionId });
          yield* h.tick("0 seconds");
          expect(yield* h.drain).toEqual(
            ["nope", "foreign", "ours"].map((sessionId) => ({
              _tag: "Stopped",
              sessionId,
              cloudSynced: false,
            })),
          );
          // Удаляется только контейнер с нашей меткой cg.session=<id>.
          expect(h.fake.state.calls).toEqual([
            "list cg.session",
            "inspect cg-session-nope",
            "inspect cg-session-foreign",
            "inspect cg-session-ours",
            "remove cg-session-ours",
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
            running: false,
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
          { _tag: "Stopped", sessionId: "s1", cloudSynced: true },
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
          expect(h.fake.state.calls).toContain("remove cg-session-old");
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
            { _tag: "Stopped", sessionId: "a", cloudSynced: true },
          ]);
        }),
      (fake) => {
        fake.state.game = true;
        fake.state.cloud = 2;
        fake.state.existing = [
          {
            name: "cg-session-a",
            labels: { "cg.session": "a", "cg.slot": "1", "cg.app": "1794680" },
            running: true,
          },
          {
            name: "cg-session-old",
            labels: { "cg.session": "old", "cg.slot": "0", "cg.app": "1" },
            running: false,
          },
        ];
      },
    ));
});
