import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type AgentCommand,
  type AgentConnect,
  AgentNotConnected,
  type AgentReport,
  AgentRpcs,
  type ProfileCommit,
  type WorkerHardware,
  type WorkerStats,
  type WorkerVersions,
} from "@cg/rpc";
import { BunHttpServer } from "@effect/platform-bun";
import {
  type Cause,
  Effect,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Queue,
  Redacted,
  References,
  Stream,
} from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AgentConfig, type AgentConfigValues } from "../src/config";
import { Installer, type InstallerShape } from "../src/Installer";
import * as OrchestratorLink from "../src/OrchestratorLink";
import { ProfileCommitter } from "../src/profile/ProfileCommitter";
import {
  SessionSupervisor,
  type SessionSupervisorShape,
} from "../src/SessionSupervisor";
import { WorkerMonitor, type WorkerMonitorShape } from "../src/WorkerMonitor";
import { testConfig } from "./fakes";

const token = "link-test-token-0123456789abcdef!";

/** Фейковый оркестратор: журнал подключений и отчётов, очереди команд. */
const server = {
  authorizations: [] as Array<string | undefined>,
  connects: [] as Array<AgentConnect>,
  streams: [] as Array<Queue.Queue<AgentCommand, Cause.Done>>,
  reports: [] as Array<AgentReport>,
  /** Сколько следующих отчётов отклонить с AgentNotConnected. */
  rejectReports: 0,
  commits: [] as Array<ProfileCommit>,
  /**
   * Номер зарегистрированного соединения (0 — нет): как у AgentHub, коммит без
   * регистрации — AgentNotConnected.
   */
  registered: 0,
  /** Номер последнего `agent.connect`. */
  generation: 0,
  /** Задержка регистрации после прихода `agent.connect`, мс. */
  registerDelayMs: 0,
  /** Сколько коммитов отклонено с AgentNotConnected. */
  commitRejections: 0,
};

const Handlers = AgentRpcs.toLayer(
  Effect.succeed(
    AgentRpcs.of({
      "agent.connect": (payload) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<AgentCommand, Cause.Done>();
            server.connects.push(payload);
            server.streams.push(queue);
            const generation = ++server.generation;
            yield* Effect.sleep(server.registerDelayMs);
            server.registered = generation;
            // Поток старого соединения может закончиться позже нового connect.
            return Stream.fromQueue(queue).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  if (server.registered === generation) server.registered = 0;
                }),
              ),
            );
          }),
        ),
      "agent.report": (report) =>
        Effect.suspend(() => {
          if (server.rejectReports > 0) {
            server.rejectReports--;
            return Effect.fail(new AgentNotConnected());
          }
          server.reports.push(report);
          return Effect.void;
        }),
      "agent.profileCommit": (payload) =>
        Effect.suspend(() => {
          if (server.registered === 0) {
            server.commitRejections++;
            return Effect.fail(new AgentNotConnected());
          }
          server.commits.push(payload);
          return Effect.succeed({ accepted: payload.baseVersion === 4 });
        }),
    }),
  ),
);

const Protocol = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const { protocol, httpEffect } =
      yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      "/agent",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        server.authorizations.push(request.headers.authorization);
        if (request.headers.authorization !== `Bearer ${token}`)
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        return yield* httpEffect;
      }),
    );
    return protocol;
  }),
);

const TestServer = HttpRouter.serve(
  RpcServer.layer(AgentRpcs).pipe(
    Layer.provide(Protocol),
    Layer.provide(Handlers),
    Layer.provide(RpcSerialization.layerNdjson),
  ),
  { disableLogger: true, disableListenLog: true },
).pipe(
  Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
);

let runtime: ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>;
let port: number;

beforeAll(async () => {
  runtime = ManagedRuntime.make(TestServer);
  const address = await runtime.runPromise(
    HttpServer.HttpServer.useSync((s) => s.address),
  );
  if (!("port" in address)) throw new Error("expected a TCP address");
  port = address.port;
});
afterAll(() => runtime.dispose());

