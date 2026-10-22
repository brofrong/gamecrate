// Плагин Telegram Login Widget: виджет не даёт OAuth — вместо redirect-флоу он
// подписывает поля профиля HMAC-SHA256 ключом `SHA256(botToken)`, и это нужно
// проверить самим. Эндпоинт `POST /telegram/callback` входит (создаёт нового
// пользователя с синтетической почтой или находит существующего по
// `account.accountId`) либо привязывает Telegram к уже вошедшему пользователю
// (`link: true`) — по мотивам `better-auth-steam` (`createUser`/`createAccount`/
// `createSession` + `setSessionCookie`), но без OpenID-редиректов.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TelegramAuthData } from "@cg/rpc";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { Schema } from "effect";

/** Домен синтетической почты Telegram-пользователей: `tg_<id>@telegram.invalid`. */
export const TELEGRAM_EMAIL_DOMAIN = "telegram.invalid";

const PROVIDER_ID = "telegram";

/** Срок жизни подписи Telegram Login Widget. */
const MAX_AUTH_AGE_SECONDS = 300;

/**
 * Строка проверки подписи Telegram: все поля кроме `hash`, `key=value`,
 * отсортированные по ключу, через `\n`.
 */
export const telegramDataCheckString = (data: Record<string, string>): string =>
  Object.keys(data)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join("\n");

/** HMAC-SHA256 (hex) данных Telegram с ключом `SHA256(botToken)`. */
export const telegramHash = (
  data: Record<string, string>,
  botToken: string,
): string => {
  const secretKey = createHash("sha256").update(botToken).digest();
  return createHmac("sha256", secretKey)
    .update(telegramDataCheckString(data))
    .digest("hex");
};

/** `TelegramAuthData` → `Record<string, string>` без `undefined`-полей (для подписи). */
const toSignedRecord = (data: TelegramAuthData): Record<string, string> => {
  const record: Record<string, string> = {
    id: data.id,
    auth_date: data.auth_date,
    hash: data.hash,
  };
  if (data.first_name !== undefined) record["first_name"] = data.first_name;
  if (data.last_name !== undefined) record["last_name"] = data.last_name;
  if (data.username !== undefined) record["username"] = data.username;
  if (data.photo_url !== undefined) record["photo_url"] = data.photo_url;
  return record;
};

/** Отображаемое имя: `first_name [last_name]`, иначе `@username`, иначе `Telegram ${id}`. */
const telegramDisplayName = (data: TelegramAuthData): string => {
  if (data.first_name !== undefined) {
    return data.last_name !== undefined
      ? `${data.first_name} ${data.last_name}`
      : data.first_name;
  }
  if (data.username !== undefined) return `@${data.username}`;
  return `Telegram ${data.id}`;
};

export type VerifyTelegramLoginResult =
  | { readonly _tag: "Ok"; readonly id: string; readonly name: string; readonly image: string | null }
  | { readonly _tag: "BadSignature" }
  | { readonly _tag: "Expired" };

/**
 * Проверяет подпись и срок действия данных Telegram Login Widget. Сравнение
 * хэшей — `timingSafeEqual` (хэш в hex: несовпадение длины — уже подделка, не
 * бросаем, а считаем `BadSignature`, иначе `timingSafeEqual` падает на разных
 * по длине буферах).
 */
export const verifyTelegramLogin = (
  data: TelegramAuthData,
  botToken: string,
  now: Date,
): VerifyTelegramLoginResult => {
  const expected = Buffer.from(
    telegramHash(toSignedRecord(data), botToken),
    "hex",
  );
  const actual = Buffer.from(data.hash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { _tag: "BadSignature" };
  }
  const ageSeconds = now.getTime() / 1000 - Number(data.auth_date);
  if (ageSeconds > MAX_AUTH_AGE_SECONDS) {
    return { _tag: "Expired" };
  }
  return {
    _tag: "Ok",
    id: data.id,
    name: telegramDisplayName(data),
    image: data.photo_url ?? null,
  };
};

/** Тело `POST /telegram/callback`. */
interface TelegramCallbackBody {
  readonly user: Record<string, unknown>;
  readonly callbackURL?: string;
  readonly link?: boolean;
}

/** Числа Telegram (`id`, `auth_date`) приходят числами — приводим в строки до декодирования. */
const decodeTelegramUser = (raw: Record<string, unknown>): TelegramAuthData =>
  Schema.decodeUnknownSync(TelegramAuthData)({
    ...raw,
    id: String(raw["id"]),
    auth_date: String(raw["auth_date"]),
  });

/** Плагин Better Auth: вход и привязка через Telegram Login Widget. */
export const telegramPlugin = (options: {
  readonly botToken: string;
}): BetterAuthPlugin => ({
  id: PROVIDER_ID,
  endpoints: {
    telegramCallback: createAuthEndpoint(
      "/telegram/callback",
      { method: "POST" },
      async (ctx) => {
        const body = ctx.body as TelegramCallbackBody;
        const data = decodeTelegramUser(body.user);
        const verified = verifyTelegramLogin(data, options.botToken, new Date());
        if (verified._tag === "BadSignature") {
          throw APIError.from("UNAUTHORIZED", {
            code: "TELEGRAM_INVALID_SIGNATURE",
            message: "Подпись Telegram недействительна",
          });
        }
        if (verified._tag === "Expired") {
          throw APIError.from("UNAUTHORIZED", {
            code: "TELEGRAM_EXPIRED",
            message: "Данные Telegram устарели",
          });
        }

        const callbackURL = body.callbackURL ?? "/library";
        const existing = await ctx.context.internalAdapter.findAccountByKey({
          providerId: PROVIDER_ID,
          accountId: verified.id,
        });

        if (body.link === true) {
          const session = await getSessionFromCtx(ctx);
          if (!session) {
            throw APIError.from("UNAUTHORIZED", {
              code: "TELEGRAM_SESSION_REQUIRED",
              message: "Для привязки Telegram нужна сессия",
            });
          }
          if (existing && existing.userId !== session.user.id) {
            throw APIError.from("BAD_REQUEST", {
              code: "TELEGRAM_ALREADY_LINKED",
              message: "Этот Telegram уже привязан к другому пользователю",
            });
          }
          if (!existing) {
            await ctx.context.internalAdapter.createAccount({
              userId: session.user.id,
              providerId: PROVIDER_ID,
              accountId: verified.id,
            });
          }
          return ctx.json({ redirect: callbackURL });
        }

        let signedInUser;
        if (existing) {
          signedInUser = await ctx.context.internalAdapter.findUserById(
            existing.userId,
          );
          if (!signedInUser) {
            throw APIError.from("INTERNAL_SERVER_ERROR", {
              code: "TELEGRAM_USER_NOT_FOUND",
              message: "Пользователь Telegram-аккаунта не найден",
            });
          }
        } else {
          signedInUser = await ctx.context.internalAdapter.createUser(
            {
              name: verified.name,
              image: verified.image,
              email: `tg_${verified.id}@${TELEGRAM_EMAIL_DOMAIN}`,
              emailVerified: false,
            },
            { method: PROVIDER_ID },
          );
          await ctx.context.internalAdapter.createAccount({
            userId: signedInUser.id,
            providerId: PROVIDER_ID,
            accountId: verified.id,
          });
        }

        const newSession = await ctx.context.internalAdapter.createSession(
          signedInUser.id,
        );
        await setSessionCookie(ctx, { session: newSession, user: signedInUser });
        return ctx.json({ redirect: callbackURL });
      },
    ),
  },
});
