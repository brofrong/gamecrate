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

/**
 * Этап запуска уже установленной игры до появления её окна (экран загрузки,
 * спека §2 «Этапы»): `computer` — готовим компьютер (контейнер создаётся и
 * стартует, профиль восстанавливается), `steam` — запускаем Steam (контейнер
 * запущен, клиент стартует), `login` — входим в аккаунт, `prepare` — готовим
 * игру (от старта процесса игры до старта её exe: среда Linux и Proton),
 * `loading` — загружаем игру (от старта exe до появления окна). `visible`
 * («игра видна», §4.2) — конец этапов, дальше обычный `playing`.
 */
export const SessionStage = Schema.Literals([
  "computer",
  "steam",
  "login",
  "prepare",
  "loading",
  "visible",
]);
export type SessionStage = typeof SessionStage.Type;

/**
 * Этап задачи установки игры в общую библиотеку (спека §2 «Этапы», установка):
 * `preparing` — готовим установщик (контейнер создаётся и стартует), `login` —
 * входим в Steam, `library` — Steam вошёл и готовит загрузку (данные
 * библиотеки, общие компоненты), а размера загрузки у игры ещё нет,
 * `downloading` — скачиваем игру, `moving` — переносим игру в библиотеку.
 */
export const InstallStage = Schema.Literals([
  "preparing",
  "login",
  "library",
  "downloading",
  "moving",
]);
export type InstallStage = typeof InstallStage.Type;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Этап на экране загрузки по серверным отметкам (`session_stage_marks` /
 * `install_stage_marks`): `startedAt` — момент отметки этапа (ISO 8601),
 * `endedAt` — момент следующей отметки (у текущего, последнего, — null);
 * `normMs` — «обычно» этапа: медиана последних замеров этой игры (от 5),
 * иначе всех игр (от 5), иначе null — сайт подставляет свою ориентировочную.
 * У `downloading` нормы нет (там процент).
 */
export const StageTiming = Schema.Struct({
  stage: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  normMs: Schema.NullOr(NonNegativeInt),
});
export type StageTiming = typeof StageTiming.Type;

/**
 * Время экрана загрузки:
 * - `serverNow` — «сейчас» сервера на момент ответа (ISO 8601): сайт считает
 *   прошедшее время по нему с поправкой на свои часы;
 * - `launch` — этапы запуска по времени (без `visible`);
 * - `install` — этапы задачи установки, только пока сессия в `installing`;
 * - `launchNormMs` — «обычно» всего запуска (`computer` → `visible`) тем же
 *   правилом, что `normMs`.
 */
export const SessionTiming = Schema.Struct({
  serverNow: Schema.String,
  launch: Schema.Array(StageTiming),
  install: Schema.Array(StageTiming),
  launchNormMs: Schema.NullOr(NonNegativeInt),
});
export type SessionTiming = typeof SessionTiming.Type;

/**
 * Место в очереди (спека §5): `position`/`total` — место и длина очереди по приоритету
 * тарифа, `etaMinutes` — оценка ожидания в минутах (округление и «больше часа» — на
 * сайте, здесь целое число минут или `null`, когда оценить не вышло).
 */
export const SessionQueue = Schema.Struct({
  position: Schema.Int,
  total: Schema.Int,
  etaMinutes: Schema.NullOr(Schema.Int),
});
export type SessionQueue = typeof SessionQueue.Type;

/**
 * Срок остановки сессии по лимиту тарифа (спека §3): `deadline` — ISO 8601 момента,
 * когда закончатся минуты или истечёт длина сессии; `reason` — какой из двух лимитов
 * сработал первым (`sessionLimit`, `@cg/db`).
 */
export const SessionLimitView = Schema.Struct({
  deadline: Schema.String,
  reason: Schema.Literals(["minutes", "session_length"]),
});
export type SessionLimitView = typeof SessionLimitView.Type;

