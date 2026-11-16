import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, migrationsFolder } from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  AdminRpcs,
  AuthRpcs,
  type CurrentUserShape,
  PublicAuthRpcs,
} from "@cg/rpc";
import { BunHttpServer } from "@effect/platform-bun";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
import {
  type Auth,
  BetterAuth,
  makeAuth,
  pocketIdRole,
} from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { AuthRpcHandlers, PublicAuthRpcHandlers } from "../src/auth/rpc";
import { AppConfig, type AppConfigValues, appConfig } from "../src/config";
import { HttpApp } from "../src/http";
import { OwnGameCatalog } from "../src/library/OwnGameCatalog";
import { Mailer } from "../src/mail/Mailer";
import { ProtonDb } from "../src/steam/ProtonDb";
import { SteamStoreApi } from "../src/steam/SteamStoreApi";
import { SteamApi } from "../src/steam/SteamApi";

const player: CurrentUserShape = {
  id: "u-player",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: "76561197960287930",
  email: "ivan@example.com",
  emailVerified: true,
};
const admin: CurrentUserShape = {
  id: "u-admin",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};

/** Better Auth-заглушка: сессия — заданный пользователь (или её нет). */
const fakeAuth = (user: CurrentUserShape | null) =>
  Layer.succeed(BetterAuth, {
    handler: async (request: Request) =>
      new Response(`auth:${new URL(request.url).pathname}`),
    currentUser: () => Effect.succeed(Option.fromNullishOr(user)),
  });

// admin.settings.* требуют Db; admin.ping и auth.me её не трогают.
const rpcLayer = (user: CurrentUserShape | null) =>
  Layer.mergeAll(AdminRpcHandlers, AuthRpcHandlers, RpcMiddlewares).pipe(
    Layer.provide(fakeAuth(user)),
    Layer.provide(OwnGameCatalog.fromManifests([])),
    // Заглушка без методов: эти тесты не обращаются к БД.
    Layer.provide(Layer.succeed(Db, {} as Db["Service"])),
  );

const adminPing = (user: CurrentUserShape | null) =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(AdminRpcs);
    return yield* client["admin.ping"]();
  }).pipe(Effect.scoped, Effect.provide(rpcLayer(user)), Effect.result);

describe("roles", () => {
  it("pocket id user without group gets role player", () => {
    expect(pocketIdRole(["users"], "cloud_gaming_admins")).toBe("player");
    expect(pocketIdRole(undefined, "cloud_gaming_admins")).toBe("player");
  });

  it("pocket id user in group gets role admin", () =>
    expect(pocketIdRole(["cloud_gaming_admins"], "cloud_gaming_admins")).toBe(
      "admin",
    ));
});

describe("rpc auth", () => {
  it("admin rpc rejects player", async () => {
    const result = await Effect.runPromise(adminPing(player));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure._tag).toBe("Forbidden");
  });

  it("admin rpc accepts admin", async () => {
    const result = await Effect.runPromise(adminPing(admin));
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success).toBe("pong");
  });

  it("rpc without session is Unauthorized", async () => {
    const result = await Effect.runPromise(adminPing(null));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure._tag).toBe("Unauthorized");
  });

  it("auth.me returns the session user", async () => {
    const me = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(AuthRpcs);
        return yield* client["auth.me"]();
      }).pipe(Effect.scoped, Effect.provide(rpcLayer(player))),
    );
    expect(me).toEqual(player);
  });

  it("auth.me returns email fields", async () => {
    const me = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(AuthRpcs);
        return yield* client["auth.me"]();
      }).pipe(Effect.scoped, Effect.provide(rpcLayer(player))),
    );
    expect(me.email).toBe("ivan@example.com");
    expect(me.emailVerified).toBe(true);
  });
});

