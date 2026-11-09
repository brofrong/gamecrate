// Канал тоннеля стрима со стороны агента (спека 2026-11-09 §4): фейковый
// оркестратор (Bun.serve с маршрутом `/agent/tunnel/:tunnelId`) шлёт по
// каналу запрос, фейковый Selkies отвечает; агент между ними — настоящий
// `TunnelClient`, адрес Selkies подменён через `TunnelUpstream`.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  type AgentReport,
  decodeTunnelControl,
  encodeTunnelControl,
  type TunnelControl,
} from "@cg/rpc";
import type { Server, ServerWebSocket } from "bun";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Queue,
  Redacted,
  References,
} from "effect";
import { AgentConfig } from "../src/config";
import {
  SessionSupervisor,
  type SessionSupervisorShape,
} from "../src/SessionSupervisor";
import { TunnelClient, TunnelUpstream } from "../src/TunnelClient";
import { testConfig } from "./fakes";

const token = `cgw_${"t".repeat(43)}`;
/** Сессия, которую «ведёт» агент (стрим готов). */
const live = "11111111-1111-4111-8111-111111111111";
/** Сессия, которой на этом сервере нет. */
const foreign = "22222222-2222-4222-8222-222222222222";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Что видел фейковый Selkies. */
const selkies = {
  requests: [] as Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }>,
  /** Закрытия WebSocket, пришедшие к Selkies со стороны агента. */
  closes: [] as Array<{ code: number; reason: string }>,
};

/** Один канал, открытый агентом к фейковому оркестратору. */
interface Channel {
  readonly authorization: string | null;
  /** Сообщения агента: текст — как есть, бинарное — `Uint8Array`. */
  readonly received: Array<string | Uint8Array>;
  close?: { code: number; reason: string };
  socket?: ServerWebSocket<{ tunnelId: string }>;
}

/** Что видел фейковый оркестратор. */
const orchestrator = {
  /** Все попытки открыть канал (и не по тому пути — тоже). */
  hits: [] as Array<string>,
  channels: new Map<string, Channel>(),
  /** Первые сообщения оркестратора по id тоннеля (что отправить сразу после открытия). */
  scripts: new Map<string, Array<string | Uint8Array>>(),
};

let selkiesServer: Server<undefined>;
let orchestratorServer: Server<{ tunnelId: string }>;

/** Ждёт условие по настоящим часам (не дольше `ms`). */
const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
};

const supervisor: SessionSupervisorShape = {
  handle: () => Effect.void,
  snapshot: Effect.succeed([]),
  reports: Effect.runSync(Queue.unbounded<AgentReport>()),
  hasStream: (sessionId) => sessionId === live,
};

let runtime: ManagedRuntime.ManagedRuntime<TunnelClient, never>;
/** Адрес Selkies для `TunnelUpstream` (тест «Selkies лежит» меняет его). */
let upstream = "";

