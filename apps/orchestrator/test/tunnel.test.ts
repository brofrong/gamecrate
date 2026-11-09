// Тоннель стрима (спека 2026-11-09 §4): relay на своём Bun-сервере, канал
// агента `/agent/tunnel/:tunnelId` на публичном. Фейковый агент — настоящий
// RPC-клиент хаба: на `OpenTunnel` открывает канал своим токеном и отвечает
// как Selkies. Часы — тестовые на всём рантайме (тайм-ауты двигает тест).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { Db, sessions, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  type AgentCommand,
  AgentRpcs,
  decodeTunnelControl,
  encodeTunnelControl,
  RELAY_SECRET_HEADER,
  type TunnelControl,
} from "@cg/rpc";
import { BunHttpServer, BunSocket } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  References,
  Scope,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { TestClock } from "effect/testing";
import { AgentHub } from "../src/AgentHub";
import { HttpApp } from "../src/http";
import { RelayHttp } from "../src/relay";
import { SteamLoginSeeds } from "../src/SteamLoginSeeds";
import { MAX_TUNNELS_PER_WORKER, TunnelError, Tunnels } from "../src/Tunnels";
import { WorkerAuth } from "../src/WorkerAuth";
import {
  insertSession,
  makeFakeHub,
  seedUsers,
  seedWorker,
  TestOrchestratorConfig,
  testRelaySecret,
} from "./support";

const tokenOf = (workerId: string) => `cgw_tunnel-test-token-of-${workerId}`;

/** Порт relay в тестовом рантайме (у публичного — `HttpServer`). */
class RelayPort extends Context.Service<RelayPort, number>()(
  "test/RelayPort",
) {}

const portOf = (server: HttpServer.HttpServer["Service"]) => {
  const address = server.address;
  if (!("port" in address)) throw new Error("expected a TCP address");
  return address.port;
};

/** Relay на своём Bun-сервере (как `RelayServer`, но на свободном порту). */
const RelayTest = Layer.merge(
  RelayHttp,
  Layer.effect(RelayPort, HttpServer.HttpServer.useSync(portOf)),
).pipe(Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })));

const TestServers = Layer.merge(
  HttpRouter.serve(HttpApp, { disableLogger: true, disableListenLog: true }),
  RelayTest,
).pipe(
  Layer.provideMerge(Tunnels.layer),
  Layer.provideMerge(WorkerAuth.layer),
  Layer.provideMerge(AgentHub.layer),
  Layer.provideMerge(SteamLoginSeeds.layer),
  Layer.provideMerge(DbTest),
  Layer.provide(TestOrchestratorConfig),
  Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
  Layer.provideMerge(TestClock.layer()),
  Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
);

let runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<typeof TestServers>,
  unknown
>;
let port: number;
let relayPort: number;
let agentScope: Scope.Closeable;

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof TestServers>>,
) => runtime.runPromise(effect);

/** Что фейковый агент получил и как себя ведёт. */
const agent = {
  opened: [] as Array<Extract<AgentCommand, { _tag: "OpenTunnel" }>>,
  /** Первые сообщения каналов (запросы оркестратора) и тела HTTP-запросов. */
  requests: [] as Array<TunnelControl>,
  bodies: [] as Array<string>,
  /** `false` — получает `OpenTunnel`, но канал не открывает. */
  dials: true,
  /** Токен, которым открывает канал (по умолчанию свой). */
  dialToken: tokenOf("w1"),
  /** Статус апгрейда канала, когда его не приняли. */
  refusals: [] as Array<number>,
};

/** Ждёт условие по настоящим часам (не дольше `ms`). */
const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Ответ фейкового Selkies на HTTP-запрос канала. */
const selkiesHttp = (ws: WebSocket, request: TunnelControl, body?: string) => {
  if (request.kind !== "http") return;
  if (body !== undefined) agent.bodies.push(body);
  if (request.method === "POST") {
    ws.send(
      encodeTunnelControl({
        kind: "response",
        status: 201,
        headers: [["content-type", "text/plain"]],
      }),
    );
    ws.send(encoder.encode(`got ${body ?? ""}`));
    ws.close(1000);
    return;
  }
  ws.send(
    encodeTunnelControl({
      kind: "response",
      status: 200,
      headers: [
        ["content-type", "text/html; charset=utf-8"],
        ["x-selkies", "fake"],
        ["content-length", "19"],
        ["connection", "keep-alive-from-agent"],
      ],
    }),
  );
  // Тело — двумя бинарными кусками.
  ws.send(encoder.encode("<html>"));
  ws.send(encoder.encode("stream</html>"));
  ws.close(1000);
};

