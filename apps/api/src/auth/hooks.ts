// Хуки Better Auth (`before`/`after` на `createAuthMiddleware`):
// — Steam отключён как способ входа (`/steam/login` → 404), только привязка
//   (`/steam/link` → `/steam/callback`) к уже вошедшему пользователю;
// — правило последнего способа входа при `/unlink-account`;
// — роль Pocket ID пишется при привязке (`/callback/:id`) и сбрасывается на
//   `player` при отвязке; `steam_id` сбрасывается при отвязке Steam.
import { hasRequestState } from "@better-auth/core/context";
import { account, user } from "@cg/db";
import { canUnlink } from "@cg/rpc";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import type { BetterAuthOptions } from "better-auth/minimal";
import type { drizzle } from "drizzle-orm/bun-sql";
import { eq } from "drizzle-orm";
import { pocketIdRoleState } from "./auth";

/** Drizzle-инстанс из `makeAuth` (`drizzle-orm/bun-sql`, без привязки к схеме). */
type AuthDb = ReturnType<typeof drizzle>;

/**
 * `/unlink-account` — эндпоинт Better Auth валидирует только `accountId`
 * (аккаунт для удаления), но наши хуки дополнительно читают `providerId` из
 * исходного (не прошедшего чужую zod-схему) тела запроса: сами хуки получают
 * `ctx.body` до валидации конкретного эндпоинта, поэтому лишнее для схемы
 * поле всё равно доступно. Фронтенд обязан передавать оба поля.
 */
interface UnlinkAccountBody {
  readonly accountId?: string;
  readonly providerId?: string;
}

/**
 * Хуки Better Auth. `deps.db` — тот же drizzle-инстанс, что использует
 * `drizzleAdapter` в `makeAuth`; `deps.adminGroup` сейчас не используется
 * напрямую (роль Pocket ID уже вычислена в `pocketIdRoleState` к моменту
 * `after`-хука), но входит в сигнатуру по брифу для будущих хуков этого
 * провайдера. `deps.onSteamLinked` — запуск синхронизации библиотеки после
 * успешной привязки Steam (тот же `startSync`, что и `librarySyncHooks`).
 */
export const authHooks = (deps: {
  readonly db: AuthDb;
  readonly adminGroup: string;
  readonly onSteamLinked?: ((userId: string) => void) | undefined;
}): NonNullable<BetterAuthOptions["hooks"]> => ({
  before: createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/steam/login") {
      throw APIError.from("NOT_FOUND", {
        message: "STEAM_LOGIN_DISABLED",
        code: "STEAM_LOGIN_DISABLED",
      });
    }
    if (ctx.path === "/unlink-account") {
      // Сессия ещё не разрешена (наш хук выполняется раньше `use` эндпоинта,
      // в т. ч. `freshSessionMiddleware`) — без неё Better Auth сам ответит 401.
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      const providerId = (ctx.body as UnlinkAccountBody | undefined)
        ?.providerId;
      if (!providerId) return;
      const accounts = await deps.db
        .select({ providerId: account.providerId })
        .from(account)
        .where(eq(account.userId, session.user.id));
      const allowed = canUnlink(accounts, providerId, {
        email: session.user.email,
        emailVerified: session.user.emailVerified,
      });
      if (!allowed) {
        throw APIError.from("BAD_REQUEST", {
          code: "LAST_LOGIN_METHOD",
          message: "Нельзя отвязать последний способ входа",
        });
      }
    }
  }),
  after: createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/unlink-account") {
      // Ошибку (в т. ч. из нашего before-хука) `after` не трогает — удаления не было.
      if (isAPIError(ctx.context.returned)) return;
      const providerId = (ctx.body as UnlinkAccountBody | undefined)
        ?.providerId;
      const session = await getSessionFromCtx(ctx);
      const userId = session?.user.id;
      if (!userId) return;
      if (providerId === "pocket-id") {
        await deps.db
          .update(user)
          .set({ role: "player" })
          .where(eq(user.id, userId));
      } else if (providerId === "steam-openid") {
        await deps.db
          .update(user)
          .set({ steamId: null })
          .where(eq(user.id, userId));
      }
      return;
    }
    // Эндпоинт Better Auth зарегистрирован как `/callback/:id` (общий для всех
    // social/generic-oauth провайдеров) — `ctx.path` отражает шаблон маршрута,
    // не итоговый путь запроса, поэтому провайдер проверяется через `ctx.params`.
    if (ctx.path === "/callback/:id") {
      const params = ctx.params as { readonly id?: string } | undefined;
      if (params?.id !== "pocket-id") return;
      // Режим привязки: пользователь уже вошёл, и callback — редирект на
      // `callbackURL` того же запроса, в котором `mapProfileToUser` выставил
      // роль в `pocketIdRoleState` (он зовётся до ветки линковки в `/callback/:id`).
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      const role = (await hasRequestState())
        ? await pocketIdRoleState.get()
        : null;
      if (role !== null) {
        await deps.db
          .update(user)
          .set({ role })
          .where(eq(user.id, session.user.id));
      }
      return;
    }
    if (ctx.path === "/steam/callback") {
      const returned = ctx.context.returned;
      if (!isAPIError(returned) || returned.statusCode !== 302) return;
      const location = returned.headers
        ? new Headers(returned.headers).get("location")
        : null;
      if (!location) return;
      const redirectUrl = new URL(location, ctx.context.baseURL);
      if (redirectUrl.searchParams.has("error")) return;
      // Steam-вход отключён (`/steam/login` → 404): успешный редирект без
      // `error` здесь — всегда режим привязки, но сессию проверяем явно.
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      deps.onSteamLinked?.(session.user.id);
    }
  }),
});
