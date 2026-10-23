// Telegram как OIDC-провайдер (generic OAuth): профиль берётся из ID-токена
// (userinfo-эндпоинта у Telegram нет), почты нет — выдаём синтетическую.
import { describe, expect, it } from "bun:test";
import {
  TELEGRAM_EMAIL_DOMAIN,
  telegramProvider,
  telegramUserInfo,
} from "../src/auth/telegram";

/** Неподписанный JWT с данным payload — подпись проверяет сама библиотека до нашего кода. */
const unsignedJwt = (payload: unknown): string => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify(payload))}.`;
};

describe("telegramUserInfo", () => {
  it("maps id token claims to a user with a synthetic email", () =>
    expect(
      telegramUserInfo({
        sub: "42",
        name: "Аня",
        preferred_username: "anya",
        picture: "https://t.me/i/userpic/320/x.jpg",
      }),
    ).toEqual({
      id: "42",
      email: `tg_42@${TELEGRAM_EMAIL_DOMAIN}`,
      emailVerified: false,
      name: "Аня",
      image: "https://t.me/i/userpic/320/x.jpg",
    }));

  it("falls back to username, then to a generic name", () => {
    expect(
      telegramUserInfo({ sub: "1", preferred_username: "anya" }).name,
    ).toBe("anya");
    expect(telegramUserInfo({ sub: "1" }).name).toBe("Игрок Telegram");
    expect(telegramUserInfo({ sub: "1", name: "   " }).name).toBe(
      "Игрок Telegram",
    );
  });

  it("image is undefined without picture", () =>
    expect(telegramUserInfo({ sub: "1" }).image).toBeUndefined());
});

describe("telegramProvider", () => {
  const provider = telegramProvider("8837572204", "secret");

  it("is an OIDC generic-oauth provider with PKCE and id-token verification", () => {
    expect(provider.providerId).toBe("telegram");
    expect(provider.discoveryUrl).toBe(
      "https://oauth.telegram.org/.well-known/openid-configuration",
    );
    expect(provider.scopes).toEqual(["openid", "profile"]);
    expect(provider.pkce).toBe(true);
    expect(provider.requireIdTokenVerification).toBe(true);
    expect(provider.clientId).toBe("8837572204");
    expect(provider.clientSecret).toBe("secret");
  });

  it("reads the profile from the id token", async () => {
    const info = await provider.getUserInfo!({
      accessToken: "at",
      idToken: unsignedJwt({ sub: "42", name: "Аня", picture: "p" }),
    });
    expect(info).toEqual({
      id: "42",
      email: `tg_42@${TELEGRAM_EMAIL_DOMAIN}`,
      emailVerified: false,
      name: "Аня",
      image: "p",
    });
  });

  it("rejects a missing id token or one without sub", async () => {
    expect(await provider.getUserInfo!({ accessToken: "at" })).toBeNull();
    expect(
      await provider.getUserInfo!({
        accessToken: "at",
        idToken: unsignedJwt({ name: "x" }),
      }),
    ).toBeNull();
    expect(
      await provider.getUserInfo!({ accessToken: "at", idToken: "not-a-jwt" }),
    ).toBeNull();
  });
});
