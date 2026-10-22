// Вход по коду на почту (emailOTP), регистрация Google/Яндекс и правила склейки аккаунтов.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { migrationsFolder, user } from "@cg/db";
import { SQL } from "bun";
import { count, eq } from "drizzle-orm";
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
let sent: Array<Mail>;

/** Базовый конфиг `makeAuth`, как в `steamLogin.test.ts`. */
const baseConfig = () => ({
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
  webDistDir: "unused",
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
    botToken: Redacted.Redacted<string>;
    botUsername: string;
  }>(),
});

beforeAll(async () => {
  admin = new SQL(serverUrl);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  db = new SQL(databaseUrl);
  await migrate(drizzle({ client: db }), { migrationsFolder });
  sent = [];
  auth = makeAuth(baseConfig(), {
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

const sendOtp = (email: string) =>
  auth.handler(
    new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    }),
  );

const signInOtp = (email: string, otp: string) =>
  auth.handler(
    new Request(`${origin}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, otp }),
    }),
  );

describe("email otp sign-in", () => {
  it("send-verification-otp mails a 6-digit code and sign-in creates a verified user", async () => {
    const email = "ivan@example.com";
    sent.length = 0;
    const send = await sendOtp(email);
    expect(send.status).toBe(200);
    expect(sent.length).toBe(1);
    expect(sent[0]?.subject).toBe("Код для входа в GameCrate");
    const match = sent[0]?.text.match(/\b\d{6}\b/);
    if (!match) throw new Error("no 6-digit code in mail text");
    const code = match[0];

    const signIn = await signInOtp(email, code);
    expect(signIn.status).toBe(200);
    expect(
      signIn.headers
        .getSetCookie()
        .some((value) => value.startsWith("better-auth.session_token=")),
    ).toBe(true);

    const [created] = await drizzle({ client: db })
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, email));
    expect(created?.emailVerified).toBe(true);
  });

  it("second sign-in with the same email reuses the user", async () => {
    const email = "reuse@example.com";
    sent.length = 0;
    await sendOtp(email);
    const code1 = sent[0]?.text.match(/\b\d{6}\b/)?.[0];
    if (!code1) throw new Error("no code");
    await signInOtp(email, code1);

    sent.length = 0;
    await sendOtp(email);
    const code2 = sent[0]?.text.match(/\b\d{6}\b/)?.[0];
    if (!code2) throw new Error("no code");
    await signInOtp(email, code2);

    const rows = await drizzle({ client: db })
      .select({ value: count() })
      .from(user)
      .where(eq(user.email, email));
    expect(rows[0]?.value).toBe(1);
  });

  it("wrong code is rejected and does not create a session", async () => {
    const email = "wrong-code@example.com";
    sent.length = 0;
    await sendOtp(email);
    expect(sent.length).toBe(1);

    const signIn = await signInOtp(email, "000000");
    expect([400, 401]).toContain(signIn.status);
    expect(signIn.headers.getSetCookie()).toEqual([]);
  });

  // ВАЖНО (отклонение от брифа Task 3, см. отчёт/concerns): better-auth 1.7.10
  // зовёт sendVerificationOTP через ctx.context.runInBackgroundOrAwait, который
  // всегда глушит исключение (await promise; catch { logger.error(...) }) —
  // это намеренно (комментарий в types.d.mts: "recommended to not await the email
  // sending to avoid timing attacks"). Отказ sendMail никогда не долетает до
  // ответа эндпоинта: проверяем реальное поведение (200, код не выдаётся),
  // а не придуманное.
  it("mailer failure does not fail the request but no code is delivered", async () => {
    const email = "fails@example.com";
    const attempts: Array<Mail> = [];
    const failingAuth = makeAuth(baseConfig(), {
      sendMail: async (mail) => {
        attempts.push(mail);
        throw new Error("smtp down");
      },
    });
    const response = await failingAuth.handler(
      new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, type: "sign-in" }),
      }),
    );
    // better-auth отправляет письмо в фоне и не роняет запрос из-за отказа почты.
    expect(response.status).toBe(200);
    // Попытка отправить письмо была (sendMail вызван), но она провалилась — код
    // пользователю не попал, значит валидного кода для входа не существует.
    expect(attempts.length).toBe(1);

    const signIn = await failingAuth.handler(
      new Request(`${origin}/api/auth/sign-in/email-otp`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, otp: "000000" }),
      }),
    );
    expect([400, 401]).toContain(signIn.status);
    expect(signIn.headers.getSetCookie()).toEqual([]);
  });

  it("linking options are enabled", () => {
    expect(auth.options.account?.accountLinking).toMatchObject({
      enabled: true,
      allowDifferentEmails: true,
      allowUnlinkingAll: true,
      trustedProviders: ["google", "yandex", "pocket-id"],
    });
  });

  it("google is registered only when configured", () => {
    expect(auth.options.socialProviders?.google).toBeUndefined();

    const withGoogle = makeAuth({
      ...baseConfig(),
      google: Option.some({
        clientId: "g-id",
        clientSecret: Redacted.make("g-secret"),
      }),
    });
    expect(withGoogle.options.socialProviders?.google).toBeDefined();
  });
});
