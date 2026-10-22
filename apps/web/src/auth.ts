// Клиент Better Auth: вход по коду на email, через соцпровайдеров (Google/Яндекс/Pocket ID)
// и Telegram, привязка/отвязка способов входа в профиле, выход.
// Адрес не задаём: клиент ходит на `/api/auth` того же origin (в dev — через прокси dev.ts).
import type { TelegramAuthData } from "@cg/rpc";
import { steamOpenIDClient } from "better-auth-steam/client";
import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [steamOpenIDClient(), emailOTPClient()],
});

/** Соцпровайдеры входа/привязки через `signIn.social`/`linkSocial` (без Steam и Telegram — у них свой поток). */
export type SocialProvider = "google" | "yandex" | "pocket-id";

/** Вход через соцпровайдера; `next` — куда вернуться после успеха (см. `safeNext`). */
export const signInWithProvider = (provider: SocialProvider, next: string) =>
  authClient.signIn.social({
    provider,
    callbackURL: next,
    errorCallbackURL: "/login",
  });

/** Отправляет код для входа на email (`type: "sign-in"` — тот же код используется в `/login`). */
export const sendEmailCode = async (
  email: string,
): Promise<{ error: string | null }> => {
  try {
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    if (!error) return { error: null };
    if (error.status >= 500) return { error: "MAIL_FAILED" };
    return { error: error.code ?? "UNKNOWN" };
  } catch {
    return { error: "MAIL_FAILED" };
  }
};

/** Вход по коду, присланному `sendEmailCode`. */
export const signInWithEmailCode = async (
  email: string,
  otp: string,
): Promise<{ error: string | null }> => {
  const { error } = await authClient.signIn.emailOtp({ email, otp });
  return { error: error ? error.code ?? "UNKNOWN" : null };
};

/** Привязка соцпровайдера к уже вошедшему пользователю из `/profile`. */
export const linkProvider = (provider: SocialProvider) =>
  authClient.linkSocial({
    provider,
    callbackURL: "/profile",
    errorCallbackURL: "/profile",
  });

/** Отвязка способа входа; сервер сам резолвит ряд по `accountId` и проверяет правило последнего способа входа. */
export const unlinkProvider = async (
  providerId: string,
  accountId: string,
): Promise<{ error: string | null }> => {
  const body = { providerId, accountId };
  const { error } = await authClient.unlinkAccount(body);
  return { error: error ? error.code ?? "UNKNOWN" : null };
};

/** Привязка Steam к уже вошедшему пользователю (вход через Steam отключён — только привязка). */
export const linkSteam = (callbackURL: string) =>
  authClient.steam.link({ callbackURL, errorCallbackURL: callbackURL });

/** Привязанные способы входа текущего пользователя — для `/profile`. */
export const listLinkedAccounts = async (): Promise<
  ReadonlyArray<{ providerId: string; accountId: string }>
> => {
  const { data } = await authClient.listAccounts();
  return data ?? [];
};

/** Запрос смены email: код уходит на новый адрес, подтверждается `confirmEmailChange`. */
export const requestEmailChange = (newEmail: string) =>
  authClient.emailOtp.requestEmailChange({ newEmail });

/** Подтверждение смены email кодом, присланным `requestEmailChange`. */
export const confirmEmailChange = (newEmail: string, otp: string) =>
  authClient.emailOtp.changeEmail({ newEmail, otp });

/**
 * Вход/привязка через Telegram Login Widget: в отличие от остальных провайдеров
 * у Better Auth нет готового клиентского метода — зовём наш эндпоинт напрямую.
 * При успехе сервер отдаёт cookie сессии и адрес для перехода.
 */
export const signInWithTelegram = async (
  user: TelegramAuthData,
  next: string,
  link = false,
): Promise<{ error: string | null }> => {
  try {
    const response = await fetch("/api/auth/telegram/callback", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, callbackURL: next, link }),
    });
    if (response.ok) {
      const { redirect } = (await response.json()) as { redirect: string };
      window.location.assign(redirect);
      return { error: null };
    }
    const body = (await response.json().catch(() => null)) as {
      code?: string;
    } | null;
    return { error: body?.code ?? "UNKNOWN" };
  } catch {
    return { error: "NETWORK" };
  }
};

/**
 * Вход через Steam: ответ сервера уводит браузер на steamcommunity.com.
 * @deprecated — удаляется в Task 10
 */
export const signInWithSteam = () =>
  authClient.steam.login({ callbackURL: "/library", errorCallbackURL: "/" });

/**
 * Вход админа через Pocket ID (OIDC-провайдер `pocket-id` плагина genericOAuth).
 * @deprecated — удаляется в Task 10, используй `signInWithProvider("pocket-id", "/admin")`
 */
export const signInWithPocketId = () =>
  authClient.signIn.social({ provider: "pocket-id", callbackURL: "/admin" });

/**
 * Выход. Сессия RPC-сокета привязана к cookie апгрейда, поэтому после выхода
 * перезагружаем страницу — новый сокет откроется уже без сессии.
 */
export const signOut = async () => {
  await authClient.signOut();
  window.location.assign("/");
};