/** Конфиг для `PublicAuthRpcHandlers`: значения, кроме провайдеров, не важны. */
const providersConfig = (
  overrides: Partial<AppConfigValues>,
): AppConfigValues => ({
  port: 0,
  publicUrl: "http://localhost:3000/app",
  databaseUrl: Redacted.make("postgres://unused"),
  steamApiKey: Redacted.make("unused"),
  authSecret: Redacted.make("unused"),
  pocketIdUrl: "https://sso.example.invalid",
  pocketIdClientId: "unused",
  pocketIdClientSecret: Redacted.make("unused"),
  pocketIdAdminGroup: "cloud_gaming_admins",
  allowedOrigins: [],
  brandHosts: new Map(),
  oauthHosts: {
    google: new Set(["localhost"]),
    yandex: new Set(["localhost"]),
    pocketId: new Set(["localhost"]),
    telegram: new Set(["localhost"]),
  },
  orchestratorRelayUrl: "http://cg-orchestrator:3002",
  relaySecret: Redacted.make("test-relay-secret-test-relay-secret-0001"),
  webDistDir: "unused",
  ownGamesDir: "unused",
  smtpUrl: Redacted.make("log://"),
  mailFrom: "GameCrate <test@example.com>",
  google: Option.none(),
  yandex: Option.none(),
  telegram: Option.none(),
  ...overrides,
});

describe("rpc auth.providers", () => {
  it("reflects config", async () => {
    const config = providersConfig({
      google: Option.some({
        clientId: "g-id",
        clientSecret: Redacted.make("g-secret"),
      }),
      yandex: Option.none(),
      telegram: Option.some({
        clientId: "123456",
        clientSecret: Redacted.make("t-secret"),
      }),
    });
    const layer = PublicAuthRpcHandlers.pipe(
      Layer.provide(Layer.succeed(AppConfig, config)),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(PublicAuthRpcs);
        return yield* client["auth.providers"]();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
    expect(result).toEqual({
      google: true,
      yandex: false,
      pocketId: true,
      telegram: true,
    });
  });

  // Нет сессии (fakeAuth(null)) — RPC без AuthMiddleware, Unauthorized не возникает.
  it("works without a session", async () => {
    const layer = Layer.mergeAll(PublicAuthRpcHandlers, RpcMiddlewares).pipe(
      Layer.provide(fakeAuth(null)),
      Layer.provide(Layer.succeed(AppConfig, providersConfig({}))),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(PublicAuthRpcs);
        return yield* client["auth.providers"]();
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.result),
    );
    expect(result._tag).toBe("Success");
  });
});

/** Зависимости `HttpApp` без сессии; `webDistDir` — папка SPA. */
const appDeps = (webDistDir: string) =>
  Layer.mergeAll(
    fakeAuth(null),
    // Зависимости хендлеров library.* (в этих тестах не вызываются).
    DbTest,
    Layer.mock(SteamApi)({}),
    Layer.mock(ProtonDb)({}),
    Layer.mock(SteamStoreApi)({}),
    OwnGameCatalog.fromManifests([]),
    Layer.succeed(Mailer, { send: () => Effect.void }),
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(AppConfig, {
        port: 0,
        publicUrl: "http://localhost:3000/app",
        databaseUrl: Redacted.make("postgres://unused"),
        steamApiKey: Redacted.make("unused"),
        authSecret: Redacted.make("unused"),
        pocketIdUrl: "https://sso.example.invalid",
        pocketIdClientId: "unused",
        pocketIdClientSecret: Redacted.make("unused"),
        pocketIdAdminGroup: "cloud_gaming_admins",
        allowedOrigins: ["http://localhost:5173"],
        brandHosts: new Map(),
        oauthHosts: {
          google: new Set(["localhost"]),
          yandex: new Set(["localhost"]),
          pocketId: new Set(["localhost"]),
          telegram: new Set(["localhost"]),
        },
        orchestratorRelayUrl: "http://cg-orchestrator:3002",
        relaySecret: Redacted.make("test-relay-secret-test-relay-secret-0001"),
        webDistDir,
        ownGamesDir: "unused",
        smtpUrl: Redacted.make("log://"),
        mailFrom: "GameCrate <test@example.com>",
        google: Option.none(),
        yandex: Option.none(),
        telegram: Option.none(),
      }),
    ),
  );

/** Заголовки апгрейда WebSocket на `/rpc` (как у браузера). */
const upgradeHeaders = (origin?: string) => ({
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  ...(origin === undefined ? {} : { origin }),
});

