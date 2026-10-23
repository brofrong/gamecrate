// OAuth-вход через Яндекс ID (generic OAuth): профиль, маппинг и конфиг провайдера.
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { Schema } from "effect";

/** Ответ `https://login.yandex.ru/info?format=json`. */
export const YandexInfo = Schema.Struct({
  id: Schema.String,
  default_email: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  real_name: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  default_avatar_id: Schema.optional(Schema.String),
  is_avatar_empty: Schema.optional(Schema.Boolean),
});

/**
 * Локальный профиль из ответа Яндекса; `null`, если почта не выдана (без
 * неё связать аккаунт нельзя). Яндекс считает выданную почту подтверждённой.
 */
export const yandexUserInfo = (
  info: typeof YandexInfo.Type,
): {
  id: string;
  email: string;
  emailVerified: true;
  name: string;
  image: string | null;
} | null => {
  if (info.default_email === undefined) return null;
  return {
    id: info.id,
    email: info.default_email,
    emailVerified: true,
    name: info.display_name ?? info.real_name ?? info.login ?? "Игрок Яндекса",
    image:
      !info.is_avatar_empty && info.default_avatar_id
        ? `https://avatars.yandex.net/get-yapic/${info.default_avatar_id}/islands-200`
        : null,
  };
};

/** generic-oauth конфиг провайдера «yandex». */
export const yandexProvider = (
  clientId: string,
  clientSecret: string,
): GenericOAuthConfig => ({
  providerId: "yandex",
  name: "Яндекс",
  authorizationUrl: "https://oauth.yandex.ru/authorize",
  tokenUrl: "https://oauth.yandex.ru/token",
  clientId,
  clientSecret,
  scopes: ["login:email", "login:info", "login:avatar"],
  getUserInfo: async (tokens) => {
    if (!tokens.accessToken) return null;
    const response = await fetch("https://login.yandex.ru/info?format=json", {
      headers: { Authorization: `OAuth ${tokens.accessToken}` },
    });
    if (!response.ok) return null;
    const info = Schema.decodeUnknownSync(YandexInfo)(await response.json());
    const mapped = yandexUserInfo(info);
    return mapped === null
      ? null
      : { ...mapped, image: mapped.image ?? undefined };
  },
});