beforeAll(() => {
  selkiesServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const headers = Object.fromEntries(request.headers);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        selkies.requests.push({
          method: "WS",
          path: url.pathname + url.search,
          headers,
          body: "",
        });
        // Selkies выбирает свой подпротокол из предложенных.
        const offered = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((p) => p.trim());
        return server.upgrade(request, {
          headers: offered.includes("selkies")
            ? { "sec-websocket-protocol": "selkies" }
            : {},
        })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      const body = await request.text();
      selkies.requests.push({
        method: request.method,
        path: url.pathname + url.search,
        headers,
        body,
      });
      if (request.method === "POST")
        return new Response(`got ${body}`, {
          status: 201,
          headers: { "content-type": "text/plain" },
        });
      if (url.pathname === "/redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "/index.html" },
        });
      const response = new Headers({
        "content-type": "text/html; charset=utf-8",
        "x-selkies": "fake",
      });
      response.append("set-cookie", "a=1");
      response.append("set-cookie", "b=2");
      return new Response("<html>stream</html>", { headers: response });
    },
    websocket: {
      message(ws, message) {
        if (message === "close") ws.close(4001, "bye");
        else ws.send(message);
      },
      close(_ws, code, reason) {
        selkies.closes.push({ code, reason });
      },
    },
  });

  upstream = `http://127.0.0.1:${selkiesServer.port}`;

  orchestratorServer = Bun.serve<{ tunnelId: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      orchestrator.hits.push(url.pathname);
      const match = /^\/agent\/tunnel\/([^/]+)$/.exec(url.pathname);
      if (match === null) return new Response("Not Found", { status: 404 });
      const tunnelId = decodeURIComponent(match[1]!);
      orchestrator.channels.set(tunnelId, {
        authorization: request.headers.get("authorization"),
        received: [],
      });
      return server.upgrade(request, { data: { tunnelId } })
        ? undefined
        : new Response("Expected WebSocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        const channel = orchestrator.channels.get(ws.data.tunnelId)!;
        channel.socket = ws;
        for (const message of orchestrator.scripts.get(ws.data.tunnelId) ?? [])
          ws.send(message);
      },
      message(ws, message) {
        orchestrator.channels
          .get(ws.data.tunnelId)!
          .received.push(
            typeof message === "string" ? message : new Uint8Array(message),
          );
      },
      close(ws, code, reason) {
        orchestrator.channels.get(ws.data.tunnelId)!.close = { code, reason };
      },
    },
  });

  runtime = ManagedRuntime.make(
    TunnelClient.layer.pipe(
      Layer.provide(Layer.succeed(SessionSupervisor, supervisor)),
      Layer.provide(
        Layer.succeed(
          AgentConfig,
          testConfig({
            orchestratorUrl: `ws://127.0.0.1:${orchestratorServer.port}/agent`,
            workerToken: Redacted.make(token),
          }),
        ),
      ),
      Layer.provide(Layer.succeed(TunnelUpstream, () => upstream)),
      Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Error")),
    ),
  );
});

afterAll(async () => {
  await runtime.dispose();
  selkiesServer.stop(true);
  orchestratorServer.stop(true);
});

beforeEach(() => {
  selkies.requests.length = 0;
  selkies.closes.length = 0;
  orchestrator.hits.length = 0;
});

/** Тоннель агента в фоне; промис — его завершение. */
const openTunnel = (tunnelId: string, sessionId: string) =>
  runtime.runPromise(
    TunnelClient.use((client) => client.open({ tunnelId, sessionId })),
  );

/**
 * HTTP-тоннель целиком: агент закончил, и фейковый оркестратор увидел
 * закрытие канала (его сообщения к этому моменту уже приняты).
 */
const serveHttp = async (tunnelId: string, sessionId: string) => {
  await openTunnel(tunnelId, sessionId);
  await until(() => orchestrator.channels.get(tunnelId)?.close !== undefined);
  return orchestrator.channels.get(tunnelId)!;
};

/** Управляющее сообщение агента по номеру среди принятых. */
const controlAt = (channel: Channel, index: number): TunnelControl => {
  const message = channel.received[index];
  if (typeof message !== "string") throw new Error(`no text at ${index}`);
  return Option.getOrThrow(decodeTunnelControl(message));
};

const bodyOf = (channel: Channel) =>
  channel.received
    .slice(1)
    .map((m) => (typeof m === "string" ? `<text ${m}>` : decoder.decode(m)))
    .join("");

