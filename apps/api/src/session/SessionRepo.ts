// Сессии пользователя в БД для `session.*` и прокси стрима: создание,
// представление `SessionView`, heartbeat и запрос остановки.
import {
  Db,
  gameAvailable,
  games,
  type InstallStage as DbInstallStage,
  installJobs,
  installStageMarks,
  loadBalance,
  ownGameOf,
  playSegments,
  sessionLimit,
  type SessionStage as DbSessionStage,
  type SessionState as DbSessionState,
  sessionStageMarks,
  sessions,
  user,
  userGames,
} from "@cg/db";
import {
  isOwnAppId,
  isSessionId,
  type SessionLimitView,
  type SessionQueue,
  type SessionState,
  type SessionTiming,
  type SessionView,
  type StageTiming,
} from "@cg/rpc";
import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  max,
  ne,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { loadSessionSettings } from "../admin/settings";
import * as StageNorms from "./StageNorms";

// Состояния в `@cg/db` и `@cg/rpc` — один и тот же список строк.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const statesMatch: Same<SessionState, DbSessionState> = true;
void statesMatch;

/** Терминальные состояния сессии (см. `isTerminalSessionState` в `@cg/rpc`). */
export const terminalStates: Array<DbSessionState> = ["ended", "failed"];

/**
 * Условие «сессия активна» (не `ended`/`failed`) — единственное определение,
 * переиспользуется в `apps/api/src/admin/{sessions,workers}.ts` (своя копия
 * этого условия там не нужна).
 */
export const isActive = notInArray(sessions.state, terminalStates);

/**
 * Условие «слот воркера удерживается» — своя копия того же условия, что и в
 * `apps/orchestrator/src/SessionRepo.ts` (`holdsSlot`): строка может быть уже
 * `ended`/`failed`, но контейнер на GPU воркера ещё не погашен (агент не
 * прислал `Stopped`/`Failed`). Используется в `admin/games.ts`, чтобы не
 * удалять игру, пока её контейнер ещё жив.
 */
export const holdsSlot = and(
  isNotNull(sessions.slot),
  isNull(sessions.slotReleasedAt),
);

/** Строка сессии вместе с названием игры и байтами её задачи установки (если есть). */
const sessionWithGame = {
  id: sessions.id,
  userId: sessions.userId,
  appId: sessions.appId,
  gameName: games.name,
  state: sessions.state,
  streamUrl: sessions.streamUrl,
  failReason: sessions.failReason,
  stateSince: sessions.stateSince,
  createdAt: sessions.createdAt,
  installJobId: sessions.installJobId,
  stage: sessions.stage,
  installStage: installJobs.stage,
  installBytesDownloaded: installJobs.bytesDownloaded,
  installBytesTotal: installJobs.bytesTotal,
  queuePosition: sessions.queuePosition,
  queueTotal: sessions.queueTotal,
  queueEtaMinutes: sessions.queueEtaMinutes,
};

type SessionWithGame = {
  readonly id: string;
  readonly userId: string;
  readonly appId: number;
  readonly gameName: string;
  readonly state: DbSessionState;
  readonly streamUrl: string | null;
  readonly failReason: string | null;
  readonly stateSince: Date;
  readonly createdAt: Date;
  readonly installJobId: string | null;
  readonly stage: DbSessionStage | null;
  readonly installStage: DbInstallStage | null;
  readonly installBytesDownloaded: number | null;
  readonly installBytesTotal: number | null;
  readonly queuePosition: number | null;
  readonly queueTotal: number | null;
  readonly queueEtaMinutes: number | null;
};

/** Сессии с названием игры, отобранные по `where`. */
const selectSessions = (where: SQL | undefined) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select(sessionWithGame)
      .from(sessions)
      .innerJoin(games, eq(sessions.appId, games.appId))
      .leftJoin(installJobs, eq(sessions.installJobId, installJobs.id))
      .where(where);
  });

/**
 * Процент установки: `bytesDownloaded`/`bytesTotal` задачи установки, `0` пока
 * `bytesTotal` не пришёл (ещё 0 или неизвестен) — не деление на 0; всегда в
 * 0..100 (скачано бывает больше заявленного). Только в
 * `installing`: `installJobId` не очищается после установки (история), поэтому
 * в других состояниях процент не считаем.
 */