/**
 * Канал фейкового агента: открывает `/agent/tunnel/<id>` и отвечает как
 * Selkies — HTTP по `selkiesHttp`, WebSocket — эхо, текст `close` закрывает
 * канал кодом 4001 «bye».
 */
const dial = (command: Extract<AgentCommand, { _tag: "OpenTunnel" }>) => {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/agent/tunnel/${command.tunnelId}`,
    {
      headers: { authorization: `Bearer ${agent.dialToken}` },
    } as unknown as string[],
  );
  ws.binaryType = "arraybuffer";
  let request: TunnelControl | undefined;
  ws.onmessage = (event) => {
    const data = event.data as string | ArrayBuffer;
    if (request === undefined) {
      request = Option.getOrThrow(decodeTunnelControl(data as string));
      agent.requests.push(request);
      if (request.kind === "ws")
        ws.send(encodeTunnelControl({ kind: "open", protocol: "" }));
      else if (request.kind === "http" && !request.hasBody)
        selkiesHttp(ws, request);
      return;
    }
    if (request.kind === "http") {
      selkiesHttp(ws, request, decoder.decode(data as ArrayBuffer));
      return;
    }
    if (data === "close") ws.close(4001, "bye");
    else ws.send(data);
  };
};

/** Сырой апгрейд по TCP: статус ответа сервера. */
const rawUpgrade = (path: string, authorization?: string) =>
  new Promise<number>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
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
      resolve(Number((data.toString().split("\r\n")[0] ?? "").split(" ")[1]));
      socket.destroy();
    });
    socket.once("error", reject);
  });

/** RPC-клиент агента `workerId`, подключённый к хабу; команды — в `onCommand`. */
const connectAgent = (
  workerId: string,
  onCommand: (command: AgentCommand) => void,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          BunSocket.layerWebSocket(`ws://127.0.0.1:${port}/agent`, {
            headers: { authorization: `Bearer ${tokenOf(workerId)}` },
          }),
        ),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    );
    const client = yield* RpcClient.make(AgentRpcs).pipe(
      Effect.provideContext(context),
    );
    yield* client["agent.connect"]({
      token: Redacted.make(tokenOf(workerId)),
      workerId,
      publicIp: "203.0.113.7",
      slots: 2,
      udpPortBase: 59000,
      running: [],
      roles: ["worker"],
      installs: [],
    }).pipe(
      Stream.runForEach((command) => Effect.sync(() => onCommand(command))),
      Effect.forkScoped,
    );
  });

/**
 * Сессия на сервере `workerId` с готовым стримом; у каждой свой пользователь
 * (активная сессия у пользователя одна).
 */
let nextSlot = 0;
const liveSession = (
  workerId: string,
  opts: { state?: "playing" | "ended"; streamUrl?: string | null } = {},
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const id = crypto.randomUUID();
    const userId = `u-${id}`;
    yield* db.insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@steam.invalid`,
      emailVerified: false,
    });
    yield* insertSession({
      id,
      userId,
      state: opts.state ?? "playing",
      workerId,
      // Слот сервера держит одна сессия.
      slot: nextSlot++,
    });
    const streamUrl =
      opts.streamUrl === undefined
        ? `http://cg-session-${id}:8080`
        : opts.streamUrl;
    yield* db.update(sessions).set({ streamUrl }).where(eq(sessions.id, id));
    return id;
  });

beforeAll(async () => {
  runtime = ManagedRuntime.make(TestServers);
  port = await run(HttpServer.HttpServer.useSync(portOf));
  relayPort = await run(RelayPort.useSync((relay) => relay));
  await run(
    Effect.gen(function* () {
      yield* seedUsers();
      yield* seedWorker("w1", { token: tokenOf("w1") });
      yield* seedWorker("w2", { token: tokenOf("w2") });
    }),
  );
  agentScope = Effect.runSync(Scope.make());
  await run(
    connectAgent("w1", (command) => {
      if (command._tag !== "OpenTunnel") return;
      agent.opened.push(command);
      if (agent.dials) dial(command);
    }).pipe(Effect.provideService(Scope.Scope, agentScope)),
  );
  const hub = await run(AgentHub.useSync((hub) => hub));
  await until(() => hub.info("w1") !== undefined);
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(agentScope, Exit.void));
  await runtime.dispose();
});

