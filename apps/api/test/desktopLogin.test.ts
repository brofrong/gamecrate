// Вход в десктоп-приложение через системный браузер: вошедший в браузере получает
// одноразовый токен (плагин one-time-token), приложение меняет его на cookie сессии.
// Настоящий Better Auth на тестовой БД, вход — кодом на почту (как в emailOtp.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { BrandId } from "@cg/brands";
import { migrationsFolder, verification } from "@cg/db";
import { SQL } from "bun";
import { like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { Option, Redacted } from "effect";
import type { Mail } from "../src/mail/Mailer";
import { type Auth, makeAuth } from "../src/auth/auth";

const origin = "http://localhost:3000";
const serverUrl = process.env["TEST_DATABASE_URL"];
if (!serverUrl) throw new Error("TEST_DATABASE_URL is not set");
const database = `cg_test_${crypto.randomUUID().replaceAll("-", "")}`;
const databaseUrl = Object.assign(new URL(serverUrl), {
  pathname: `/${database}`,
}).toString();

let admin: SQL;
let db: SQL;
let auth: Auth;
const sent: Array<Mail> = [];

const config = () => ({
  port: 0,
  publicUrl: origin,
  databaseUrl: Redacted.make(databaseUrl),
  steamApiKey: Redacted.make("unused"),
  authSecret: Redacted.make("test-secret-test-secret-test-secret-0123"),
  pocketIdUrl: "http://127.0.0.1:9",
  pocketIdClientId: "unused",
  pocketIdClientSecret: Redacted.make("unused"),
  pocketIdAdminGroup: "cloud_gaming_admins",
  allowedOrigins: [],
  brandHosts: new Map<string, BrandId>(),
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
  google: Option.none<{
    clientId: string;
    clientSecret: Redacted.Redacted<string>;
  }>(),
  yandex: Option.none<{
    clientId: string;
    clientSecret: Redacted.Redacted<string>;
  }>(),
  telegram: Option.none<{
    clientId: string;
    clientSecret: Redacted.Redacted<string>;
  }>(),
});

beforeAll(async () => {
  admin = new SQL(serverUrl);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  db = new SQL(databaseUrl);
  await migrate(drizzle({ client: db }), { migrationsFolder });
  auth = makeAuth(config(), {
    sendMail: async (mail) => {
      sent.push(mail);
    },
  });
});

afterAll(async () => {
  await db?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.close();
});

const post = (path: string, body: unknown, cookie?: string) =>
  auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const get = (path: string, cookie?: string) =>
  auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      headers: { origin, ...(cookie ? { cookie } : {}) },
    }),
  );

/** Cookie сессии из ответа (`name=value`), `undefined` — если не ставилась. */
const sessionCookie = (response: Response): string | undefined =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith("better-auth.session_token="))
    ?.split(";")[0];

/** Вход кодом на почту — так игрок вошёл бы в системном браузере. */
const signIn = async (email: string): Promise<string> => {
  sent.length = 0;
  await post("/email-otp/send-verification-otp", { email, type: "sign-in" });
  const code = sent[0]?.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error("no code in mail");
  const cookie = sessionCookie(
    await post("/sign-in/email-otp", { email, otp: code }),
  );
  if (!cookie) throw new Error("no session cookie");
  return cookie;
};

const userIdOf = async (cookie: string): Promise<string | undefined> => {
  const response = await get("/get-session", cookie);
  const body = (await response.json()) as { user?: { id: string } } | null;
  return body?.user?.id;
};

const generate = async (cookie?: string) => {
  const response = await get("/one-time-token/generate", cookie);
  const body = response.ok
    ? ((await response.json()) as { token: string })
    : undefined;
  return { status: response.status, token: body?.token };
};

const verify = (token: string) => post("/one-time-token/verify", { token });

describe("desktop login one-time token", () => {
  it("signed-in browser gets a token, the app exchanges it for a session of the same user", async () => {
    const browser = await signIn("desktop@example.com");
    const { status, token } = await generate(browser);
    expect(status).toBe(200);
    if (!token) throw new Error("no token");
    // токен попадает в ссылку gamecrate:// — формат, который пропускает приложение
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,256}$/);

    const exchanged = await verify(token);
    expect(exchanged.status).toBe(200);
    const app = sessionCookie(exchanged);
    if (!app) throw new Error("verify did not set a session cookie");
    expect(await userIdOf(app)).toBe(await userIdOf(browser));
  });

  it("the token works only once", async () => {
    const browser = await signIn("once@example.com");
    const { token } = await generate(browser);
    if (!token) throw new Error("no token");
    expect((await verify(token)).status).toBe(200);

    const again = await verify(token);
    expect(again.status).toBe(400);
    expect(sessionCookie(again)).toBeUndefined();
  });

  it("two parallel exchanges of one token: exactly one gets a session", async () => {
    const browser = await signIn("race@example.com");
    const { token } = await generate(browser);
    if (!token) throw new Error("no token");

    const results = await Promise.all([verify(token), verify(token)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(results.filter((r) => sessionCookie(r) !== undefined)).toHaveLength(
      1,
    );
  });

  it("the token lives 2 minutes and is refused after that", async () => {
    const browser = await signIn("late@example.com");
    const before = Date.now();
    const { token } = await generate(browser);
    if (!token) throw new Error("no token");

    const orm = drizzle({ client: db });
    const [row] = await orm
      .select({ expiresAt: verification.expiresAt })
      .from(verification)
      .where(like(verification.identifier, "one-time-token:%"));
    if (!row) throw new Error("no token row");
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(110_000);
    expect(ttl).toBeLessThanOrEqual(121_000);

    // «прошло 2 минуты» — срок в БД уже истёк
    await orm
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(verification.identifier, "one-time-token:%"));
    const late = await verify(token);
    expect(late.status).toBe(400);
    expect(sessionCookie(late)).toBeUndefined();
  });

  it("a guest cannot generate a token", async () => {
    const { status, token } = await generate();
    expect(status).toBe(401);
    expect(token).toBeUndefined();
  });

  it("the token is not stored in plain text", async () => {
    const browser = await signIn("hashed@example.com");
    const { token } = await generate(browser);
    if (!token) throw new Error("no token");

    const rows = await drizzle({ client: db })
      .select({
        identifier: verification.identifier,
        value: verification.value,
      })
      .from(verification);
    expect(rows.some((r) => r.identifier.startsWith("one-time-token:"))).toBe(
      true,
    );
    for (const row of rows) {
      expect(row.identifier).not.toContain(token);
      expect(row.value).not.toContain(token);
    }
  });
});
