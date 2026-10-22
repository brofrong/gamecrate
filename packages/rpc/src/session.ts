// Игровые сессии: представление сессии для SPA, ошибки и группа `session.*`.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AuthMiddleware } from "./auth";

/**
 * Состояние сессии (точные строки спеки, совпадают с `sessionStates` в `@cg/db`).
 * Активная сессия — не `ended`/`failed`.
 */
export const SessionState = Schema.Literals([
  "queued",
  "installing",
  "starting",
  "playing",
  "idle_warning",
  "disconnected",
  "stopping",
  "ended",
  "failed",
]);
export type SessionState = typeof SessionState.Type;

/** Терминальные состояния: после них сессия больше не меняется. */
export const isTerminalSessionState = (state: SessionState): boolean =>
  state === "ended" || state === "failed";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Сессия для экрана игры.
 * - `streamReady` — стрим поднят: его можно открыть по `/stream/<id>/`.
 * - `failReason` — причина `failed` (для показа пользователю).
 * - `idleDeadline` — ISO 8601 времени автозакрытия в `idle_warning`, иначе null.
 * - `installPercent` — процент установки игры, только в `installing`, иначе null.
 * - `playedSeconds` — игровое время сессии (сумма billable-отрезков, открытый — до текущего момента).
 * - `createdAt` — ISO 8601.
 */
export const SessionView = Schema.Struct({
  id: Schema.String,
  appId: Schema.Int,
  gameName: Schema.String,
  state: SessionState,
  streamReady: Schema.Boolean,
  failReason: Schema.NullOr(Schema.String),
  idleDeadline: Schema.NullOr(Schema.String),
  installPercent: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
  playedSeconds: NonNegativeInt,
  createdAt: Schema.String,
});
export type SessionView = typeof SessionView.Type;

/** Игры нет в библиотеке пользователя (или в каталоге) — запустить её нельзя. */
export class GameNotOwned extends Schema.TaggedError<GameNotOwned>()(
  "GameNotOwned",
  { appId: Schema.Int },
) {}

/** Сессии нет или она чужая (существование чужих сессий не раскрывается). */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { sessionId: Schema.String },
) {}

const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Формат id сессии: uuid в нижнем регистре (`crypto.randomUUID()` в
 * `session.start`). Другой формат — сессии заведомо нет; проверяется до запроса
 * к БД (иначе, например, `\0` в тексте — ошибка Postgres).
 */
export const isSessionId = (id: string): boolean => sessionIdPattern.test(id);

/** Максимум `inputAgeMs` в heartbeat; больше — считается равным ему. */
export const maxInputAgeMs = 24 * 60 * 60 * 1000;

const SessionId = Schema.Struct({ sessionId: Schema.String });

/**
 * - `session.start` — запустить игру; если у пользователя уже есть активная
 *   сессия — вернуть её (любой игры). Игры нет в библиотеке — `GameNotOwned`.
 * - `session.active` — активная сессия пользователя или null.
 * - `session.watch` — поток: сразу текущее представление, затем при каждом
 *   изменении (и не реже чем раз в 5 с, пока меняется `playedSeconds`);
 *   завершается после терминального состояния. Чужая/нет — `SessionNotFound`.
 * - `session.heartbeat` — клиент жив; `inputAgeMs` — мс с последнего ввода
 *   пользователя (часы клиента не нужны). Только своя активная сессия.
 * - `session.stop` — попросить остановить; остановку выполняет оркестратор.
 *   Уже завершённая своя сессия — ничего не делает.
 */
export const SessionRpcs = RpcGroup.make(
  Rpc.make("session.start", {
    payload: Schema.Struct({ appId: Schema.Int }),
    success: SessionView,
    error: GameNotOwned,
  }),
  Rpc.make("session.active", { success: Schema.NullOr(SessionView) }),
  Rpc.make("session.watch", {
    payload: SessionId,
    success: SessionView,
    error: SessionNotFound,
    stream: true,
  }),
  Rpc.make("session.heartbeat", {
    payload: Schema.Struct({
      sessionId: Schema.String,
      inputAgeMs: NonNegativeInt,
    }),
    error: SessionNotFound,
  }),
  Rpc.make("session.stop", { payload: SessionId, error: SessionNotFound }),
).middleware(AuthMiddleware);
