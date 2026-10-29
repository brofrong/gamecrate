// Хуки Better Auth (`before`/`after` на `createAuthMiddleware`):
// — Steam отключён как способ входа (`/steam/login` → 404), только привязка
//   (`/steam/link` → `/steam/callback`) к уже вошедшему пользователю;
// — правило последнего способа входа при `/unlink-account`;
// — роль Pocket ID пишется при привязке (`/callback/:id`) и сбрасывается на
//   `player` при отвязке; `steam_id` сбрасывается при отвязке Steam, и той же
//   записью ставится `steam_login_reset_at = now` (тот же механизм, что
//   «Сбросить вход Steam» в админке): оркестратор выбросит посев, сделанный
//   до отвязки, агент при следующем старте сотрёт вход из профиля; строку
//   `steam_login_seeds` пользователя стираем здесь же — отвязка убирает
//   credential сразу, не дожидаясь следующего запуска или `SEED_TTL`.
import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import { account, steamLoginSeeds, user } from "@cg/db";
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
import { Effect } from "effect";
import { pocketIdRoleState } from "./auth";

/** Drizzle-инстанс из `makeAuth` (`drizzle-orm/bun-sql`, без привязки к схеме). */
type AuthDb = ReturnType<typeof drizzle>;

/**
 * `/unlink-account` — эндпоинт Better Auth валидирует (и резолвит удаляемый
 * ряд) только по `accountId` — это Better Auth ID ряда `account`, а не внешний
 * `accountId` провайдера (см. `dist/api/routes/account.mjs`: `accounts.find(a
 * => a.id === accountId)`). Тело не несёт `providerId` вовсе — доверять клиенту
 * в вопросе «какой это провайдер» нельзя (тело может не совпадать с реальным
 * рядом), поэтому `before`-хук сам резолвит ряд по `accountId` из БД, как это
 * делает сам эндпоинт.
 */
interface UnlinkAccountBody {
  readonly accountId?: string;
}

/**
 * `providerId` ряда `account`, который `before`-хук на `/unlink-account`
 * резолвил по `accountId` и разрешил удалить — `after`-хук этого же запроса
 * берёт его отсюда (не из тела: см. `UnlinkAccountBody`), потому что к моменту
 * `after` сам ряд уже удалён эндпоинтом и его провайдера из БД не достать.
 */
const unlinkProviderIdState = defineRequestState<string | null>(() => null);

/** Канонический `providerId` аккаунта Steam, который пишет `better-auth-steam`
 * при привязке/входе (`PROVIDER_ID` в его исходниках) — не путать с id плагина
 * `"steam-openid"`, под которым он зарегистрирован в `plugins`. */
const STEAM_PROVIDER_ID = "steam";

/**
 * После-хуки пишут в БД уже после того, как Better Auth закоммитил основную
 * мутацию (unlink/link) — провал этой записи не должен превращать уже
 * успешный ответ в ошибку (пользователь увидит 200, хотя роль/steamId не
 * обновились), но и не должен проходить незамеченным. Лог — тем же стилем,
 * что `librarySyncHooks` в `auth.ts` (`Effect.runFork(Effect.logError(...))`),
 * без секретов: только userId и providerId.
 */
const runAfterHookWrite = async (
  message: string,
  userId: string,
  providerId: string,
  write: () => Promise<unknown>,
): Promise<void> => {
  try {
    await write();
  } catch (cause) {
    Effect.runFork(
      Effect.logError(message, { userId, providerId, cause: String(cause) }),
    );
  }
};

/**
 * `/steam/callback` и `/callback/:id` всегда завершаются редиректом — успех и
 * отказ одинаково бросают `ctx.redirect(...)` (значит, `ctx.context.returned`
 * — `APIError` "FOUND" в обоих случаях; `isAPIError` сам по себе успех от
 * отказа не отличает). Разница — только в `?error=...` на итоговом URL
 * (`redirectWithError`/`redirectOnError` его добавляют, обычный редирект на
 * `callbackURL` — нет).
 */