const installPercentOf = (
  state: DbSessionState,
  bytesDownloaded: number | null,
  bytesTotal: number | null,
): number | null => {
  if (state !== "installing") return null;
  if (bytesTotal === null || bytesTotal === 0) return 0;
  const percent = Math.floor((100 * (bytesDownloaded ?? 0)) / bytesTotal);
  return Math.min(100, Math.max(0, percent));
};

/**
 * Этап задачи установки, которую сессия ждёт (экран загрузки) — как
 * `installPercentOf`, только в `installing`: `installJobId` не очищается
 * после установки (история), поэтому в других состояниях этап не её.
 */
const installStageOf = (
  state: DbSessionState,
  installStage: DbInstallStage | null,
): DbInstallStage | null => (state === "installing" ? installStage : null);

/**
 * Игровое время сессии в секундах: сумма billable-отрезков, открытый — до `now`
 * (а не до сохранённого `endedAt`, который продлевается только heartbeat'ом агента).
 */
const playedSeconds = (sessionId: string, now: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const segments = yield* db
      .select({
        startedAt: playSegments.startedAt,
        endedAt: playSegments.endedAt,
        open: playSegments.open,
      })
      .from(playSegments)
      .where(
        and(
          eq(playSegments.sessionId, sessionId),
          eq(playSegments.billable, true),
        ),
      );
    const totalMs = segments.reduce((sum, segment) => {
      const end = segment.open ? now : segment.endedAt;
      return sum + Math.max(0, end.getTime() - segment.startedAt.getTime());
    }, 0);
    return Math.floor(totalMs / 1000);
  });

/**
 * Когда пользователь играл до этой сессии: конец последнего его отрезка в других сессиях
 * (индекс `play_segments_user_ended_idx`), null — не играл.
 */
const previousPlayedAt = (userId: string, sessionId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ endedAt: max(playSegments.endedAt) })
      .from(playSegments)
      .where(
        and(
          eq(playSegments.userId, userId),
          ne(playSegments.sessionId, sessionId),
        ),
      );
    return row?.endedAt ?? null;
  });

/**
 * Отметки этапов по времени → `StageTiming`: этап кончается со следующей
 * отметкой (последний — ещё идёт, `endedAt` null), норма — `normOf(stage)`.
 */
const stageTimings = <S extends string>(
  marks: ReadonlyArray<{ readonly stage: S; readonly at: Date }>,
  normOf: (stage: S) => number | undefined,
): Array<StageTiming> =>
  marks.map((mark, i) => ({
    stage: mark.stage,
    startedAt: mark.at.toISOString(),
    endedAt: marks[i + 1]?.at.toISOString() ?? null,
    normMs: normOf(mark.stage) ?? null,
  }));

/**
 * Время экрана загрузки (`SessionView.timing`): null, когда сессия уже не на
 * нём (`stage = visible` или терминальное состояние) — тогда ни отметки, ни
 * нормы не читаются. Отметки установки — только в `installing` (как
 * `installStageOf`: `installJobId` после установки остаётся для истории).
 * Нормы — `StageNorms.normsFor` (кэш по `appId`), у `downloading` нормы нет.
 *
 * `serverNow` ниже — часы процесса api, а отметки этапов (`session_stage_marks`/
 * `install_stage_marks`) пишет оркестратор своими часами (`SessionRunner`):
 * корректно, пока api и оркестратор — один хост с одним системным клоком. При
 * переходе на несколько хостов `serverNow` надо брать из БД (`now()`), а не из
 * часов процесса api.
 */
const timingOf = (row: SessionWithGame, now: Date) =>
  Effect.gen(function* () {
    if (terminalStates.includes(row.state) || row.stage === "visible") {
      return null;
    }
    const db = yield* Db;
    const launchMarks = yield* db
      .select({ stage: sessionStageMarks.stage, at: sessionStageMarks.at })
      .from(sessionStageMarks)
      .where(eq(sessionStageMarks.sessionId, row.id))
      .orderBy(asc(sessionStageMarks.at));
    const installJobId = row.state === "installing" ? row.installJobId : null;
    const installMarks =
      installJobId === null
        ? []
        : yield* db
            .select({
              stage: installStageMarks.stage,
              at: installStageMarks.at,
            })
            .from(installStageMarks)
            .where(eq(installStageMarks.jobId, installJobId))
            .orderBy(asc(installStageMarks.at));
    const norms = yield* StageNorms.normsFor(row.appId);
    return {
      serverNow: now.toISOString(),
      launch: stageTimings(launchMarks, (stage) => norms.launch[stage]).filter(
        (timing) => timing.stage !== "visible",
      ),
      install: stageTimings(installMarks, (stage) =>
        stage === "downloading" ? undefined : norms.install[stage],
      ),
      launchNormMs: norms.launchTotal,
    } satisfies SessionTiming;
  });