/** Сырой апгрейд `/rpc` по TCP: возвращает статусную строку ответа сервера. */
const rawUpgrade = (port: number, origin?: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const headers = Object.entries(upgradeHeaders(origin)).map(
        ([name, value]) => `${name}: ${value}`,
      );
      socket.write(
        [
          "GET /rpc HTTP/1.1",
          `host: 127.0.0.1:${port}`,
          ...headers,
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

describe("http", () => {
  let webDistDir: string;
  let app: ReturnType<typeof makeHandler>;

  const makeHandler = (dir: string) =>
    HttpRouter.toWebHandler(
      HttpApp.pipe(
        Layer.provide(appDeps(dir)),
        Layer.provide(BunHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );

  beforeAll(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "cg-web-"));
    await writeFile(join(webDistDir, "index.html"), "<p>spa</p>");
    app = makeHandler(webDistDir);
  });
  afterAll(async () => {
    await app.dispose();
    await rm(webDistDir, { recursive: true, force: true });
  });

  it("GET /healthz returns 200", async () => {
    const response = await app.handler(new Request("http://localhost/healthz"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("/api/auth/* is handled by better auth", async () => {
    const response = await app.handler(
      new Request("http://localhost/api/auth/steam/login", { method: "POST" }),
    );
    expect(await response.text()).toBe("auth:/api/auth/steam/login");
  });

  it("unknown page falls back to index.html", async () => {
    const response = await app.handler(
      new Request("http://localhost/library", {
        headers: { accept: "text/html" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>spa</p>");
  });

  it("/rpc upgrade with a foreign Origin is 403", async () => {
    const response = await app.handler(
      new Request("http://localhost/rpc", {
        headers: upgradeHeaders("https://evil.brofrong.ru"),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("/rpc upgrade without Origin is 403", async () => {
    const response = await app.handler(
      new Request("http://localhost/rpc", { headers: upgradeHeaders() }),
    );
    expect(response.status).toBe(403);
  });
});

describe("rpc websocket origin (real server)", () => {
  let webDistDir: string;
  let runtime: ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>;
  let port: number;

  beforeAll(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "cg-web-"));
    runtime = ManagedRuntime.make(
      HttpRouter.serve(HttpApp, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provide(appDeps(webDistDir)),
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
  });
  afterAll(async () => {
    await runtime.dispose();
    await rm(webDistDir, { recursive: true, force: true });
  });

  it("origin of PUBLIC_URL upgrades (101)", async () => {
    expect(await rawUpgrade(port, "http://localhost:3000")).toContain(" 101 ");
  });

  it("origin from ALLOWED_ORIGINS upgrades (101)", async () => {
    expect(await rawUpgrade(port, "http://localhost:5173")).toContain(" 101 ");
  });

  it("foreign origin gets 403 and no upgrade", async () => {
    expect(await rawUpgrade(port, "https://evil.brofrong.ru")).toContain(
      " 403 ",
    );
  });

  it("missing origin gets 403 and no upgrade", async () => {
    expect(await rawUpgrade(port)).toContain(" 403 ");
  });
});

describe("config ALLOWED_ORIGINS", () => {
  const base = {
    PUBLIC_URL: "https://game.brofrong.ru",
    DATABASE_URL: "postgres://unused",
    STEAM_API_KEY: "unused",
    BETTER_AUTH_SECRET: "unused",
    POCKET_ID_URL: "https://sso.example.invalid",
    POCKET_ID_CLIENT_ID: "unused",
    POCKET_ID_CLIENT_SECRET: "unused",
    POCKET_ID_ADMIN_GROUP: "admins",
    WEB_DIST_DIR: "unused",
    SMTP_URL: "log://",
    MAIL_FROM: "GameCrate <test@example.com>",
    RELAY_SECRET: "test-relay-secret-test-relay-secret-0001",
  };

  it("defaults to no extra origins", async () => {
    const config = await Effect.runPromise(
      appConfig.parse(ConfigProvider.fromUnknown(base)),
    );
    expect(config.allowedOrigins).toEqual([]);
  });

  it("splits a comma-separated list", async () => {
    const config = await Effect.runPromise(
      appConfig.parse(
        ConfigProvider.fromUnknown({
          ...base,
          ALLOWED_ORIGINS: " http://localhost:5173/ , https://a.example ,",
        }),
      ),
    );
    expect(config.allowedOrigins).toEqual([
      "http://localhost:5173",
      "https://a.example",
    ]);
  });
});

describe("oauth redirect_uri follows the request host (real better auth)", () => {
  const serverUrl = process.env["TEST_DATABASE_URL"];
  if (!serverUrl) throw new Error("TEST_DATABASE_URL is not set");
  const database = `cg_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = Object.assign(new URL(serverUrl), {
    pathname: `/${database}`,
  }).toString();

  let adminDb: SQL;
  let db: SQL;
  let idp: ReturnType<typeof Bun.serve>;
  let auth: Auth;

  beforeAll(async () => {
    adminDb = new SQL(serverUrl);
    await adminDb.unsafe(`CREATE DATABASE "${database}"`);
    db = new SQL(databaseUrl);
    await migrate(drizzle({ client: db }), { migrationsFolder });
    // Фейковый Pocket ID: только discovery, до обмена кода дело не доходит.
    idp = Bun.serve({
      port: 0,
      fetch: (request) => {
        const base = `http://127.0.0.1:${idp.port}`;
        if (new URL(request.url).pathname.endsWith("/openid-configuration")) {
          return Response.json({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            userinfo_endpoint: `${base}/userinfo`,
            jwks_uri: `${base}/jwks`,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    auth = makeAuth(
      providersConfig({
        publicUrl: "https://game.x.ru",
        databaseUrl: Redacted.make(databaseUrl),
        authSecret: Redacted.make("test-secret-test-secret-test-secret-0123"),
        pocketIdUrl: `http://127.0.0.1:${idp.port}`,
        brandHosts: new Map([["play.beeline.ru", "beeline"]]),
      }),
    );
  });
  afterAll(async () => {
    await idp?.stop(true);
    await db?.close();
    await adminDb?.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await adminDb?.close();
  });

  /** `redirect_uri` из адреса провайдера, который Better Auth вернул на вход через Pocket ID. */
  const redirectUri = async (headers: Record<string, string>) => {
    const response = await auth.handler(
      new Request("http://cg-api:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          origin: "https://game.x.ru",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ provider: "pocket-id", callbackURL: "/app" }),
      }),
    );
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const value = new URL(url).searchParams.get("redirect_uri");
    if (value === null) throw new Error("no redirect_uri in provider url");
    return value;
  };

  it("brand host in Host gets its own redirect_uri", async () => {
    expect(
      await redirectUri({
        host: "play.beeline.ru",
        "x-forwarded-proto": "https",
      }),
    ).toStartWith("https://play.beeline.ru/api/auth/");
  });

  it("brand host in x-forwarded-host (reverse proxy) gets its own redirect_uri", async () => {
    expect(
      await redirectUri({
        host: "cg-api:3000",
        "x-forwarded-host": "play.beeline.ru",
        "x-forwarded-proto": "https",
      }),
    ).toStartWith("https://play.beeline.ru/api/auth/");
  });

  it("main host keeps PUBLIC_URL", async () => {
    expect(
      await redirectUri({ host: "game.x.ru", "x-forwarded-proto": "https" }),
    ).toStartWith("https://game.x.ru/api/auth/");
  });

  it("https PUBLIC_URL: redirect_uri stays https without x-forwarded-proto", async () => {
    expect(
      await redirectUri({
        host: "cg-api:3000",
        "x-forwarded-host": "play.beeline.ru",
      }),
    ).toStartWith("https://play.beeline.ru/api/auth/");
    expect(await redirectUri({ host: "game.x.ru" })).toStartWith(
      "https://game.x.ru/api/auth/",
    );
  });

  it("https PUBLIC_URL: session cookie keeps __Secure- name and Secure (as before multi-host)", async () => {
    const { sessionToken } = (await auth.$context).authCookies;
    expect(sessionToken.name).toBe("__Secure-better-auth.session_token");
    expect(sessionToken.attributes.secure).toBe(true);
  });

  it("foreign host falls back to PUBLIC_URL", async () => {
    for (const headers of [
      { host: "evil.ru", "x-forwarded-proto": "https" },
      {
        host: "cg-api:3000",
        "x-forwarded-host": "evil.ru",
        "x-forwarded-proto": "https",
      },
    ]) {
      expect(await redirectUri(headers)).toStartWith(
        "https://game.x.ru/api/auth/",
      );
    }
  });
});
