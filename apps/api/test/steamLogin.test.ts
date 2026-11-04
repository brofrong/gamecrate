// Вход через Steam отключён (Task 4): привязка живёт в linking.test.ts
// (фикстуры Steam — steamFixtures.ts, общие для обоих файлов).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { migrationsFolder } from "@cg/db";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { Option, Redacted } from "effect";
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

beforeAll(async () => {
  admin = new SQL(serverUrl);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  db = new SQL(databaseUrl);
  await migrate(drizzle({ client: db }), { migrationsFolder });
  auth = makeAuth({
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
    ownGamesDir: "unused",
    smtpUrl: Redacted.make("log://"),
    mailFrom: "GameCrate <test@example.com>",
    google: Option.none(),
    yandex: Option.none(),
    telegram: Option.none(),
  });
});

afterAll(async () => {
  await db?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.close();
});

describe("steam login", () => {
  it("steam login is disabled", async () => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/steam/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "/library" }),
      }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("STEAM_LOGIN_DISABLED");
  });
});
