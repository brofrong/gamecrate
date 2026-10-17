import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbTest } from "@cg/db/test";
import { AdminRpcs, AuthRpcs, type CurrentUserShape } from "@cg/rpc";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
import { BetterAuth, pocketIdRole } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { AuthRpcHandlers } from "../src/auth/rpc";
import { AppConfig } from "../src/config";
import { HttpApp } from "../src/http";
import { ProtonDb } from "../src/steam/ProtonDb";
import { SteamApi } from "../src/steam/SteamApi";

const player: CurrentUserShape = {
  id: "u-player",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: "76561197960287930",
};
const admin: CurrentUserShape = {
  id: "u-admin",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
};

/** Better Auth-заглушка: сессия — заданный пользователь (или её нет). */
const fakeAuth = (user: CurrentUserShape | null) =>
  Layer.succeed(BetterAuth, {
    handler: async (request: Request) =>
      new Response(`auth:${new URL(request.url).pathname}`),
    currentUser: () => Effect.succeed(Option.fromNullishOr(user)),
  });

const rpcLayer = (user: CurrentUserShape | null) =>
  Layer.mergeAll(AdminRpcHandlers, AuthRpcHandlers, RpcMiddlewares).pipe(
    Layer.provide(fakeAuth(user)),
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
});

describe("http", () => {
  let webDistDir: string;
  let app: ReturnType<typeof makeHandler>;

  const makeHandler = (dir: string) =>
    HttpRouter.toWebHandler(
      HttpApp.pipe(
        Layer.provide(fakeAuth(null)),
        // Зависимости хендлеров library.* (в этих тестах не вызываются).
        Layer.provide(
          Layer.mergeAll(
            DbTest,
            Layer.mock(SteamApi)({}),
            Layer.mock(ProtonDb)({}),
          ),
        ),
        Layer.provide(
          Layer.succeed(AppConfig, {
            port: 0,
            publicUrl: "http://localhost:3000",
            databaseUrl: Redacted.make("postgres://unused"),
            steamApiKey: Redacted.make("unused"),
            authSecret: Redacted.make("unused"),
            pocketIdUrl: "https://sso.example.invalid",
            pocketIdClientId: "unused",
            pocketIdClientSecret: Redacted.make("unused"),
            pocketIdAdminGroup: "cloud_gaming_admins",
            webDistDir: dir,
          }),
        ),
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
});