describe("TunnelClient", () => {
  it("serves an HTTP request from Selkies", async () => {
    orchestrator.scripts.set("t-http", [
      encodeTunnelControl({
        kind: "http",
        method: "GET",
        path: "/index.html?x=1",
        headers: [
          ["accept", "text/html"],
          ["host", "relay:3002"],
          ["origin", "https://gamecrate.example"],
          ["connection", "keep-alive"],
          ["x-forwarded-for", "198.51.100.1"],
        ],
        hasBody: false,
      }),
    ]);
    const channel = await serveHttp("t-http", live);

    expect(selkies.requests).toHaveLength(1);
    const request = selkies.requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/index.html?x=1");
    expect(request.headers.accept).toBe("text/html");
    expect(request.headers["x-forwarded-for"]).toBe("198.51.100.1");
    // Host — адрес Selkies (ставит fetch), Origin не передаётся: Selkies
    // отвечает 403 на чужой Origin с Host контейнера.
    expect(request.headers.host).toBe(`127.0.0.1:${selkiesServer.port}`);
    expect(request.headers.origin).toBeUndefined();

    const response = controlAt(channel, 0);
    expect(response.kind).toBe("response");
    if (response.kind !== "response") return;
    expect(response.status).toBe(200);
    expect(response.headers).toContainEqual([
      "content-type",
      "text/html; charset=utf-8",
    ]);
    expect(response.headers).toContainEqual(["x-selkies", "fake"]);
    // Повторяющиеся `set-cookie` не склеиваются.
    expect(response.headers).toContainEqual(["set-cookie", "a=1"]);
    expect(response.headers).toContainEqual(["set-cookie", "b=2"]);
    expect(bodyOf(channel)).toBe("<html>stream</html>");
    expect(
      channel.received.slice(1).every((m) => m instanceof Uint8Array),
    ).toBe(true);
    expect(channel.close?.code).toBe(1000);
  });

  it("forwards a request body and does not follow redirects", async () => {
    orchestrator.scripts.set("t-post", [
      encodeTunnelControl({
        kind: "http",
        method: "POST",
        path: "/api",
        headers: [["content-type", "text/plain"]],
        hasBody: true,
      }),
      encoder.encode("ping"),
    ]);
    orchestrator.scripts.set("t-redirect", [
      encodeTunnelControl({
        kind: "http",
        method: "GET",
        path: "/redirect",
        headers: [],
        hasBody: false,
      }),
    ]);
    const post = await serveHttp("t-post", live);
    const redirect = await serveHttp("t-redirect", live);

    expect(selkies.requests[0]).toMatchObject({ method: "POST", body: "ping" });
    expect(controlAt(post, 0)).toMatchObject({ kind: "response", status: 201 });
    expect(bodyOf(post)).toBe("got ping");
    expect(post.close?.code).toBe(1000);

    // Редирект — ответ как есть, без перехода по `location`.
    expect(controlAt(redirect, 0)).toMatchObject({
      kind: "response",
      status: 302,
      headers: expect.arrayContaining([["location", "/index.html"]]),
    });
    expect(selkies.requests.map((r) => r.path)).toEqual(["/api", "/redirect"]);
  });

  it("answers an error and closes 1011 when Selkies is down", async () => {
    orchestrator.scripts.set("t-down", [
      encodeTunnelControl({
        kind: "http",
        method: "GET",
        path: "/",
        headers: [],
        hasBody: false,
      }),
    ]);
    const selkiesUp = upstream;
    // Порт, на котором никто не слушает.
    upstream = "http://127.0.0.1:1";
    try {
      await openTunnel("t-down", live);
    } finally {
      upstream = selkiesUp;
    }
    await until(() => orchestrator.channels.get("t-down")?.close !== undefined);
    const channel = orchestrator.channels.get("t-down")!;
    expect(controlAt(channel, 0).kind).toBe("error");
    expect(channel.received).toHaveLength(1);
    expect(channel.close?.code).toBe(1011);
  });

  it("never leaves the Selkies of the session (SSRF)", async () => {
    for (const [tunnelId, path] of [
      ["t-ssrf-1", "//evil.example/x"],
      ["t-ssrf-2", "@evil.example/x"],
    ] as const)
      orchestrator.scripts.set(tunnelId, [
        encodeTunnelControl({
          kind: "http",
          method: "GET",
          path,
          headers: [],
          hasBody: false,
        }),
      ]);
    for (const tunnelId of ["t-ssrf-1", "t-ssrf-2"]) {
      const channel = await serveHttp(tunnelId, live);
      expect(controlAt(channel, 0).kind).toBe("error");
      expect(channel.close?.code).toBe(1011);
    }
    expect(selkies.requests).toEqual([]);
  });

  it("bridges a WebSocket and mirrors close codes", async () => {
    orchestrator.scripts.set("t-ws", [
      encodeTunnelControl({
        kind: "ws",
        path: "/websocket?token=1",
        headers: [
          ["user-agent", "relay-test"],
          ["origin", "https://gamecrate.example"],
        ],
        protocols: ["other", "selkies"],
      }),
    ]);
    const done = openTunnel("t-ws", live);
    await until(
      () => (orchestrator.channels.get("t-ws")?.received.length ?? 0) >= 1,
    );
    const channel = orchestrator.channels.get("t-ws")!;
    expect(controlAt(channel, 0)).toEqual({
      kind: "open",
      protocol: "selkies",
    });
    expect(selkies.requests[0]).toMatchObject({
      method: "WS",
      path: "/websocket?token=1",
    });
    expect(selkies.requests[0]!.headers["user-agent"]).toBe("relay-test");
    expect(selkies.requests[0]!.headers.origin).toBeUndefined();

    // Кадры 1:1: текст — текстом, бинарное — бинарным.
    channel.socket!.send("hello");
    channel.socket!.send(encoder.encode("bin"));
    await until(() => channel.received.length >= 3);
    expect(channel.received[1]).toBe("hello");
    expect(channel.received[2]).toBeInstanceOf(Uint8Array);
    expect(decoder.decode(channel.received[2] as Uint8Array)).toBe("bin");

    // Selkies закрылся 4001 «bye» — канал закрыт тем же кодом и причиной.
    channel.socket!.send("close");
    await done;
    await until(() => channel.close !== undefined);
    expect(channel.close).toEqual({ code: 4001, reason: "bye" });

    // И наоборот: оркестратор закрыл канал 4002 — Selkies видит 4002.
    orchestrator.scripts.set("t-ws2", [
      encodeTunnelControl({
        kind: "ws",
        path: "/websocket",
        headers: [],
        protocols: [],
      }),
    ]);
    selkies.closes.length = 0;
    const second = openTunnel("t-ws2", live);
    await until(
      () => (orchestrator.channels.get("t-ws2")?.received.length ?? 0) >= 1,
    );
    const channel2 = orchestrator.channels.get("t-ws2")!;
    expect(controlAt(channel2, 0)).toEqual({ kind: "open", protocol: "" });
    channel2.socket!.close(4002, "api gone");
    await second;
    await until(() => selkies.closes.length > 0);
    expect(selkies.closes[0]).toEqual({ code: 4002, reason: "api gone" });
  });

  it("refuses a session it does not run", async () => {
    orchestrator.scripts.set("t-foreign", [
      encodeTunnelControl({
        kind: "http",
        method: "GET",
        path: "/",
        headers: [],
        hasBody: false,
      }),
    ]);
    await openTunnel("t-foreign", foreign);
    await Bun.sleep(50);
    // Канал не открыт, к Selkies никто не ходил.
    expect(orchestrator.hits).toEqual([]);
    expect(orchestrator.channels.has("t-foreign")).toBe(false);
    expect(selkies.requests).toEqual([]);
  });

  it("sends the worker token when dialing", async () => {
    orchestrator.scripts.set("t-token", [
      encodeTunnelControl({
        kind: "http",
        method: "GET",
        path: "/",
        headers: [],
        hasBody: false,
      }),
    ]);
    await serveHttp("t-token", live);
    expect(orchestrator.hits).toEqual(["/agent/tunnel/t-token"]);
    expect(orchestrator.channels.get("t-token")!.authorization).toBe(
      `Bearer ${token}`,
    );
  });
});