const relayUrl = (sessionId: string, rest: string) =>
  `http://127.0.0.1:${relayPort}/relay/${sessionId}${rest}`;

/** Секрет relay, как его ставит api (`x-cg-relay-secret`). */
const secret = { [RELAY_SECRET_HEADER]: testRelaySecret };

/** Запрос к relay от имени api (с секретом). */
const relayFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    headers: { ...secret, ...(init.headers as Record<string, string>) },
  });

/** Запрос к relay, за которым можно следить, не дожидаясь ответа. */
const tracked = (promise: Promise<Response>) => {
  const state: { response?: Response } = {};
  void promise.then((response) => {
    state.response = response;
  });
  return state;
};

const adjust = (duration: `${number} seconds`) =>
  run(TestClock.adjust(duration));

describe("relay", () => {
  it("relays an HTTP GET through the agent", async () => {
    const sessionId = await run(liveSession("w1"));
    const before = agent.requests.length;
    const response = await relayFetch(relayUrl(sessionId, "/index.html?x=1"), {
      headers: { accept: "text/html", "x-forwarded-by": "api" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("x-selkies")).toBe("fake");
    // `content-length` агента Bun с потоковым телом то оставляет, то
    // заменяет на chunked — оба ответа верны, тело то же.
    expect(response.headers.get("connection")).not.toBe(
      "keep-alive-from-agent",
    );
    expect(await response.text()).toBe("<html>stream</html>");

    const request = agent.requests[before];
    expect(request?.kind).toBe("http");
    if (request?.kind !== "http") return;
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/index.html?x=1");
    expect(request.hasBody).toBe(false);
    const headers = new Map(request.headers);
    expect(headers.get("accept")).toBe("text/html");
    expect(headers.get("x-forwarded-by")).toBe("api");
    // Hop-by-hop и host relay не передаёт.
    expect(headers.has("host")).toBe(false);
    expect(headers.has("connection")).toBe(false);
    // Секрет api ↔ relay агенту не уходит.
    expect(headers.has(RELAY_SECRET_HEADER)).toBe(false);
    expect(agent.opened.at(-1)?.sessionId).toBe(sessionId);

    // Тело запроса — отдельным бинарным сообщением.
    const posted = await relayFetch(relayUrl(sessionId, "/api"), {
      method: "POST",
      body: "abc",
    });
    expect(posted.status).toBe(201);
    expect(await posted.text()).toBe("got abc");
    const post = agent.requests.at(-1);
    expect(post?.kind === "http" && post.hasBody).toBe(true);
    expect(agent.bodies.at(-1)).toBe("abc");
  });

  it("relays a WebSocket with text and binary frames and close code", async () => {
    const sessionId = await run(liveSession("w1"));
    const ws = new WebSocket(
      `ws://127.0.0.1:${relayPort}/relay/${sessionId}/websocket?x=1`,
      // Bun принимает заголовки апгрейда, тип DOM — нет.
      { headers: secret } as unknown as string[],
    );
    ws.binaryType = "arraybuffer";
    const received: Array<string | number[]> = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) =>
        resolve({ code: event.code, reason: event.reason });
    });
    ws.onmessage = (event) =>
      received.push(
        typeof event.data === "string"
          ? event.data
          : [...new Uint8Array(event.data as ArrayBuffer)],
      );
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("relay WebSocket failed"));
    });
    const request = agent.requests.at(-1);
    expect(request?.kind).toBe("ws");
    if (request?.kind === "ws") expect(request.path).toBe("/websocket?x=1");

    ws.send("hello");
    ws.send(new Uint8Array([1, 2, 3]));
    await until(() => received.length === 2);
    expect(received).toEqual(["hello", [1, 2, 3]]);

    ws.send("close");
    expect(await closed).toEqual({ code: 4001, reason: "bye" });
  });

  it("refuses requests without the relay secret before any lookup", async () => {
    const sessionId = await run(liveSession("w1"));
    const before = agent.opened.length;
    for (const headers of [
      {},
      { [RELAY_SECRET_HEADER]: "wrong" },
      { [RELAY_SECRET_HEADER]: `${testRelaySecret}x` },
    ]) {
      const response = await fetch(relayUrl(sessionId, "/index.html"), {
        headers,
      });
      expect(response.status).toBe(403);
    }
    // Даже не путь relay — 403, а не 404: без секрета relay ничего не раскрывает.
    expect((await fetch(`http://127.0.0.1:${relayPort}/anything`)).status).toBe(
      403,
    );
    // WebSocket без секрета не открывается.
    const ws = new WebSocket(
      `ws://127.0.0.1:${relayPort}/relay/${sessionId}/websocket`,
    );
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });
    expect(opened).toBe(false);
    expect(agent.opened.length).toBe(before);
  });

  it("refuses a session on another worker or not active", async () => {
    const before = agent.opened.length;
    const elsewhere = await run(liveSession("w2"));
    const ended = await run(liveSession("w1", { state: "ended" }));
    const notReady = await run(liveSession("w1", { streamUrl: null }));
    for (const sessionId of [elsewhere, ended, notReady, crypto.randomUUID()]) {
      const response = await relayFetch(relayUrl(sessionId, "/index.html"));
      expect(response.status).toBe(502);
    }
    expect(agent.opened.length).toBe(before);
  });

  it("tunnel from another worker's token is refused", async () => {
    const sessionId = await run(liveSession("w1"));
    agent.dials = false;
    try {
      const before = agent.opened.length;
      const relay = tracked(relayFetch(relayUrl(sessionId, "/index.html")));
      await until(() => agent.opened.length > before);
      const tunnelId = agent.opened.at(-1)!.tunnelId;
      const path = `/agent/tunnel/${tunnelId}`;

      expect(await rawUpgrade(path, `Bearer ${tokenOf("w2")}`)).toBe(401);
      expect(await rawUpgrade(path)).toBe(401);
      expect(await rawUpgrade(path, "Bearer wrong-token")).toBe(401);
      expect(
        await rawUpgrade(
          `/agent/tunnel/${crypto.randomUUID()}`,
          `Bearer ${tokenOf("w1")}`,
        ),
      ).toBe(404);

      await adjust("10 seconds");
      await until(() => relay.response !== undefined);
      expect(relay.response?.status).toBe(502);
      // Истёкший тоннель — 404 и для своего токена.
      expect(await rawUpgrade(path, `Bearer ${tokenOf("w1")}`)).toBe(404);
    } finally {
      agent.dials = true;
    }
  });

  it("times out when the agent never dials", async () => {
    const sessionId = await run(liveSession("w1"));
    agent.dials = false;
    try {
      const before = agent.opened.length;
      const relay = tracked(relayFetch(relayUrl(sessionId, "/index.html")));
      await until(() => agent.opened.length > before);

      await adjust("9 seconds");
      await Bun.sleep(100);
      expect(relay.response).toBeUndefined();

      await adjust("1 seconds");
      await until(() => relay.response !== undefined);
      expect(relay.response?.status).toBe(502);
    } finally {
      agent.dials = true;
    }
  });
});

