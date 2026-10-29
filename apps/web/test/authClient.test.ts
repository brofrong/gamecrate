// `safeNext` (защита от open redirect в `next`/`callbackURL`) и `authErrorMessage`
// (словарь кодов ошибок Better Auth → текст тоста) — чистые функции, без DOM и сети.
import { describe, expect, it } from "bun:test";
import { authErrorMessage } from "../src/lib/authErrors";
import { safeNext } from "../src/lib/safeNext";

describe("safeNext", () => {
  it("keeps relative paths", () => {
    expect(safeNext("/profile?tab=1")).toBe("/profile?tab=1");
  });

  it("rejects protocol-relative and absolute urls", () => {
    expect(safeNext("//evil.com")).toBe("/app");
    expect(safeNext("https://evil.com")).toBe("/app");
    expect(safeNext(undefined)).toBe("/app");
  });

  it("rejects values with a backslash and non-string values", () => {
    expect(safeNext("/ok\\evil.com")).toBe("/app");
    expect(safeNext("relative/path")).toBe("/app");
    expect(safeNext(42)).toBe("/app");
  });

  it("uses a custom fallback", () => {
    expect(safeNext(null, "/login")).toBe("/login");
  });
});

describe("authErrorMessage", () => {
  it("maps known codes and falls back", () => {
    expect(authErrorMessage("LAST_LOGIN_METHOD")).toBe(
      "Нельзя отвязать последний способ входа",
    );
    expect(authErrorMessage("WHATEVER")).toBe(
      "Провайдер не подтвердил вход, попробуй ещё раз",
    );
  });

  it("maps every documented code", () => {
    expect(authErrorMessage("STEAM_ACCOUNT_ALREADY_LINKED")).toBe(
      "Этот Steam уже привязан к другому аккаунту",
    );
    expect(authErrorMessage("ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER")).toBe(
      "Этот аккаунт уже привязан к другому пользователю GameCrate",
    );
    expect(authErrorMessage("INVALID_OTP")).toBe("Неверный код");
    expect(authErrorMessage("OTP_EXPIRED")).toBe("Код устарел, отправь новый");
    expect(authErrorMessage("TOO_MANY_ATTEMPTS")).toBe(
      "Слишком много попыток, запроси новый код",
    );
    expect(authErrorMessage("MAIL_FAILED")).toBe(
      "Не удалось отправить письмо, попробуй позже",
    );
    expect(authErrorMessage("SESSION_NOT_FRESH")).toBe(
      "Для этого войди заново: выйди и зайди снова",
    );
  });

  it("falls back for undefined and oauth-ish codes", () => {
    expect(authErrorMessage(undefined)).toBe(
      "Провайдер не подтвердил вход, попробуй ещё раз",
    );
    expect(authErrorMessage("access_denied")).toBe(
      "Провайдер не подтвердил вход, попробуй ещё раз",
    );
    expect(authErrorMessage("OAUTH_CALLBACK_ERROR")).toBe(
      "Провайдер не подтвердил вход, попробуй ещё раз",
    );
  });
});