/**
 * `SessionView.queue`: только в `queued` с посчитанной позицией
 * (`queuePosition` не null — планировщик очереди пишет все три поля одним
 * отчётом, `queueTotal`/`queueEtaMinutes` защищаемся запасным значением
 * просто на случай рассинхрона, а не ломаем вид отсутствующим числом).
 */
const queueOf = (row: SessionWithGame): SessionQueue | null => {
  if (row.state !== "queued" || row.queuePosition === null) return null;
  return {
    position: row.queuePosition,
    total: row.queueTotal ?? row.queuePosition,
    etaMinutes: row.queueEtaMinutes,
  };
};

/**
 * `SessionView.limit`: только в `playing`/`idle_warning`, когда у тарифа
 * действует лимит минут или длины сессии (`sessionLimit`, `@cg/db`);
 * `deadline` — `now + max(0, remainingMs)` (остаток не бывает отрицательным
 * на экране, даже если расчёт между тиками на миг ушёл в долг).
 */
const limitOf = (row: SessionWithGame, now: Date) =>
  Effect.gen(function* () {
    if (row.state !== "playing" && row.state !== "idle_warning") return null;
    const limit = yield* sessionLimit(row.userId, row.id, now);
    if (limit === null) return null;
    return {
      deadline: new Date(
        now.getTime() + Math.max(0, limit.remainingMs),
      ).toISOString(),
      reason: limit.reason,
    } satisfies SessionLimitView;
  });

/** `SessionView` из строки: игровое время и (в `idle_warning`) срок автозакрытия. */
const toView = (row: SessionWithGame) =>
  Effect.gen(function* () {
    const now = yield* DateTime.nowAsDate;
    const idleDeadline =
      row.state === "idle_warning"
        ? new Date(
            row.stateSince.getTime() +
              (yield* loadSessionSettings).idleGraceMinutes * 60_000,
          ).toISOString()
        : null;
    return {
      id: row.id,
      appId: row.appId,
      gameName: row.gameName,
      state: row.state,
      streamReady: row.streamUrl !== null,
      failReason: row.failReason,
      idleDeadline,
      installPercent: installPercentOf(
        row.state,
        row.installBytesDownloaded,
        row.installBytesTotal,
      ),
      stage: row.stage,
      installStage: installStageOf(row.state, row.installStage),
      hadInstall: row.installJobId !== null,
      timing: yield* timingOf(row, now),
      playedSeconds: yield* playedSeconds(row.id, now),
      previousPlayedAt:
        (yield* previousPlayedAt(row.userId, row.id))?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      queue: queueOf(row),
      limit: yield* limitOf(row, now),
    } satisfies SessionView;
  });

/** Активная сессия пользователя (не более одной — частичный уникальный индекс). */
const activeRow = (userId: string) =>
  Effect.gen(function* () {
    const [row] = yield* selectSessions(
      and(eq(sessions.userId, userId), isActive),
    );
    return row;
  });

/** Представление активной сессии пользователя или null. */
export const activeView = (
  userId: string,
): Effect.Effect<SessionView | null, never, Db> =>
  activeRow(userId).pipe(
    Effect.flatMap((row) =>
      row === undefined ? Effect.succeed(null) : toView(row),
    ),
    Effect.orDie,
  );

// Функции по `sessionId` из запроса сначала проверяют формат (`isSessionId`):
// не uuid — сессии заведомо нет, БД не спрашиваем.

/** Представление сессии пользователя; чужая или нет — undefined. */
export const ownView = (
  userId: string,
  sessionId: string,
): Effect.Effect<SessionView | undefined, never, Db> =>
  Effect.gen(function* () {
    if (!isSessionId(sessionId)) return undefined;
    const [row] = yield* selectSessions(
      and(eq(sessions.id, sessionId), eq(sessions.userId, userId)),
    );
    return row === undefined ? undefined : yield* toView(row);
  }).pipe(Effect.orDie);

