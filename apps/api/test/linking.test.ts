// Привязка аккаунтов включена (Task 3): Steam — только привязка (Task 4), правило
// последнего способа входа при отвязке, роль Pocket ID при привязке/отвязке.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { account, migrationsFolder, session, user } from "@cg/db";
import { SQL } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { Option, Redacted } from "effect";
import { type Auth, makeAuth } from "../src/auth/auth";
import {
  fakeSteamFetch,
  steamId,
  steamOpenIdUrl,
  steamResponseParams,
} from "./steamFixtures";

const secret = "test-secret-test-secret-test-secret-0123";
const origin = "http://localhost:3000";
const serverUrl = process.env["TEST_DATABASE_URL"];
if (!serverUrl) throw new Error("TEST_DATABASE_URL is not set");
const database = `cg_test_${crypto.randomUUID().replaceAll("-", "")}`;
const databaseUrl = Object.assign(new URL(serverUrl), {
  pathname: `/${database}`,
}).toString();

/** Подписанное значение cookie сессии — как его ставит Better Auth (HMAC-SHA256, base64). */
const signCookie = async (value: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return encodeURIComponent(`${value}.${base64}`);
};

let admin: SQL;
let db: SQL;
let auth: Auth;
let adminCookie: string;
let mailCookie: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  admin = new SQL(serverUrl);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  db = new SQL(databaseUrl);
  const orm = drizzle({ client: db });
  await migrate(orm, { migrationsFolder });

  // Админ Pocket ID с активной сессией — подтверждённая настоящая почта (нужно
  // для теста "отвязка pocket-id" ниже: без неё отвязка последнего способа входа
  // была бы запрещена).
  await orm.insert(user).values({
    id: "u-admin",
    name: "Админ",
    email: "admin@example.com",
    emailVerified: true,
    role: "admin",
  });
  await orm.insert(session).values({
    id: "s-admin",
    token: "admin-session-token",
    userId: "u-admin",
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });
  await orm.insert(account).values({
    id: "acc-admin-pocket-id",
    accountId: "pocket-id-sub-admin",
    providerId: "pocket-id",
    userId: "u-admin",
    updatedAt: new Date(),
  });

  // Игрок с почтой (Google) и уже привязанным Steam — для правила последнего
  // способа входа. Steam-аккаунт здесь никак не связан со steamId из
  // steamFixtures (используется только в «уже привязан другому» ниже).
  await orm.insert(user).values({
    id: "u-mail",
    name: "Ivan",
    email: "ivan@example.com",
    emailVerified: true,
  });
  await orm.insert(session).values({
    id: "s-mail",
    token: "mail-session-token",
    userId: "u-mail",
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });
  await orm.insert(account).values([
    {
      id: "acc-mail-google",
      accountId: "google-sub-mail",
      providerId: "google",
      userId: "u-mail",
      updatedAt: new Date(),
    },
    {
      id: "acc-mail-steam",
      accountId: "76500000000000001",
      // "steam", не "steam-openid" — PROVIDER_ID в better-auth-steam@0.2.3
      // отличается от id плагина ("steam-openid"), которым он зарегистрирован
      // в `plugins` и под которым виден в `/callback/:id`.
      providerId: "steam",
      userId: "u-mail",
      updatedAt: new Date(),
    },
  ]);

  adminCookie = `better-auth.session_token=${await signCookie("admin-session-token")}`;
  mailCookie = `better-auth.session_token=${await signCookie("mail-session-token")}`;

  globalThis.fetch = Object.assign(fakeSteamFetch, {
    preconnect: realFetch.preconnect,
  });
  auth = makeAuth({
    port: 0,
    publicUrl: origin,
    databaseUrl: Redacted.make(databaseUrl),
    steamApiKey: Redacted.make("unused"),
    authSecret: Redacted.make(secret),
    pocketIdUrl: "http://127.0.0.1:9",
    pocketIdClientId: "unused",
    pocketIdClientSecret: Redacted.make("unused"),
    pocketIdAdminGroup: "cloud_gaming_admins",
    allowedOrigins: [],
    webDistDir: "unused",
    smtpUrl: Redacted.make("log://"),
    mailFrom: "GameCrate <test@example.com>",
    google: Option.none(),
    yandex: Option.none(),
    telegram: Option.none(),
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await db?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.close();
});

