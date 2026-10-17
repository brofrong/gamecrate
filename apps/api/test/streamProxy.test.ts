// Прокси стрима `/stream/<id>/*` на реальном Bun-сервере: HTTP и WebSocket до
// фейкового Selkies (Bun.serve с HTTP- и WS-эхо), проверка владельца и Origin.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, games, sessions, user, userGames } from "@cg/db";
import { DbTest } from "@cg/db/test";
import type { CurrentUserShape } from "@cg/rpc";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { BetterAuth } from "../src/auth/auth";
import { AppConfig } from "../src/config";
import { HttpApp } from "../src/http";
import { ProtonDb } from "../src/steam/ProtonDb";
import { SteamApi } from "../src/steam/SteamApi";

const player = (id: string): CurrentUserShape => ({
  id,
  name: id,
  image: null,
  role: "player",
  steamId: null,
});
const users: Record<string, CurrentUserShape> = {
  "sid=carol": player("u-carol"),
  "sid=dave": player("u-dave"),
  "sid=alice": player("u-alice"),
  "sid=bob": player("u-bob"),
};

/** Better Auth-заглушка: пользователь по cookie `sid=<имя>`. */
const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: (headers) =>
    Effect.succeed(
      Option.fromNullishOr(
        Object.entries(users).find(([cookie]) =>
          (headers["cookie"] ?? "").split(/;\s*/).includes(cookie),
        )?.[1],
      ),
    ),
});

const publicOrigin = "http://localhost:3000";

const appDeps = (webDistDir: string) =>
  Layer.mergeAll(
    fakeAuth,
    DbTest,
    Layer.mock(SteamApi)({}),
    Layer.mock(ProtonDb)({}),
    Layer.succeed(AppConfig, {
      port: 0,
      publicUrl: `${publicOrigin}/app`,
      databaseUrl: Redacted.make("postgres://unused"),
      steamApiKey: Redacted.make("unused"),
      authSecret: Redacted.make("unused"),
      pocketIdUrl: "https://sso.example.invalid",
      pocketIdClientId: "unused",
      pocketIdClientSecret: Redacted.make("unused"),
      pocketIdAdminGroup: "cloud_gaming_admins",
      allowedOrigins: ["http://localhost:5173"],
      webDistDir,
    }),
  );

type Echo = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

/** Фейковый Selkies: HTTP-эхо запроса и WS-эхо (первое сообщение — заголовки апгрейда). */
const startUpstream = () =>
  Bun.serve<{ path: string; headers: Record<string, string> }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      if (
        server.upgrade(request, {
          data: { path: url.pathname + url.search, headers },
        })
      )
        return undefined;
      const echo: Echo = {
        method: request.method,
        path: url.pathname + url.search,
        headers,
        body: await request.text(),
      };
      return Response.json(echo, { headers: { "set-cookie": "evil=1" } });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify(ws.data));
      },
      message(ws, message) {
        ws.send(message);
      },
    },
  });