/** Пользователь заблокирован администратором (`admin.users.setBlocked`). */
const isBlocked = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ blockedAt: user.blockedAt })
      .from(user)
      .where(eq(user.id, userId));
    return row?.blockedAt !== null && row?.blockedAt !== undefined;
  });

/**
 * Игра есть и в каталоге, и в библиотеке пользователя. Своя игра
 * (`isOwnAppId`) — в библиотеке у всех, пока она открыта игрокам
 * (`own_games.published`); Steam не нужен.
 */
const ownsGame = (userId: string, appId: number) =>
  Effect.gen(function* () {
    if (isOwnAppId(appId)) return (yield* ownGameOf(appId))?.published === true;
    const db = yield* Db;
    const [row] = yield* db
      .select({ appId: games.appId })
      .from(userGames)
      .innerJoin(games, eq(userGames.appId, games.appId))
      .where(and(eq(userGames.userId, userId), eq(userGames.appId, appId)));
    return row !== undefined;
  });

/**
 * Активная сессия пользователя: существующая (любой игры) или новая `queued`
 * для `appId`. Пользователь заблокирован (`user.blocked_at`) — `"Blocked"`
 * (проверяется до владения игрой — блокировка важнее отсутствия игры). Игры
 * нет в библиотеке — `"NotOwned"`. Минут по тарифу не осталось
 * (`loadBalance`, `@cg/db`, спека §3) — `"NoMinutes"` (проверяется только
 * когда активной сессии ещё нет — уже идущую игру нехватка минут не
 * прерывает, это сделает отдельный тик оркестратора). Игра недоступна — нет
 * сейчас ни одного подходящего воркера (`gameAvailable`, спека §3) —
 * `"NoServer"`; уже активная сессия (любой игры) возвращается как есть, без
 * проверок минут/доступности — игра могла стать недоступной или минуты
 * кончиться уже после запуска. Новая сессия сохраняет приоритет очереди
 * (`queuePriority`) действующего тарифа на момент постановки — тариф может
 * поменяться позже, сессия приоритет не пересчитывает. Гонка двух вызовов
 * решается частичным уникальным индексом: вставка без конфликта не проходит
 * (`ON CONFLICT DO NOTHING`), и проигравший читает сессию победителя.
 */
export const startSession = (
  userId: string,
  appId: number,
): Effect.Effect<
  SessionView | "NotOwned" | "Blocked" | "NoServer" | "NoMinutes",
  never,
  Db
> =>
  Effect.gen(function* () {
    if (yield* isBlocked(userId)) return "Blocked" as const;
    if (!(yield* ownsGame(userId, appId))) return "NotOwned" as const;
    const db = yield* Db;
    // Активная сессия может закончиться между вставкой и чтением — тогда ещё попытка.
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = yield* activeRow(userId);
      if (existing !== undefined) return yield* toView(existing);
      const now = yield* DateTime.nowAsDate;
      const balance = yield* loadBalance(userId, now);
      if (balance.remainingMs !== null && balance.remainingMs <= 0)
        return "NoMinutes" as const;
      if (!(yield* gameAvailable(userId, appId, now)))
        return "NoServer" as const;
      const inserted = yield* db
        .insert(sessions)
        .values({
          id: crypto.randomUUID(),
          userId,
          appId,
          state: "queued",
          queuePriority: balance.tariff.queuePriority,
        })
        .onConflictDoNothing()
        .returning({ id: sessions.id });
      if (inserted.length > 0) {
        const created = yield* activeRow(userId);
        if (created !== undefined) return yield* toView(created);
      }
    }
    return yield* Effect.die(
      new Error(`Could not start a session for user ${userId}`),
    );
  }).pipe(Effect.orDie);

/** Максимум `inputAgeMs`: больше суток — считается сутками. */
export const clampInputAge = (inputAgeMs: number, max: number) =>
  Math.min(Math.max(0, Math.floor(inputAgeMs)), max);

