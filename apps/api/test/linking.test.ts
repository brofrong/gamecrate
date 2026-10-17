// Привязка аккаунтов отключена: Steam-вход не должен давать роль admin через общий user.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { migrationsFolder, session, user } from "@cg/db";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { Redacted } from "effect";
import { type Auth, makeAuth } from "../src/auth/auth";

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
let cookie: string;

beforeAll(async () => {
  admin = new SQL(serverUrl);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  db = new SQL(databaseUrl);
  const orm = drizzle({ client: db });
  await migrate(orm, { migrationsFolder });
  // Админ Pocket ID с активной сессией.
  await orm.insert(user).values({
    id: "u-admin",
    name: "Админ",
    email: "admin@example.com",
    role: "admin",
  });
  await orm.insert(session).values({
    id: "s-admin",
    token: "admin-session-token",
    userId: "u-admin",
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });
  cookie = `better-auth.session_token=${await signCookie("admin-session-token")}`;
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
  });
});

afterAll(async () => {
  await db?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.close();
});

describe("account linking", () => {
  it("session cookie is valid (precondition)", async () => {
    const result = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(result?.user.id).toBe("u-admin");
  });

  it("steam link is rejected for a signed-in admin", async () => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/steam/link`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "/admin" }),
      }),
    );
    const body = (await response.json()) as { code?: string; url?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("STEAM_ACCOUNT_LINKING_DISABLED");
    expect(body.url).toBeUndefined();
  });
});
