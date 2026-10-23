// OIDC-вход через Telegram (generic OAuth): discovery `oauth.telegram.org`,
// Authorization Code + PKCE. Userinfo-эндпоинта у Telegram нет, профиль берём
// из ID-токена; его подпись и nonce проверяет сама библиотека по JWKS из
// discovery до вызова `getUserInfo` (`requireIdTokenVerification`). Почты
// Telegram не отдаёт — выдаём синтетическую, поэтому автосклейки по почте нет,
// только ручная привязка в профиле.
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { Schema } from "effect";

/** Домен синтетической почты Telegram-пользователей: `tg_<id>@telegram.invalid`. */
export const TELEGRAM_EMAIL_DOMAIN = "telegram.invalid";

/** Интересующие нас claims ID-токена Telegram (scope `openid profile`). */
export const TelegramClaims = Schema.Struct({
  sub: Schema.String,
  name: Schema.optional(Schema.String),
  preferred_username: Schema.optional(Schema.String),
  picture: Schema.optional(Schema.String),
});

/** Локальный профиль из claims ID-токена; `emailVerified: false` — почта синтетическая. */
export const telegramUserInfo = (
  claims: typeof TelegramClaims.Type,
): {
  id: string;
  email: string;
  emailVerified: false;
  name: string;
  image: string | undefined;
} => {
  const name =
    [claims.name, claims.preferred_username].find(
      (candidate) => candidate !== undefined && candidate.trim().length > 0,
    ) ?? "Игрок Telegram";
  return {
    id: claims.sub,
    email: `tg_${claims.sub}@${TELEGRAM_EMAIL_DOMAIN}`,
    emailVerified: false,
    name,
    image: claims.picture,
  };
};

/** Payload JWT без проверки подписи (подпись уже проверена библиотекой); `null`, если это не JWT. */
const decodeJwtPayload = (token: string): unknown => {
  const payload = token.split(".")[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

/** generic-oauth конфиг провайдера «telegram». */
export const telegramProvider = (
  clientId: string,
  clientSecret: string,
): GenericOAuthConfig => ({
  providerId: "telegram",
  name: "Telegram",
  discoveryUrl: "https://oauth.telegram.org/.well-known/openid-configuration",
  clientId,
  clientSecret,
  scopes: ["openid", "profile"],
  pkce: true,
  requireIdTokenVerification: true,
  getUserInfo: async (tokens) => {
    if (!tokens.idToken) return null;
    const claims = Schema.decodeUnknownOption(TelegramClaims)(
      decodeJwtPayload(tokens.idToken),
    );
    return claims._tag === "Some" ? telegramUserInfo(claims.value) : null;
  },
});
