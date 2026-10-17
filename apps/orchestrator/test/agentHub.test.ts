import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { Db, workers } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type AgentCommand, type AgentConnect, AgentRpcs } from "@cg/rpc";
import { BunHttpServer, BunSocket } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import {
  Duration,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  PubSub,
  Queue,
  Redacted,
  References,
  type Scope,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { AgentHub, type AgentHubEvent } from "../src/AgentHub";
import { OrchestratorConfig } from "../src/config";
import { HttpApp } from "../src/http";

const token = "test-agent-token";

const TestConfig = Layer.succeed(OrchestratorConfig, {
  port: 0,
  databaseUrl: Redacted.make("postgres://unused"),
  agentToken: Redacted.make(token),
});

/** Настоящий Bun-сервер на свободном порту + AgentHub на временной БД. */
const TestServer = HttpRouter.serve(HttpApp, {
  disableLogger: true,
  disableListenLog: true,
}).pipe(
  Layer.provideMerge(AgentHub.layer),
  Layer.provideMerge(DbTest),
  Layer.provide(TestConfig),
  Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
  Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
);

let runtime: ManagedRuntime.ManagedRuntime<
  HttpServer.HttpServer | AgentHub | Db,
  unknown
>;
let port: number;

beforeAll(async () => {
  runtime = ManagedRuntime.make(TestServer);
  const address = await runtime.runPromise(
    HttpServer.HttpServer.useSync((server) => server.address),
  );
  if (!("port" in address)) throw new Error("expected a TCP address");
  port = address.port;
});
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, AgentHub | Db | Scope.Scope>) =>
  runtime.runPromise(Effect.scoped(effect));

/** Сырой апгрейд `GET /agent` по TCP: статусная строка ответа сервера. */
const rawUpgrade = (authorization?: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          "GET /agent HTTP/1.1",
          `host: 127.0.0.1:${port}`,
          "connection: Upgrade",
          "upgrade: websocket",
          "sec-websocket-version: 13",
          "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
          ...(authorization === undefined
            ? []
            : [`authorization: ${authorization}`]),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", (data) => {
      resolve(data.toString().split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("error", reject);
  });

/** RPC-клиент агента по WebSocket `/agent` (NDJSON), живёт в текущем scope. */
const agentClient = Effect.gen(function* () {
  const context = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        BunSocket.layerWebSocket(`ws://127.0.0.1:${port}/agent`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
  );
  return yield* RpcClient.make(AgentRpcs).pipe(Effect.provideContext(context));
});

const hello = (workerId: string): AgentConnect => ({
  workerId,
  publicIp: "203.0.113.7",
  slots: 1,
  udpPortBase: 59000,
  running: [
    {
      sessionId: "s-running",
      slot: 0,
      streamUrl: "http://cg-session-s-running:8080",
      gameRunning: true,
    },
  ],
});

/** Подключает агента: команды из потока `agent.connect` складываются в очередь. */
const connectAgent = (payload: AgentConnect) =>
  Effect.gen(function* () {
    const client = yield* agentClient;
    const commands = yield* Queue.unbounded<AgentCommand>();
    const fiber = yield* client["agent.connect"](payload).pipe(
      Stream.runForEach((command) => Queue.offer(commands, command)),
      Effect.forkScoped,
    );
    return { client, commands, fiber };
  });

/** Ждёт первое событие хаба, подходящее под условие (не дольше 5 с). */
const waitEvent = <T extends AgentHubEvent>(
  events: PubSub.Subscription<AgentHubEvent>,
  match: (event: AgentHubEvent) => event is T,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* PubSub.take(events);
      if (match(event)) return event;
    }
  }).pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);

const isTag =
  <Tag extends AgentHubEvent["_tag"]>(tag: Tag, workerId: string) =>
  (event: AgentHubEvent): event is Extract<AgentHubEvent, { _tag: Tag }> =>
    event._tag === tag && event.workerId === workerId;