const config = (): AgentConfigValues =>
  testConfig({
    orchestratorUrl: `ws://127.0.0.1:${port}/agent`,
    agentToken: Redacted.make(token),
    slots: 1,
    sessionImage: "cg-session:test",
    gbmAllocatorPath: Option.none(),
    roles: ["worker", "gamestore"],
  });

const hardware: WorkerHardware = {
  cpuModel: "AMD Ryzen 5 2600X Six-Core Processor",
  cpuCores: 6,
  cpuThreads: 12,
  memoryBytes: 32 * 2 ** 30,
  gpus: [
    { name: "NVIDIA GeForce GTX 1650 SUPER", memoryBytes: 4096 * 2 ** 20 },
  ],
  disks: [
    {
      name: "nvme0n1",
      kind: "nvme",
      sizeBytes: 250 * 10 ** 9,
      raidLevel: null,
      members: [],
    },
  ],
};

const versions: WorkerVersions = {
  agentCommit: "abc1234",
  sessionImage: "cg-session:test",
  driver: "550.163.01",
  steamClientBuiltAt: null,
};

const stats: WorkerStats = {
  cpuPercent: 12,
  memory: { totalBytes: 100, usedBytes: 40, cacheBytes: 30 },
  gpus: [
    {
      utilPercent: 5,
      encoderPercent: null,
      temperatureC: 40,
      memoryUsedBytes: 4,
      memoryTotalBytes: 4096,
    },
  ],
  filesystems: [
    {
      purposes: ["scratch", "steamClient"],
      totalBytes: 10,
      usedBytes: 4,
      freeBytes: 6,
    },
  ],
  uptimeSeconds: 1234,
};

/** Фейковый WorkerMonitor: снимки железа/версий и очередь отчётов `WorkerStats`. */
const fakeMonitor = (
  reports: Queue.Queue<AgentReport>,
): WorkerMonitorShape => ({
  snapshot: Effect.succeed({ hardware, versions }),
  reports,
});

const waitUntil = (condition: () => boolean, ms = 5000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await Bun.sleep(10);
    }
  });

