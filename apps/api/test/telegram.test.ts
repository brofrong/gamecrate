// Плагин Telegram Login Widget: чистая проверка подписи (`verifyTelegramLogin`
// и её строительные блоки) и эндпоинт `/telegram/callback` (вход и привязка)
// против настоящей БД — тот же паттерн, что `linking.test.ts`/`emailOtp.test.ts`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { account, migrationsFolder, session, user } from "@cg/db";
import type { TelegramAuthData } from "@cg/rpc";
import { SQL } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { Option, Redacted } from "effect";
import { type Auth, makeAuth } from "../src/auth/auth";
import {
  TELEGRAM_EMAIL_DOMAIN,
  telegramDataCheckString,
  telegramHash,
  verifyTelegramLogin,
} from "../src/auth/telegram";

const TEST_BOT_TOKEN = "123456:TEST-TOKEN-NOT-REAL";

/** Собирает подписанные данные Telegram Login Widget из незаполненных полей. */
const signed = (
  data: Omit<TelegramAuthData, "hash">,
): TelegramAuthData & { readonly hash: string } => ({
  ...data,
  hash: telegramHash(data as unknown as Record<string, string>, TEST_BOT_TOKEN),
});

describe("telegramDataCheckString", () => {
  it("data check string is sorted and excludes hash", () => {
    expect(
      telegramDataCheckString({
        hash: "x",
        id: "7",
        auth_date: "1",
        first_name: "A",
      }),
    ).toBe("auth_date=1\nfirst_name=A\nid=7");
  });
});

describe("verifyTelegramLogin", () => {
  const baseData = {
    id: "7",
    first_name: "Анна",
    last_name: "Б",
    photo_url: "https://example.com/anna.jpg",
    auth_date: "1700000000",
  };

  it("valid signature within 5 minutes is ok", () => {
    const data = signed(baseData);
    const now = new Date((Number(baseData.auth_date) + 100) * 1000);
    const result = verifyTelegramLogin(data, TEST_BOT_TOKEN, now);
    expect(result).toEqual({
      _tag: "Ok",
      id: "7",
      name: "Анна Б",
      image: "https://example.com/anna.jpg",
    });
  });

  it("tampered field fails the signature", () => {
    const data = signed(baseData);
    const tampered = { ...data, first_name: "Злоумышленник" };
    const now = new Date((Number(baseData.auth_date) + 100) * 1000);
    expect(verifyTelegramLogin(tampered, TEST_BOT_TOKEN, now)).toEqual({
      _tag: "BadSignature",
    });
  });

  it("auth_date older than 5 minutes is expired", () => {
    const data = signed(baseData);
    const now = new Date((Number(baseData.auth_date) + 301) * 1000);
    expect(verifyTelegramLogin(data, TEST_BOT_TOKEN, now)).toEqual({
      _tag: "Expired",
    });
  });
});

