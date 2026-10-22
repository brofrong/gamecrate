import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type AgentCommand,
  type AgentConnect,
  AgentNotConnected,
  type AgentReport,
  AgentRpcs,
} from "@cg/rpc";
import { BunHttpServer } from "@effect/platform-bun";
import {
  type Cause,
  Effect,
  Layer,
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
import * as OrchestratorLink from "../src/OrchestratorLink";
import {
  SessionSupervisor,
  type SessionSupervisorShape,
} from "../src/SessionSupervisor";

const token = "link-test-token-0123456789abcdef!";

/** Фейковый оркестратор: журнал подключений и отчётов, очереди команд. */
const server = {
  authorizations: [] as Array<string | undefined>,
  connects: [] as Array<AgentConnect>,
  streams: [] as Array<Queue.Queue<AgentCommand, Cause.Done>>,
  reports: [] as Array<AgentReport>,
  /** Сколько следующих отчётов отклонить с AgentNotConnected. */
  rejectReports: 0,
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
            return Stream.fromQueue(queue);
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
      // Task 5: оркестратор проверяет baseVersion и upsert'ит `profiles`.
      "agent.profileCommit": () => Effect.succeed({ accepted: false }),
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

const config = (): AgentConfigValues => ({
  workerId: "w1",
  orchestratorUrl: `ws://127.0.0.1:${port}/agent`,
  agentToken: Redacted.make(token),
  publicIp: "203.0.113.7",
  slots: 1,
  udpPortBase: 59000,
  sessionImage: "cg-session:test",
  sessionNetwork: "cg-sessions",
  gbmAllocatorPath: Option.none(),
  dockerSocket: "/var/run/docker.sock",
  s3Endpoint: "http://cg-rustfs:9000",
  s3Bucket: "cg-profiles",
  s3AccessKey: Redacted.make("test-access-key"),
  s3SecretKey: Redacted.make("test-secret-key"),
  profileKey: Redacted.make(Buffer.from(new Uint8Array(32)).toString("base64")),
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
  it(
    "connects with bearer and snapshot, routes commands, sends reports in order, reconnects",
    () =>
      Effect.gen(function* () {
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
        yield* Layer.build(
          OrchestratorLink.layer.pipe(
            Layer.provide(Layer.succeed(SessionSupervisor, supervisor)),
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
          roles: ["worker"],
          installs: [],
        });

        const start: AgentCommand = {
          _tag: "StartSession",
          sessionId: "s1",
          userId: "u1",
          appId: 1,
          slot: 0,
          udpPort: 59000,
          profile: null,
        };
        yield* Queue.offer(server.streams[0]!, start);
        yield* waitUntil(() => handled.length === 1);
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

        // Поток команд завершился сам (вытеснен) — тоже переподключение.
        yield* Queue.end(server.streams[1]!);
        yield* waitUntil(() => server.connects.length === 3);
      }).pipe(
        Effect.scoped,
        Effect.provideService(References.MinimumLogLevel, "None"),
        Effect.runPromise,
      ),
    15_000,
  );
});