describe("OrchestratorLink", () => {
  it("install results survive a reconnect like session results", () => {
    const report = (tag: AgentReport["_tag"]) =>
      OrchestratorLink.isTerminal({ _tag: tag } as AgentReport);
    expect(report("InstallFinished")).toBe(true);
    expect(report("InstallFailed")).toBe(true);
    expect(report("Stopped")).toBe(true);
    expect(report("Failed")).toBe(true);
    expect(report("InstallProgress")).toBe(false);
    expect(report("Heartbeat")).toBe(false);
  });

  it(
    "connects with bearer and snapshot, routes commands, sends reports in order, commits profiles, reconnects",
    () =>
      Effect.gen(function* () {
        const committer = yield* ProfileCommitter;
        // Коммит до соединения ждёт его.
        const early = yield* Effect.forkChild(
          committer.commit({
            userId: "u1",
            baseVersion: 4,
            objectKey: "profiles/u1/a.cgp",
            sizeBytes: 10,
            steamLoginSeeded: false,
          }),
        );
        const handled: Array<AgentCommand> = [];
        const reports = yield* Queue.unbounded<AgentReport>();
        const supervisor: SessionSupervisorShape = {
          handle: (command) => Effect.sync(() => void handled.push(command)),
          snapshot: Effect.succeed([
            {
              sessionId: "s0",
              slot: 0,
              streamUrl: "http://cg-session-s0:8080",
              gameRunning: true,
            },
          ]),
          reports,
        };
        const installed: Array<AgentCommand> = [];
        const installReports = yield* Queue.unbounded<AgentReport>();
        const installer: InstallerShape = {
          install: (command) => Effect.sync(() => void installed.push(command)),
          cancel: (jobId) =>
            Effect.sync(
              () => void installed.push({ _tag: "CancelInstall", jobId }),
            ),
          running: () => ["j0"],
          reports: installReports,
        };
        const monitorReports = yield* Queue.unbounded<AgentReport>();
        yield* Layer.build(
          OrchestratorLink.layer.pipe(
            Layer.provide(Layer.succeed(SessionSupervisor, supervisor)),
            Layer.provide(Layer.succeed(Installer, installer)),
            Layer.provide(
              Layer.succeed(WorkerMonitor, fakeMonitor(monitorReports)),
            ),
            Layer.provide(Layer.succeed(ProfileCommitter, committer)),
            Layer.provide(Layer.succeed(AgentConfig, config())),
          ),
        );

        yield* waitUntil(() => server.connects.length === 1);
        expect(server.authorizations.at(-1)).toBe(`Bearer ${token}`);
        expect(server.connects[0]).toEqual({
          workerId: "w1",
          publicIp: "203.0.113.7",
          slots: 1,
          udpPortBase: 59000,
          running: [
            {
              sessionId: "s0",
              slot: 0,
              streamUrl: "http://cg-session-s0:8080",
              gameRunning: true,
            },
          ],
          // Роли — из ROLES, установки — живые задачи установщика.
          roles: ["worker", "gamestore"],
          installs: ["j0"],
          // Снимок железа и версий воркера — для админки.
          hardware,
          versions,
        });

        expect(yield* Fiber.join(early)).toBe(true);
        expect(
          yield* committer.commit({
            userId: "u1",
            baseVersion: 3,
            objectKey: "profiles/u1/b.cgp",
            sizeBytes: 11,
            steamLoginSeeded: false,
          }),
        ).toBe(false);
        expect(server.commits.map((c) => c.objectKey)).toEqual([
          "profiles/u1/a.cgp",
          "profiles/u1/b.cgp",
        ]);

        const start: AgentCommand = {
          _tag: "StartSession",
          sessionId: "s1",
          userId: "u1",
          appId: 1,
          slot: 0,
          udpPort: 59000,
          profile: null,
          steamLogin: null,
        };
        yield* Queue.offer(server.streams[0]!, start);
        yield* waitUntil(() => handled.length === 1);
        expect(handled).toEqual([start]);

        // Команды установки — установщику, не супервизору сессий.
        const installGame: AgentCommand = {
          _tag: "InstallGame",
          jobId: "j1",
          appId: 736260,
          userId: "u1",
          profile: null,
          steamLogin: null,
          steamLoginTimeoutSeconds: 90,
        };
        yield* Queue.offerAll(server.streams[0]!, [
          installGame,
          { _tag: "CancelInstall", jobId: "j1" },
        ]);
        yield* waitUntil(() => installed.length === 2);
        expect(installed).toEqual([
          installGame,
          { _tag: "CancelInstall", jobId: "j1" },
        ]);
        expect(handled).toEqual([start]);

        yield* Queue.offerAll(reports, [
          { _tag: "StreamReady", sessionId: "s1", streamUrl: "u" },
          { _tag: "GameState", sessionId: "s1", running: true },
          { _tag: "Heartbeat", sessionIds: ["s1"] },
        ]);
        yield* waitUntil(() => server.reports.length === 3);
        expect(server.reports.map((r) => r._tag)).toEqual([
          "StreamReady",
          "GameState",
          "Heartbeat",
        ]);
        // Отчёты установщика идут тем же порядком, что и в его очереди.
        yield* Queue.offerAll(installReports, [
          {
            _tag: "InstallProgress",
            jobId: "j1",
            bytesDownloaded: 1,
            bytesTotal: 2,
          },
          { _tag: "InstallFailed", jobId: "j1", reason: "Установка отменена" },
        ]);
        yield* waitUntil(() => server.reports.length === 5);
        expect(server.reports.slice(3).map((r) => r._tag)).toEqual([
          "InstallProgress",
          "InstallFailed",
        ]);
        server.reports.splice(3);

        // Снимок загрузки — третий источник отчётов.
        yield* Queue.offer(monitorReports, { _tag: "WorkerStats", stats });
        yield* waitUntil(() => server.reports.length === 4);
        expect(server.reports[3]).toEqual({ _tag: "WorkerStats", stats });
        server.reports.splice(3);

        // Оркестратор отклонил итоговый отчёт: переподключение, отчёт уходит первым.
        server.rejectReports = 1;
        yield* Queue.offer(reports, {
          _tag: "Stopped",
          sessionId: "s1",
          cloudSynced: true,
          profileSaved: false,
        });
        yield* waitUntil(() => server.connects.length === 2);
        yield* waitUntil(() => server.reports.length === 4);
        expect(server.reports[3]).toEqual({
          _tag: "Stopped",
          sessionId: "s1",
          cloudSynced: true,
          profileSaved: false,
        });

        // Поток команд завершился сам (вытеснен) — тоже переподключение. Коммит,
        // начатый между соединениями, уходит по новому сокету раньше, чем
        // оркестратор зарегистрировал агента (AgentNotConnected), — и повторяется.
        server.registerDelayMs = 300;
        server.commitRejections = 0;
        yield* Queue.end(server.streams[1]!);
        yield* waitUntil(() => server.registered === 0);
        // Клиент уже закрыл старое соединение (переподключение — не раньше 1 с).
        yield* Effect.promise(() => Bun.sleep(200));
        const during = yield* Effect.forkChild(
          committer.commit({
            userId: "u1",
            baseVersion: 4,
            objectKey: "profiles/u1/c.cgp",
            sizeBytes: 12,
            steamLoginSeeded: false,
          }),
        );
        yield* waitUntil(() => server.connects.length === 3);
        expect(yield* Fiber.join(during)).toBe(true);
        expect(server.commitRejections).toBeGreaterThan(0);
        expect(server.commits.map((c) => c.objectKey)).toEqual([
          "profiles/u1/a.cgp",
          "profiles/u1/b.cgp",
          "profiles/u1/c.cgp",
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(ProfileCommitter.layer),
        Effect.provideService(References.MinimumLogLevel, "None"),
        Effect.runPromise,
      ),
    15_000,
  );

  it("command log never contains the Steam token or account name", () => {
    const secretToken = "SECRET-TOKEN";
    const secretAccount = "s3cr3t-account-name";
    const logged: Array<unknown> = [];
    const capture = Logger.make(({ message }) => {
      logged.push(message);
    });
    return Effect.gen(function* () {
      const reports = yield* Queue.unbounded<AgentReport>();
      const supervisor: SessionSupervisorShape = {
        handle: () => Effect.void,
        snapshot: Effect.succeed([]),
        reports,
      };
      const installed: Array<AgentCommand> = [];
      const installReports = yield* Queue.unbounded<AgentReport>();
      const installer: InstallerShape = {
        install: (command) => Effect.sync(() => void installed.push(command)),
        cancel: () => Effect.void,
        running: () => [],
        reports: installReports,
      };
      const before = server.streams.length;
      const monitorReports = yield* Queue.unbounded<AgentReport>();
      yield* Layer.build(
        OrchestratorLink.layer.pipe(
          Layer.provide(Layer.succeed(SessionSupervisor, supervisor)),
          Layer.provide(Layer.succeed(Installer, installer)),
          Layer.provide(
            Layer.succeed(WorkerMonitor, fakeMonitor(monitorReports)),
          ),
          Layer.provide(ProfileCommitter.layer),
          Layer.provide(Layer.succeed(AgentConfig, config())),
        ),
      );
      yield* waitUntil(() => server.streams.length > before);
      const installGame: AgentCommand = {
        _tag: "InstallGame",
        jobId: "secret-job",
        appId: 1,
        userId: "u1",
        profile: null,
        steamLogin: {
          accountName: Redacted.make(secretAccount),
          steamId: "1",
          refreshToken: Redacted.make(secretToken),
        },
        steamLoginTimeoutSeconds: 90,
      };
      yield* Queue.offer(server.streams.at(-1)!, installGame);
      yield* waitUntil(() => installed.length === 1);

      const text = JSON.stringify(logged);
      // Лог правда записан (иначе проверка ниже прошла бы на пустом захвате).
      expect(text).toContain("Command received");
      expect(text).not.toContain(secretToken);
      expect(text).not.toContain(secretAccount);
    }).pipe(
      Effect.scoped,
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(References.MinimumLogLevel, "Info"),
      Effect.runPromise,
    );
  }, 15_000);
});
