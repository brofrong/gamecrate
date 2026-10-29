// Вход в Steam по QR на сайте: представление попытки и группа `steamLogin.*`
// (спека §4). API заводит попытку, оркестратор проводит QR-вход steam-session
// и привязывает Steam к аккаунту, сайт опрашивает статус; полученный вход
// вписывается в следующий контейнер пользователя (сессия или установщик).
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AuthMiddleware } from "./auth";

/**
 * Попытка входа для экрана «Вход в Steam по QR». Внутренние состояния `pending`
 * (строка только создана, кода ещё нет) и `cancelled` не публикуются — `status`
 * видит только `qrUrl` для сканирования, промежуточное `scanned` (телефон
 * подтвердил, оркестратор завершает вход) и итог (`done`/`expired`/`failed`).
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
 * аккаунту, попытка прервалась (переподключение агента), QR не был отсканирован
 * вовсе, или код отсканирован, но вход не подтверждён (не принят/неверные
 * ответы в приложении Steam) — `notConfirmed` вместо `steamError` после
 * события `Scanned` в той же попытке (решение исполнителя спеки §4).
 */
export const steamLoginReasons = {
  otherSteamLinked: "Сначала отвяжите текущий Steam",
  steamTaken: "Этот Steam уже привязан к другому аккаунту",
  interrupted: "Вход прервался, покажите новый код",
  steamError: "Steam не ответил, попробуйте ещё раз",
  notConfirmed: "Вход не подтверждён в приложении Steam, попробуйте ещё раз",
} as const;

/**
 * - `steamLogin.start` — завести новую попытку входа, возвращает её id
 *   (QR появится, когда оркестратор начнёт QR-вход у Steam).
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