const isSuccessRedirect = (returned: unknown, baseURL: string): boolean => {
  if (!isAPIError(returned) || returned.statusCode !== 302) return false;
  const location = returned.headers
    ? new Headers(returned.headers).get("location")
    : null;
  if (!location) return false;
  return !new URL(location, baseURL).searchParams.has("error");
};

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
      const accountId = (ctx.body as UnlinkAccountBody | undefined)?.accountId;
      if (!accountId) return;
      const accounts = await deps.db
        .select({ id: account.id, providerId: account.providerId })
        .from(account)
        .where(eq(account.userId, session.user.id));
      // Резолвим ряд так же, как сам эндпоинт (`accounts.find(a => a.id ===
      // accountId)`) — тело не несёт providerId, значения из тела доверять
      // нельзя. Ряд не нашёлся — не наша забота, эндпоинт ответит сам
      // (ACCOUNT_NOT_FOUND).
      const target = accounts.find((candidate) => candidate.id === accountId);
      if (!target) return;
      const allowed = canUnlink(accounts, target.providerId, {
        email: session.user.email,
        emailVerified: session.user.emailVerified,
      });
      if (!allowed) {
        throw APIError.from("BAD_REQUEST", {
          code: "LAST_LOGIN_METHOD",
          message: "Нельзя отвязать последний способ входа",
        });
      }
      // Разрешили — запоминаем провайдера для after-хука этого же запроса:
      // после успешного удаления ряда в БД его уже не будет.
      await unlinkProviderIdState.set(target.providerId);
    }
  }),
  after: createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/unlink-account") {
      // Ошибку (в т. ч. из нашего before-хука) `after` не трогает — удаления не было.
      if (isAPIError(ctx.context.returned)) return;
      const providerId = (await hasRequestState())
        ? await unlinkProviderIdState.get()
        : null;
      if (!providerId) return;
      const session = await getSessionFromCtx(ctx);
      const userId = session?.user.id;
      if (!userId) return;
      if (providerId === "pocket-id") {
        await runAfterHookWrite(
          "Failed to reset role after pocket-id unlink",
          userId,
          providerId,
          () =>
            deps.db
              .update(user)
              .set({ role: "player" })
              .where(eq(user.id, userId)),
        );
      } else if (providerId === STEAM_PROVIDER_ID) {
        // Тем же обновлением помечаем сброс входа (`steam_login_reset_at`),
        // как «Сбросить вход Steam» в админке (Task 3) — отдельного запроса
        // не нужно, оба поля летят одной мутацией; посев (`steam_login_seeds`)
        // убираем в этот же момент, а не ждём `clearOlderThan` на следующем
        // запуске или `SEED_TTL` (M3) — строки не связаны FK-транзакцией с
        // `user`, поэтому удаление отдельным запросом в той же попытке записи.
        await runAfterHookWrite(
          "Failed to reset steamId after steam unlink",
          userId,
          providerId,
          () =>
            Promise.all([
              deps.db
                .update(user)
                .set({ steamId: null, steamLoginResetAt: new Date() })
                .where(eq(user.id, userId)),
              deps.db
                .delete(steamLoginSeeds)
                .where(eq(steamLoginSeeds.userId, userId)),
            ]),
        );
      }
      return;
    }
    // Эндпоинт Better Auth зарегистрирован как `/callback/:id` (общий для всех
    // social/generic-oauth провайдеров) — `ctx.path` отражает шаблон маршрута,
    // не итоговый путь запроса, поэтому провайдер проверяется через `ctx.params`.
    if (ctx.path === "/callback/:id") {
      const params = ctx.params as { readonly id?: string } | undefined;
      if (params?.id !== "pocket-id") return;
      // Callback мог упасть (включая редирект-с-ошибкой через ctx.redirect —
      // успех этого эндпоинта тоже редирект, поэтому `isAPIError` одной не
      // различить: см. `isSuccessRedirect`) — роль пишем только при реальном
      // успехе, как и /unlink-account выше.
      if (!isSuccessRedirect(ctx.context.returned, ctx.context.baseURL)) {
        return;
      }
      // Режим привязки: пользователь уже вошёл, и callback — редирект на
      // `callbackURL` того же запроса, в котором `mapProfileToUser` выставил
      // роль в `pocketIdRoleState` (он зовётся до ветки линковки в `/callback/:id`).
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      const role = (await hasRequestState())
        ? await pocketIdRoleState.get()
        : null;
      if (role !== null) {
        await runAfterHookWrite(
          "Failed to set role after pocket-id link",
          session.user.id,
          "pocket-id",
          () =>
            deps.db
              .update(user)
              .set({ role })
              .where(eq(user.id, session.user.id)),
        );
      }
      return;
    }
    if (ctx.path === "/steam/callback") {
      if (!isSuccessRedirect(ctx.context.returned, ctx.context.baseURL)) {
        return;
      }
      // Steam-вход отключён (`/steam/login` → 404): успешный редирект без
      // `error` здесь — всегда режим привязки, но сессию проверяем явно.
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      deps.onSteamLinked?.(session.user.id);
    }
  }),
});