describe("http", () => {
  it("GET /healthz returns ok", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("agent without token gets 401 before upgrade", async () => {
    expect(await rawUpgrade()).toContain(" 401 ");
    expect(await rawUpgrade("Bearer wrong-token")).toContain(" 401 ");
    expect(await rawUpgrade(token)).toContain(" 401 ");
    expect(await rawUpgrade(`Bearer ${token}`)).toContain(" 101 ");
  });
});

describe("agent hub", () => {
  it("connect upserts worker and send delivers command to its stream", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        const events = yield* hub.subscribe;
        const { commands } = yield* connectAgent(hello("w-connect"));

        const connected = yield* waitEvent(
          events,
          isTag("Connected", "w-connect"),
        );
        expect(connected).toEqual({
          _tag: "Connected",
          workerId: "w-connect",
          publicIp: "203.0.113.7",
          slots: 1,
          udpPortBase: 59000,
          running: hello("w-connect").running,
        });
        expect(hub.connected().has("w-connect")).toBe(true);
        expect(hub.info("w-connect")).toEqual({
          workerId: "w-connect",
          publicIp: "203.0.113.7",
          slots: 1,
          udpPortBase: 59000,
        });

        const [row] = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-connect"));
        expect(row?.publicIp).toBe("203.0.113.7");
        expect(row?.slots).toBe(1);
        expect(row?.lastSeenAt).toBeInstanceOf(Date);

        const command: AgentCommand = {
          _tag: "StartSession",
          sessionId: "s-1",
          userId: "u-1",
          appId: 620,
          slot: 0,
          udpPort: 59000,
        };
        expect(yield* hub.send("w-connect", command)).toBe(true);
        const received = yield* Queue.take(commands).pipe(
          Effect.timeout(Duration.seconds(5)),
        );
        expect(received).toEqual(command);
      }),
    ));

  it("reconnect updates the worker row", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const db = yield* Db;
        const events = yield* hub.subscribe;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* connectAgent(hello("w-upsert"));
            yield* waitEvent(events, isTag("Connected", "w-upsert"));
          }),
        );
        yield* connectAgent({
          ...hello("w-upsert"),
          publicIp: "198.51.100.1",
          slots: 2,
        });
        yield* waitEvent(events, isTag("Connected", "w-upsert"));
        const rows = yield* db
          .select()
          .from(workers)
          .where(eq(workers.id, "w-upsert"));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.publicIp).toBe("198.51.100.1");
        expect(rows[0]?.slots).toBe(2);
      }),
    ));

  it("send to unknown worker returns false", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        expect(
          yield* hub.send("w-unknown", { _tag: "StopSession", sessionId: "s" }),
        ).toBe(false);
        expect(hub.connected().has("w-unknown")).toBe(false);
        expect(hub.info("w-unknown")).toBeUndefined();
      }),
    ));

  it("reports are published as hub events", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const events = yield* hub.subscribe;
        const { client } = yield* connectAgent(hello("w-report"));
        yield* waitEvent(events, isTag("Connected", "w-report"));

        yield* client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: ["s-running"],
        });
        yield* client["agent.report"]({
          _tag: "StreamReady",
          sessionId: "s-running",
          streamUrl: "http://cg-session-s-running:8080",
        });

        const heartbeat = yield* waitEvent(events, isTag("Report", "w-report"));
        expect(heartbeat.report).toEqual({
          _tag: "Heartbeat",
          sessionIds: ["s-running"],
        });
        const ready = yield* waitEvent(events, isTag("Report", "w-report"));
        expect(ready.report).toEqual({
          _tag: "StreamReady",
          sessionId: "s-running",
          streamUrl: "http://cg-session-s-running:8080",
        });
      }),
    ));

  it("report without connect is AgentNotConnected", () =>
    run(
      Effect.gen(function* () {
        const client = yield* agentClient;
        const result = yield* client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: [],
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure._tag).toBe("AgentNotConnected");
      }),
    ));

  it("disconnect publishes Disconnected", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const events = yield* hub.subscribe;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* connectAgent(hello("w-gone"));
            yield* waitEvent(events, isTag("Connected", "w-gone"));
          }),
        );
        // Закрытие scope закрыло WebSocket агента.
        yield* waitEvent(events, isTag("Disconnected", "w-gone"));
        expect(hub.connected().has("w-gone")).toBe(false);
        expect(
          yield* hub.send("w-gone", { _tag: "StopSession", sessionId: "s" }),
        ).toBe(false);
      }),
    ));

  it("newer connection of the same worker wins", () =>
    run(
      Effect.gen(function* () {
        const hub = yield* AgentHub;
        const events = yield* hub.subscribe;
        const first = yield* connectAgent(hello("w-twice"));
        yield* waitEvent(events, isTag("Connected", "w-twice"));
        const second = yield* connectAgent(hello("w-twice"));
        yield* waitEvent(events, isTag("Connected", "w-twice"));

        // Старый поток команд завершается; воркер остаётся подключённым.
        yield* Fiber.join(first.fiber).pipe(
          Effect.timeout(Duration.seconds(5)),
        );
        expect(hub.connected().has("w-twice")).toBe(true);

        const command: AgentCommand = { _tag: "StopSession", sessionId: "s" };
        expect(yield* hub.send("w-twice", command)).toBe(true);
        expect(
          yield* Queue.take(second.commands).pipe(
            Effect.timeout(Duration.seconds(5)),
          ),
        ).toEqual(command);

        // Отчёты по старому соединению больше не принимаются.
        const stale = yield* first.client["agent.report"]({
          _tag: "Heartbeat",
          sessionIds: [],
        }).pipe(Effect.result);
        expect(stale._tag).toBe("Failure");
      }),
    ));
});