/** Сырой WS-апгрейд по TCP: статусная строка ответа сервера. */
const rawUpgrade = (
  port: number,
  path: string,
  headers: Record<string, string>,
) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = Object.entries({
        host: `127.0.0.1:${port}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      }).map(([name, value]) => `${name}: ${value}`);
      socket.write([`GET ${path} HTTP/1.1`, ...lines, "", ""].join("\r\n"));
    });
    socket.once("data", (data) => {
      resolve(data.toString().split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("error", reject);
  });

/** WebSocket-клиент Bun с заголовками; собирает сообщения. */
const openWs = (url: string, headers: Record<string, string>) =>
  new Promise<{
    ws: WebSocket;
    next: () => Promise<string | ArrayBuffer>;
  }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    const inbox: Array<string | ArrayBuffer> = [];
    const waiters: Array<(m: string | ArrayBuffer) => void> = [];
    ws.addEventListener("message", (event) => {
      const waiter = waiters.shift();
      if (waiter) waiter(event.data);
      else inbox.push(event.data);
    });
    const next = () =>
      new Promise<string | ArrayBuffer>((res) => {
        const message = inbox.shift();
        if (message !== undefined) res(message);
        else waiters.push(res);
      });
    ws.addEventListener("open", () => resolve({ ws, next }), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), {
      once: true,
    });
  });

describe("stream proxy", () => {
  let webDistDir: string;
  let upstream: ReturnType<typeof startUpstream>;
  let runtime: ManagedRuntime.ManagedRuntime<
    HttpServer.HttpServer | Db,
    unknown
  >;
  let port: number;
  const ids = {
    alice: crypto.randomUUID(),
    bob: crypto.randomUUID(),
    ended: crypto.randomUUID(),
    notReady: crypto.randomUUID(),
    down: crypto.randomUUID(),
  };

  beforeAll(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "cg-web-"));
    upstream = startUpstream();
    runtime = ManagedRuntime.make(
      HttpRouter.serve(HttpApp, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(appDeps(webDistDir)),
        Layer.provideMerge(
          BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }),
        ),
      ),
    );
    const address = await runtime.runPromise(
      HttpServer.HttpServer.useSync((server) => server.address),
    );
    if (!("port" in address)) throw new Error("expected a TCP address");
    port = address.port;

    // Порт, на котором никто не слушает: апстрим ещё не поднялся.
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const closedPort = closed.port;
    await closed.stop(true);

    const streamUrl = `http://127.0.0.1:${upstream.port}`;
    // Одна активная сессия на пользователя: у каждого случая свой пользователь.
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(user).values(
          ["u-alice", "u-bob", "u-carol", "u-dave"].map((id) => ({
            id,
            name: id,
            email: `${id}@example.test`,
          })),
        );
        yield* db.insert(games).values({ appId: 10, name: "Hades" });
        yield* db.insert(userGames).values([
          { userId: "u-alice", appId: 10 },
          { userId: "u-bob", appId: 10 },
        ]);
        const row = (id: string, userId: string) => ({
          id,
          userId,
          appId: 10,
          state: "playing" as const,
          streamUrl,
        });
        yield* db.insert(sessions).values([
          row(ids.alice, "u-alice"),
          row(ids.bob, "u-bob"),
          {
            ...row(ids.ended, "u-alice"),
            state: "ended",
            endedAt: new Date(),
          },
          {
            ...row(ids.notReady, "u-carol"),
            state: "starting",
            streamUrl: null,
          },
          // Апстрим ещё не поднялся (никто не слушает порт).
          {
            ...row(ids.down, "u-dave"),
            streamUrl: `http://127.0.0.1:${closedPort}`,
          },
        ]);
      }),
    );
  });

  afterAll(async () => {
    await runtime.dispose();
    await upstream.stop(true);
    await rm(webDistDir, { recursive: true, force: true });
  });

  const http = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", ...init });

  it("stream proxy forwards http and websocket for owner", async () => {
    // GET: путь без префикса /stream/<id>, query сохраняется.
    const get = await http(`/stream/${ids.alice}/api/status?x=1`, {
      headers: { cookie: "sid=alice; other=2", origin: publicOrigin },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("set-cookie")).toBeNull();
    const echo = (await get.json()) as Echo;
    expect(echo.method).toBe("GET");
    expect(echo.path).toBe("/api/status?x=1");
    expect(echo.headers["host"]).toBe(`127.0.0.1:${upstream.port}`);
    expect(echo.headers["cookie"]).toBeUndefined();
    expect(echo.headers["origin"]).toBeUndefined();

    // Корень стрима.
    const root = await http(`/stream/${ids.alice}/`, {
      headers: { cookie: "sid=alice" },
    });
    expect(((await root.json()) as Echo).path).toBe("/");

    // Без завершающего слэша — редирект (клиент Selkies строит URL от своего пути).
    const bare = await http(`/stream/${ids.alice}?a=b`, {
      headers: { cookie: "sid=alice" },
    });
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe(`/stream/${ids.alice}/?a=b`);

    // POST с телом и разрешённым Origin.
    const post = await http(`/stream/${ids.alice}/api/mode`, {
      method: "POST",
      headers: {
        cookie: "sid=alice",
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "webrtc" }),
    });
    expect(post.status).toBe(200);
    const postEcho = (await post.json()) as Echo;
    expect(postEcho.method).toBe("POST");
    expect(postEcho.body).toBe('{"mode":"webrtc"}');
    expect(postEcho.headers["origin"]).toBeUndefined();

    // WebSocket: апгрейд, эхо текста и бинарных кадров.
    const { ws, next } = await openWs(
      `ws://127.0.0.1:${port}/stream/${ids.alice}/api/webrtc/signaling?s=1`,
      { cookie: "sid=alice", origin: publicOrigin },
    );
    const hello = JSON.parse(String(await next())) as {
      path: string;
      headers: Record<string, string>;
    };
    expect(hello.path).toBe("/api/webrtc/signaling?s=1");
    expect(hello.headers["host"]).toBe(`127.0.0.1:${upstream.port}`);
    expect(hello.headers["origin"]).toBeUndefined();
    expect(hello.headers["cookie"]).toBeUndefined();
    ws.send("ping");
    expect(await next()).toBe("ping");
    ws.send(new Uint8Array([1, 2, 3]));
    expect(Array.from(new Uint8Array((await next()) as ArrayBuffer))).toEqual([
      1, 2, 3,
    ]);
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (event) => resolve(event.code)),
    );
    ws.close(1000);
    expect(await closed).toBe(1000);
  });

  it("stream proxy rejects foreign session", async () => {
    const status = async (path: string, headers: Record<string, string>) =>
      (await http(path, { headers })).status;
    const alicePath = `/stream/${ids.alice}/api/status`;

    // Чужой пользователь, без cookie, несуществующая сессия.
    expect(await status(alicePath, { cookie: "sid=bob" })).toBe(403);
    expect(await status(alicePath, {})).toBe(403);
    expect(
      await status(`/stream/${crypto.randomUUID()}/`, { cookie: "sid=alice" }),
    ).toBe(403);
    // Завершённая сессия и стрим ещё не готов.
    expect(await status(`/stream/${ids.ended}/`, { cookie: "sid=alice" })).toBe(
      403,
    );
    expect(
      await status(`/stream/${ids.notReady}/`, { cookie: "sid=carol" }),
    ).toBe(403);
    // POST с чужим Origin (CSRF с соседнего поддомена).
    expect(
      (
        await http(`/stream/${ids.alice}/api/mode`, {
          method: "POST",
          headers: { cookie: "sid=alice", origin: "https://evil.brofrong.ru" },
          body: "{}",
        })
      ).status,
    ).toBe(403);

    // WebSocket: чужой Origin, без Origin, чужая сессия, без cookie → 403 без апгрейда.
    const wsPath = `/stream/${ids.alice}/api/webrtc/signaling`;
    expect(
      await rawUpgrade(port, wsPath, {
        cookie: "sid=alice",
        origin: "https://evil.brofrong.ru",
      }),
    ).toContain(" 403 ");
    expect(await rawUpgrade(port, wsPath, { cookie: "sid=alice" })).toContain(
      " 403 ",
    );
    expect(
      await rawUpgrade(port, wsPath, {
        cookie: "sid=bob",
        origin: publicOrigin,
      }),
    ).toContain(" 403 ");
    expect(await rawUpgrade(port, wsPath, { origin: publicOrigin })).toContain(
      " 403 ",
    );
    // Контроль: свой Origin и cookie → 101.
    expect(
      await rawUpgrade(port, wsPath, {
        cookie: "sid=alice",
        origin: publicOrigin,
      }),
    ).toContain(" 101 ");
  });

  it("stream proxy answers 502 while the upstream is down", async () => {
    const get = await http(`/stream/${ids.down}/api/status`, {
      headers: { cookie: "sid=dave" },
    });
    expect(get.status).toBe(502);
    expect(
      await rawUpgrade(port, `/stream/${ids.down}/api/webrtc/signaling`, {
        cookie: "sid=dave",
        origin: publicOrigin,
      }),
    ).toContain(" 502 ");
    // Сервер жив после отказов апстрима.
    const ok = await http(`/stream/${ids.alice}/`, {
      headers: { cookie: "sid=alice" },
    });
    expect(ok.status).toBe(200);
  });
});
