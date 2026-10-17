// Полный вход через Steam OpenID: /steam/login → callback Steam → сессия.
// Регрессия: better-auth-steam 0.2.3 звал старую сигнатуру generateState, и
// `returnTo` не попадал в state → callback падал с `TypeError: Invalid URL`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { migrationsFolder, user } from "@cg/db";
import { SQL } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { Redacted } from "effect";
import { type Auth, makeAuth } from "../src/auth/auth";

const origin = "http://localhost:3000";
const steamId = "76561197960287930";
const steamOpenIdUrl = "https://steamcommunity.com/openid/login";
const serverUrl = process.env["TEST_DATABASE_URL"];
if (!serverUrl) throw new Error("TEST_DATABASE_URL is not set");
const database = `cg_test_${crypto.randomUUID().replaceAll("-", "")}`;
const databaseUrl = Object.assign(new URL(serverUrl), {
  pathname: `/${database}`,
}).toString();

let admin: SQL;
let db: SQL;
let auth: Auth;
const realFetch = globalThis.fetch;

/** Steam: проверка подписи OpenID всегда успешна, профиль — фиксированный. */
const fakeSteamFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === steamOpenIdUrl)
    return new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n");
  if (url.startsWith("https://api.steampowered.com/ISteamUser/"))
    return Response.json({
      response: {
        players: [
          {
            steamid: steamId,
            personaname: "Gabe",
            avatarfull: "https://avatars.example/full.jpg",
            profileurl: `https://steamcommunity.com/profiles/${steamId}/`,
          },
        ],
      },
    });
  return realFetch(input, init);
};

/** Ответ Steam (`id_res`), с которым браузер возвращается на `return_to`. */
const steamResponseParams = (returnTo: string) => {
  const claimedId = `https://steamcommunity.com/openid/id/${steamId}`;
  return new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": steamOpenIdUrl,
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": returnTo,
    "openid.response_nonce": `${new Date().toISOString().slice(0, 19)}Z${crypto.randomUUID()}`,
    "openid.assoc_handle": "1234567890",
    "openid.signed":
      "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "W0u5DRbtHE1GG0ZKXvh8GreQhow=",
  });
};

beforeAll(async () => {
  admin = new SQL(serverUrl);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  db = new SQL(databaseUrl);
  await migrate(drizzle({ client: db }), { migrationsFolder });
  globalThis.fetch = Object.assign(fakeSteamFetch, {
    preconnect: realFetch.preconnect,
  });
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
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await db?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.close();
});

describe("steam login", () => {
  it("callback with a valid Steam response creates a session", async () => {
    const login = await auth.handler(
      new Request(`${origin}/api/auth/steam/login`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "/library" }),
      }),
    );
    expect(login.status).toBe(200);
    const { url } = (await login.json()) as { url: string };
    expect(url.startsWith(steamOpenIdUrl)).toBe(true);
    const returnTo = new URL(url).searchParams.get("openid.return_to");
    if (returnTo === null) throw new Error("no openid.return_to");
    // Cookie браузера после /steam/login (подпись state и т. п.).
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");

    const callback = await auth.handler(
      new Request(`${returnTo}&${steamResponseParams(returnTo)}`, {
        headers: { cookie },
      }),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/library");
    expect(
      callback.headers
        .getSetCookie()
        .some((value) => value.startsWith("better-auth.session_token=")),
    ).toBe(true);
    const [created] = await drizzle({ client: db })
      .select({ name: user.name })
      .from(user)
      .where(eq(user.steamId, steamId));
    expect(created?.name).toBe("Gabe");
  });
});
