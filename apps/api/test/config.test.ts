// Тесты конфигурации: обязательные почтовые переменные и опциональные провайдеры входа.
import { describe, expect, it } from "bun:test";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { appConfig, appHosts, rpcAllowedOrigins } from "../src/config";

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

const parse = (env: Record<string, string>) =>
  appConfig.parse(ConfigProvider.fromUnknown(env));

describe("appConfig", () => {
  it("optional providers are None when unset", async () => {
    const config = await Effect.runPromise(parse(base));
    expect(Option.isNone(config.google)).toBe(true);
    expect(Option.isNone(config.yandex)).toBe(true);
    expect(Option.isNone(config.telegram)).toBe(true);
  });

  it("google provider is Some when both vars set", async () => {
    const config = await Effect.runPromise(
      parse({
        ...base,
        GOOGLE_CLIENT_ID: "g-id",
        GOOGLE_CLIENT_SECRET: "g-secret",
      }),
    );
    expect(Option.isSome(config.google)).toBe(true);
    if (!Option.isSome(config.google)) return;
    expect(config.google.value.clientId).toBe("g-id");
    expect(Redacted.value(config.google.value.clientSecret)).toBe("g-secret");
  });

  it("telegram requires both client id and secret", async () => {
    const result = await Effect.runPromise(
      parse({ ...base, TELEGRAM_CLIENT_ID: "t-id" }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });

  it("telegram provider is Some when both vars set", async () => {
    const config = await Effect.runPromise(
      parse({
        ...base,
        TELEGRAM_CLIENT_ID: "t-id",
        TELEGRAM_CLIENT_SECRET: "t-secret",
      }),
    );
    expect(Option.isSome(config.telegram)).toBe(true);
    if (Option.isSome(config.telegram)) {
      expect(config.telegram.value.clientId).toBe("t-id");
      expect(Redacted.value(config.telegram.value.clientSecret)).toBe(
        "t-secret",
      );
    }
  });

  it("relay secret is required and at least 32 characters", async () => {
    const config = await Effect.runPromise(parse(base));
    expect(Redacted.value(config.relaySecret)).toBe(base.RELAY_SECRET);
    const { RELAY_SECRET: _, ...without } = base;
    for (const env of [without, { ...base, RELAY_SECRET: "s".repeat(31) }]) {
      const result = await Effect.runPromise(Effect.result(parse(env)));
      expect(result._tag).toBe("Failure");
    }
  });

  it("smtp url and mail from are required", async () => {
    const { SMTP_URL, ...withoutSmtp } = base;
    const result = await Effect.runPromise(
      parse(withoutSmtp).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });

  it("brand hosts are empty by default and when empty string", async () => {
    for (const env of [base, { ...base, BRAND_HOSTS: "" }]) {
      const config = await Effect.runPromise(parse(env));
      expect(config.brandHosts.size).toBe(0);
    }
  });

  it("BRAND_HOSTS maps hosts to brands", async () => {
    const config = await Effect.runPromise(
      parse({ ...base, BRAND_HOSTS: "play.beeline.ru=beeline" }),
    );
    expect(config.brandHosts.get("play.beeline.ru")).toBe("beeline");
  });

  it("BRAND_HOSTS with an unknown brand is a ConfigError", async () => {
    const result = await Effect.runPromise(
      parse({ ...base, BRAND_HOSTS: "x=bad" }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });

  it("rpcAllowedOrigins include PUBLIC_URL and every brand host", async () => {
    const config = await Effect.runPromise(
      parse({
        ...base,
        PUBLIC_URL: "https://game.x.ru",
        BRAND_HOSTS: "play.beeline.ru=beeline",
      }),
    );
    const origins = rpcAllowedOrigins(config);
    expect(origins.has("https://game.x.ru")).toBe(true);
    expect(origins.has("https://play.beeline.ru")).toBe(true);
    expect(appHosts(config)).toEqual(["game.x.ru", "play.beeline.ru"]);
  });

  it("OAUTH_HOSTS_* default to the PUBLIC_URL host (also when empty)", async () => {
    for (const env of [
      { ...base, PUBLIC_URL: "https://game.x.ru" },
      {
        ...base,
        PUBLIC_URL: "https://game.x.ru",
        OAUTH_HOSTS_GOOGLE: "",
        OAUTH_HOSTS_YANDEX: "",
        OAUTH_HOSTS_POCKET_ID: "",
        OAUTH_HOSTS_TELEGRAM: "",
      },
    ]) {
      const config = await Effect.runPromise(parse(env));
      for (const hosts of Object.values(config.oauthHosts)) {
        expect([...hosts]).toEqual(["game.x.ru"]);
      }
    }
  });

  it("OAUTH_HOSTS_* is a normalized comma-separated list per provider", async () => {
    const config = await Effect.runPromise(
      parse({
        ...base,
        PUBLIC_URL: "https://game.x.ru",
        OAUTH_HOSTS_GOOGLE: "a.ru, B.ru",
        OAUTH_HOSTS_POCKET_ID: "game.x.ru, play.beeline.ru",
      }),
    );
    expect([...config.oauthHosts.google]).toEqual(["a.ru", "b.ru"]);
    expect([...config.oauthHosts.pocketId]).toEqual([
      "game.x.ru",
      "play.beeline.ru",
    ]);
    expect([...config.oauthHosts.yandex]).toEqual(["game.x.ru"]);
    expect([...config.oauthHosts.telegram]).toEqual(["game.x.ru"]);
  });

  it("empty provider vars count as unset", async () => {
    const config = await Effect.runPromise(
      parse({
        ...base,
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
      }),
    );
    expect(Option.isNone(config.google)).toBe(true);
  });
});