/**
 * Heartbeat клиента для своей активной сессии: `clientSeenAt = now`,
 * `lastInputAt = now - inputAgeMs` (не раньше уже записанного — вторая вкладка
 * без ввода не отодвигает время последнего ввода назад). `queueOnly` — клиент
 * только ждёт в очереди (вкладка открыта, не играет): обновляется только
 * `clientSeenAt`, и только пока сессия и правда `queued` — `lastInputAt` не
 * трогается вовсе (нет ввода, который можно было бы записать). Сессия уже не
 * `queued` (ушла дальше, пока клиент ещё слал `queueOnly`) — не ошибка, просто
 * ничего не обновляется, сессия своя и активна. Нет такой активной сессии —
 * false.
 */
export const heartbeat = (
  userId: string,
  sessionId: string,
  inputAgeMs: number,
  queueOnly: boolean,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    if (!isSessionId(sessionId)) return false;
    const db = yield* Db;
    const now = yield* DateTime.nowAsDate;
    const own = and(
      eq(sessions.id, sessionId),
      eq(sessions.userId, userId),
      isActive,
    );
    if (queueOnly) {
      yield* db
        .update(sessions)
        .set({ clientSeenAt: now })
        .where(and(own, eq(sessions.state, "queued")));
      const [found] = yield* db
        .select({ id: sessions.id })
        .from(sessions)
        .where(own);
      return found !== undefined;
    }
    const lastInputAt = new Date(now.getTime() - inputAgeMs);
    const updated = yield* db
      .update(sessions)
      .set({
        clientSeenAt: now,
        lastInputAt: sql`greatest(${sessions.lastInputAt}, ${lastInputAt.toISOString()}::timestamptz)`,
      })
      .where(own)
      .returning({ id: sessions.id });
    return updated.length > 0;
  }).pipe(Effect.orDie);

/**
 * Выражение `stop_requested_at = coalesce(stop_requested_at, now)` (первый
 * запрос не перезаписывается) — общее для `stopSession` здесь и `setBlocked`
 * в `apps/api/src/admin/users.ts` (там блокировка останавливает активные
 * сессии той же логикой).
 */
export const requestStopAt = (now: Date): SQL =>
  sql`coalesce(${sessions.stopRequestedAt}, ${now.toISOString()}::timestamptz)`;

/**
 * Общая логика остановки: сессия найдена под `extraCondition` (например,
 * владелец) — активной выставляется `stopRequestedAt = coalesce(..., now)`
 * (первый запрос не перезаписывается), завершённой — ничего; формат id
 * неверный или по `extraCondition` сессии нет — `false`. `requestStop`
 * (игрок, свою сессию) и `adminStop` (админка, apps/api/src/admin/sessions.ts,
 * любую сессию, без проверки владельца) — её частные случаи.
 */
const stopSession = (
  sessionId: string,
  extraCondition: SQL | undefined,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    if (!isSessionId(sessionId)) return false;
    const db = yield* Db;
    const now = yield* DateTime.nowAsDate;
    const idCondition = eq(sessions.id, sessionId);
    const [found] = yield* db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        extraCondition === undefined
          ? idCondition
          : and(idCondition, extraCondition),
      );
    if (found === undefined) return false;
    yield* db
      .update(sessions)
      .set({ stopRequestedAt: requestStopAt(now) })
      .where(and(idCondition, isActive));
    return true;
  }).pipe(Effect.orDie);

/**
 * Запрос остановки своей сессии: активной — `stopRequestedAt = now` (первый
 * запрос не перезаписывается), завершённой — ничего. Чужая/нет — false.
 */
export const requestStop = (
  userId: string,
  sessionId: string,
): Effect.Effect<boolean, never, Db> =>
  stopSession(sessionId, eq(sessions.userId, userId));

/**
 * Остановка любой сессии администратором (без проверки владельца) — та же
 * логика `stopRequestedAt`, что и у `requestStop`.
 */
export const adminStop = (
  sessionId: string,
): Effect.Effect<boolean, never, Db> => stopSession(sessionId, undefined);

/**
 * Адрес стрима сессии для прокси: только своя активная сессия с готовым
 * стримом, иначе undefined.
 */
export const streamUrlOf = (
  userId: string,
  sessionId: string,
): Effect.Effect<string | undefined, never, Db> =>
  Effect.gen(function* () {
    if (!isSessionId(sessionId)) return undefined;
    const db = yield* Db;
    const [row] = yield* db
      .select({ streamUrl: sessions.streamUrl })
      .from(sessions)
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isActive),
      );
    return row?.streamUrl ?? undefined;
  }).pipe(Effect.orDie);