/**
 * Сессия для экрана игры.
 * - `streamReady` — стрим поднят: его можно открыть по `/stream/<id>/`.
 * - `failReason` — причина `failed` (для показа пользователю).
 * - `idleDeadline` — ISO 8601 времени автозакрытия в `idle_warning`, иначе null.
 * - `installPercent` — процент установки игры, только в `installing`, иначе null.
 * - `stage` — этап запуска до появления игрового окна (экран загрузки), иначе null.
 * - `installStage` — этап задачи установки, которую ждёт сессия, иначе null.
 * - `hadInstall` — у сессии была (или есть) задача установки — экран загрузки
 *   может показать её этапы, а не только этапы запуска контейнера.
 * - `timing` — время этапов экрана загрузки (`SessionTiming`); null — сессия
 *   уже не на экране загрузки (`stage = visible` или терминальное состояние).
 * - `playedSeconds` — игровое время сессии (сумма billable-отрезков, открытый — до текущего момента).
 * - `previousPlayedAt` — ISO 8601 конца последнего игрового отрезка пользователя в других его
 *   сессиях (когда он играл до этой), null — других сессий с игрой не было. По нему сайт
 *   повторяет обучение полному экрану после перерыва.
 * - `createdAt` — ISO 8601.
 * - `queue` — место в очереди (спека §5), только пока `state === "queued"` и планировщик
 *   уже посчитал позицию (`sessions.queue_position`); иначе null.
 * - `limit` — срок, когда сессию пора останавливать по лимиту тарифа (спека §3), только в
 *   `playing`/`idle_warning`; иначе null (в т. ч. когда у тарифа лимитов вовсе нет).
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
  stage: Schema.NullOr(SessionStage),
  installStage: Schema.NullOr(InstallStage),
  hadInstall: Schema.Boolean,
  timing: Schema.NullOr(SessionTiming),
  playedSeconds: NonNegativeInt,
  previousPlayedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  queue: Schema.NullOr(SessionQueue),
  limit: Schema.NullOr(SessionLimitView),
});
export type SessionView = typeof SessionView.Type;

/** Игры нет в библиотеке пользователя (или в каталоге) — запустить её нельзя. */
export class GameNotOwned extends Schema.TaggedError<GameNotOwned>()(
  "GameNotOwned",
  { appId: Schema.Int },
) {}

/** Причина `AccessDenied` для игрока (показывается на экране запуска). */
export const accessDeniedReason = "Доступ закрыт";

/** Пользователь заблокирован администратором (`user.blocked_at`) — играть нельзя. */
export class AccessDenied extends Schema.TaggedError<AccessDenied>()(
  "AccessDenied",
  {},
) {}

/** Текст подписи под неактивной кнопкой запуска, когда игра недоступна (спека §3). */
export const noServerReason = "Сейчас нет подходящего сервера";

/** Сейчас нет ни одного воркера, который годится этой игре для пользователя (спека §3). */
export class NoServer extends Schema.TaggedError<NoServer>()("NoServer", {}) {}

/** Текст подписи, когда у игрока не осталось минут по тарифу (спека §3). */
export const noMinutesReason = "Часы закончились";

/** У пользователя не осталось минут по тарифу (`loadBalance`, `@cg/db`) — играть нельзя. */
export class NoMinutes extends Schema.TaggedError<NoMinutes>()(
  "NoMinutes",
  {},
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
 *   сессия — вернуть её (любой игры, даже если минуты уже кончились). Игры нет
 *   в библиотеке — `GameNotOwned`; пользователь заблокирован
 *   (`admin.users.setBlocked`) — `AccessDenied`; минут по тарифу не осталось
 *   (и нет активной сессии) — `NoMinutes`.
 * - `session.active` — активная сессия пользователя или null.
 * - `session.watch` — поток: сразу текущее представление, затем при каждом
 *   изменении (и не реже чем раз в 5 с, пока меняется `playedSeconds`);
 *   завершается после терминального состояния. Чужая/нет — `SessionNotFound`.
 * - `session.heartbeat` — клиент жив; `inputAgeMs` — мс с последнего ввода
 *   пользователя (часы клиента не нужны). `queueOnly` — клиент ещё только
 *   ждёт в очереди (вкладка открыта, но не играет): обновляется только
 *   `client_seen_at`, и только пока сессия и правда `queued` — `last_input_at`
 *   не трогается. Только своя активная сессия.
 * - `session.stop` — попросить остановить; остановку выполняет оркестратор.
 *   Уже завершённая своя сессия — ничего не делает.
 */
export const SessionRpcs = RpcGroup.make(
  Rpc.make("session.start", {
    payload: Schema.Struct({ appId: Schema.Int }),
    success: SessionView,
    error: Schema.Union([GameNotOwned, AccessDenied, NoServer, NoMinutes]),
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
      queueOnly: Schema.optional(Schema.Boolean),
    }),
    error: SessionNotFound,
  }),
  Rpc.make("session.stop", { payload: SessionId, error: SessionNotFound }),
).middleware(AuthMiddleware);
