// Вход в Steam через QR-код установщика: представление попытки для экрана
// `/login-steam` и группа `steamLogin.*` (спека §4).
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AuthMiddleware } from "./auth";

/**
 * Попытка входа для экрана установщика. Внутренние состояния `pending`
 * (строка только создана, кода ещё нет) и `cancelled` не публикуются — `status`
 * видит только `qrUrl` для сканирования, промежуточное `scanned` (телефон
 * подтвердил, установщик входит) и итог (`done`/`expired`/`failed`).
 */
export const SteamLoginView = Schema.Struct({
  attemptId: Schema.String,
  status: Schema.Literals(["waiting", "scanned", "done", "expired", "failed"]),
  qrUrl: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});
export type SteamLoginView = typeof SteamLoginView.Type;

/** Попытки с этим `attemptId` нет, или она принадлежит другому пользователю. */
export class SteamLoginNotFound extends Schema.TaggedError<SteamLoginNotFound>()(
  "SteamLoginNotFound",
  {},
) {}

/**
 * Причины `reason` в `SteamLoginView` при `status: "failed"` (спека §4):
 * у пользователя уже привязан другой Steam, этот Steam привязан к другому
 * аккаунту, попытка прервалась (переподключение агента) или сам Steam не
 * ответил.
 */
export const steamLoginReasons = {
  otherSteamLinked: "Сначала отвяжите текущий Steam",
  steamTaken: "Этот Steam уже привязан к другому аккаунту",
  interrupted: "Вход прервался, покажите новый код",
  steamError: "Steam не ответил, попробуйте ещё раз",
} as const;

/**
 * - `steamLogin.start` — завести новую попытку входа, возвращает её id
 *   (QR появится после обработки установщиком, Task 5).
 * - `steamLogin.status` — текущее состояние попытки для поллинга/подписки
 *   экрана; чужая или отсутствующая — `SteamLoginNotFound`.
 */
export const SteamLoginRpcs = RpcGroup.make(
  Rpc.make("steamLogin.start", {
    success: Schema.Struct({ attemptId: Schema.String }),
  }),
  Rpc.make("steamLogin.status", {
    payload: Schema.Struct({ attemptId: Schema.String }),
    success: SteamLoginView,
    error: SteamLoginNotFound,
  }),
).middleware(AuthMiddleware);