describe("tunnels", () => {
  it(`refuses a tunnel over ${MAX_TUNNELS_PER_WORKER} per worker`, async () => {
    const fake = makeFakeHub();
    fake.infos.set("w-many", {
      workerId: "w-many",
      publicIp: "203.0.113.9",
      slots: 1,
      udpPortBase: 59000,
      roles: ["worker"],
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tunnels = yield* Tunnels;
        const waiting = yield* Effect.forEach(
          Array.from({ length: MAX_TUNNELS_PER_WORKER }),
          () => Effect.forkScoped(Effect.scoped(tunnels.open("w-many", "s"))),
        );
        // Все ожидают канал: команды ушли, слоты заняты.
        yield* Effect.yieldNow;
        expect(fake.sent.length).toBe(MAX_TUNNELS_PER_WORKER);
        const over = yield* Effect.flip(
          Effect.scoped(tunnels.open("w-many", "s")),
        );
        // Другой сервер — свой счёт.
        fake.infos.set("w-other", {
          ...fake.infos.get("w-many")!,
          workerId: "w-other",
        });
        const otherFiber = yield* Effect.forkScoped(
          Effect.scoped(tunnels.open("w-other", "s")),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interruptAll([...waiting, otherFiber]);
        return { over, sent: fake.sent.length };
      }).pipe(
        Effect.scoped,
        Effect.provide(Tunnels.layer),
        Effect.provideService(AgentHub, fake.hub),
        Effect.provide(TestClock.layer()),
      ),
    );
    expect(result.over).toBeInstanceOf(TunnelError);
    expect(result.over.reason).toBe("Limit");
    expect(result.sent).toBe(MAX_TUNNELS_PER_WORKER + 1);
  });
});