/** `/steam/link` → url Steam, `openid.return_to` и cookie для последующего callback. */
const steamLink = async (cookie: string, body: Record<string, unknown>) => {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/steam/link`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const parsed = (await response.json()) as { url?: string; code?: string };
  return { response, ...parsed };
};

describe("account linking", () => {
  it("steam login endpoint is gone", async () => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/steam/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(404);
    expect(body.code).toBe("STEAM_LOGIN_DISABLED");
  });

  it("steam link is allowed for a signed-in admin", async () => {
    const { response, url } = await steamLink(adminCookie, {
      callbackURL: "/admin",
    });
    expect(response.status).toBe(200);
    expect(url?.startsWith(steamOpenIdUrl)).toBe(true);
  });

  it("steam link callback sets steamId on the current user", async () => {
    const { response: link, url } = await steamLink(adminCookie, {
      callbackURL: "/profile",
    });
    expect(link.status).toBe(200);
    if (!url) throw new Error("no url");
    const returnTo = new URL(url).searchParams.get("openid.return_to");
    if (returnTo === null) throw new Error("no openid.return_to");
    const extraCookie = link.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const cookie = [adminCookie, extraCookie].filter(Boolean).join("; ");

    const callback = await auth.handler(
      new Request(`${returnTo}&${steamResponseParams(returnTo)}`, {
        headers: { cookie },
      }),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/profile");

    const orm = drizzle({ client: db });
    const [updatedUser] = await orm
      .select({ steamId: user.steamId })
      .from(user)
      .where(eq(user.id, "u-admin"));
    expect(updatedUser?.steamId).toBe(steamId);

    const [linkedAccount] = await orm
      .select({ userId: account.userId, providerId: account.providerId })
      .from(account)
      .where(eq(account.accountId, steamId));
    expect(linkedAccount?.userId).toBe("u-admin");
    expect(linkedAccount?.providerId).toBe("steam");
  });

  it("steam already linked to another user is refused", async () => {
    const { response: link, url } = await steamLink(mailCookie, {
      callbackURL: "/profile",
      errorCallbackURL: "/link-error",
    });
    expect(link.status).toBe(200);
    if (!url) throw new Error("no url");
    const returnTo = new URL(url).searchParams.get("openid.return_to");
    if (returnTo === null) throw new Error("no openid.return_to");
    const extraCookie = link.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const cookie = [mailCookie, extraCookie].filter(Boolean).join("; ");

    const callback = await auth.handler(
      new Request(`${returnTo}&${steamResponseParams(returnTo)}`, {
        headers: { cookie },
      }),
    );

    expect(callback.status).toBe(302);
    const location = callback.headers.get("location") ?? "";
    expect(location.startsWith("/link-error")).toBe(true);
    expect(new URL(location, origin).searchParams.get("error")).toBe(
      "STEAM_ACCOUNT_ALREADY_LINKED",
    );

    const [mailUser] = await drizzle({ client: db })
      .select({ steamId: user.steamId })
      .from(user)
      .where(eq(user.id, "u-mail"));
    expect(mailUser?.steamId).toBeNull();
  });

  it("unlinking the last login-capable method is refused", async () => {
    await drizzle({ client: db })
      .update(user)
      .set({ emailVerified: false })
      .where(eq(user.id, "u-mail"));

    const response = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: {
          cookie: mailCookie,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: "acc-mail-google",
          providerId: "google",
        }),
      }),
    );
    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("LAST_LOGIN_METHOD");

    const [stillThere] = await drizzle({ client: db })
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, "acc-mail-google"));
    expect(stillThere?.id).toBe("acc-mail-google");
  });

  it("a body without providerId still enforces the last-login-method rule", async () => {
    // emailVerified ещё false (из предыдущего теста) — google остаётся
    // единственным способом входа. Тело не несёт providerId вовсе: before-хук
    // резолвит провайдера сам по accountId из БД (см. hooks.ts), поэтому
    // отсутствие поля не открывает лазейку.
    const response = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: {
          cookie: mailCookie,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: "acc-mail-google" }),
      }),
    );
    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("LAST_LOGIN_METHOD");
  });

  it("a mismatched providerId in the body does not bypass the rule", async () => {
    // accountId всё ещё указывает на единственный способ входа (google), но
    // тело лжёт про providerId — before-хук игнорирует его и резолвит из БД.
    const response = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: {
          cookie: mailCookie,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: "acc-mail-google",
          providerId: "steam",
        }),
      }),
    );
    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("LAST_LOGIN_METHOD");
  });

  it("unlinking steam is allowed even when it is the only other account", async () => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: {
          cookie: mailCookie,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: "acc-mail-steam",
          providerId: "steam",
        }),
      }),
    );
    expect(response.status).toBe(200);

    const orm = drizzle({ client: db });
    const [removed] = await orm
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, "acc-mail-steam"));
    expect(removed).toBeUndefined();

    const [mailUser] = await orm
      .select({ steamId: user.steamId })
      .from(user)
      .where(eq(user.id, "u-mail"));
    expect(mailUser?.steamId).toBeNull();
  });

  it("verified email keeps google unlinkable", async () => {
    await drizzle({ client: db })
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, "u-mail"));

    const response = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: {
          cookie: mailCookie,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: "acc-mail-google",
          providerId: "google",
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("unlinking pocket id resets role to player", async () => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: {
          cookie: adminCookie,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: "acc-admin-pocket-id",
          providerId: "pocket-id",
        }),
      }),
    );
    expect(response.status).toBe(200);

    const [updatedAdmin] = await drizzle({ client: db })
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, "u-admin"));
    expect(updatedAdmin?.role).toBe("player");
  });
});
