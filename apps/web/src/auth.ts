// Клиент Better Auth: вход через Steam OpenID (игроки) и Pocket ID (админы), выход.
// Адрес не задаём: клиент ходит на `/api/auth` того же origin (в dev — через прокси dev.ts).
import { steamOpenIDClient } from "better-auth-steam/client";
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
  plugins: [steamOpenIDClient()],
});

/** Вход через Steam: ответ сервера уводит браузер на steamcommunity.com. */
export const signInWithSteam = () =>
  authClient.steam.login({ callbackURL: "/library", errorCallbackURL: "/" });

/** Вход админа через Pocket ID (OIDC-провайдер `pocket-id` плагина genericOAuth). */
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