describe("telegram callback endpoint", () => {
  const origin = "http://localhost:3000";
  const serverUrl = process.env["TEST_DATABASE_URL"];
  if (!serverUrl) throw new Error("TEST_DATABASE_URL is not set");
  const database = `cg_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = Object.assign(new URL(serverUrl), {
    pathname: `/${database}`,
  }).toString();
  const secret = "test-secret-test-secret-test-secret-0123";

  let admin: SQL;
  let db: SQL;
  let auth: Auth;
  let sessionCookie: string;

  /** Подписанное значение cookie сессии — как его ставит Better Auth. */
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

  const authDateNow = () => String(Math.floor(Date.now() / 1000));

  const callback = (body: Record<string, unknown>) =>
    auth.handler(
      new Request(`${origin}/api/auth/telegram/callback`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const callbackWithCookie = (cookie: string, body: Record<string, unknown>) =>
    auth.handler(
      new Request(`${origin}/api/auth/telegram/callback`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    admin = new SQL(serverUrl);
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    db = new SQL(databaseUrl);
    const orm = drizzle({ client: db });
    await migrate(orm, { migrationsFolder });

    // Игрок, уже вошедший (почта) — цель теста на привязку Telegram.
    await orm.insert(user).values({
      id: "u-session",
      name: "Ivan",
      email: "ivan@example.com",
      emailVerified: true,
    });
    await orm.insert(session).values({
      id: "s-session",
      token: "session-token",
      userId: "u-session",
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date(),
    });

    // Другой пользователь, уже привязавший telegram id "99".
    await orm.insert(user).values({
      id: "u-other",
      name: "Other",
      email: "other@example.com",
      emailVerified: true,
    });
    await orm.insert(account).values({
      id: "acc-other-telegram",
      accountId: "99",
      providerId: "telegram",
      userId: "u-other",
      updatedAt: new Date(),
    });

    sessionCookie = `better-auth.session_token=${await signCookie("session-token")}`;

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
      telegram: Option.some({
        botToken: Redacted.make(TEST_BOT_TOKEN),
        botUsername: "test_bot",
      }),
    });
  });

  afterAll(async () => {
    await db?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin?.close();
  });

  it("callback signs in a new user with a synthetic email", async () => {
    const data = signed({
      id: "7",
      first_name: "Анна",
      last_name: "Б",
      auth_date: authDateNow(),
    });
    const response = await callback({ user: data });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirect: "/library" });
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("better-auth.session_token=")),
    ).toBe(true);

    const [created] = await drizzle({ client: db })
      .select({ email: user.email, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, `tg_7@${TELEGRAM_EMAIL_DOMAIN}`));
    expect(created?.email).toBe(`tg_7@${TELEGRAM_EMAIL_DOMAIN}`);
    expect(created?.emailVerified).toBe(false);
  });

  it("callback with the same id signs in the same user", async () => {
    const data = signed({
      id: "7",
      first_name: "Анна",
      last_name: "Б",
      auth_date: authDateNow(),
    });
    const response = await callback({ user: data });
    expect(response.status).toBe(200);

    const rows = await drizzle({ client: db })
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, `tg_7@${TELEGRAM_EMAIL_DOMAIN}`));
    expect(rows.length).toBe(1);
  });

  it("link attaches telegram to the session user", async () => {
    const data = signed({
      id: "42",
      first_name: "Линк",
      auth_date: authDateNow(),
    });
    const response = await callbackWithCookie(sessionCookie, {
      user: data,
      link: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirect: "/library" });

    const [linked] = await drizzle({ client: db })
      .select({ userId: account.userId, providerId: account.providerId })
      .from(account)
      .where(eq(account.accountId, "42"));
    expect(linked?.userId).toBe("u-session");
    expect(linked?.providerId).toBe("telegram");
  });

  it("link of a telegram already owned by another user is refused", async () => {
    const data = signed({
      id: "99",
      first_name: "Чужой",
      auth_date: authDateNow(),
    });
    const response = await callbackWithCookie(sessionCookie, {
      user: data,
      link: true,
    });
    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("TELEGRAM_ALREADY_LINKED");

    const [stillOther] = await drizzle({ client: db })
      .select({ userId: account.userId })
      .from(account)
      .where(eq(account.accountId, "99"));
    expect(stillOther?.userId).toBe("u-other");
  });

  it("bad signature is 401", async () => {
    const data = signed({
      id: "555",
      first_name: "Fake",
      auth_date: authDateNow(),
    });
    const response = await callback({
      user: { ...data, hash: "0".repeat(64) },
    });
    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(401);
    expect(body.code).toBe("TELEGRAM_INVALID_SIGNATURE");
  });

  it("link without a session is refused and creates no user", async () => {
    const data = signed({
      id: "777",
      first_name: "NoSession",
      auth_date: authDateNow(),
    });
    const response = await callback({ user: data, link: true });
    expect(response.status).toBe(401);

    const rows = await drizzle({ client: db })
      .select({ id: account.id })
      .from(account)
      .where(eq(account.accountId, "777"));
    expect(rows.length).toBe(0);
  });
});
