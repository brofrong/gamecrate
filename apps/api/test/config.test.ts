// Тесты конфигурации: обязательные почтовые переменные и опциональные провайдеры входа.
import { describe, expect, it } from "bun:test";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { appConfig } from "../src/config";

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

  it("telegram requires both token and username", async () => {
    const result = await Effect.runPromise(
      parse({ ...base, TELEGRAM_BOT_TOKEN: "t-token" }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });

  it("smtp url and mail from are required", async () => {
    const { SMTP_URL, ...withoutSmtp } = base;
    const result = await Effect.runPromise(
      parse(withoutSmtp).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
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
