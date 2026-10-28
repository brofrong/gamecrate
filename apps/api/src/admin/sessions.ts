// Сессии для админки: журнал (активные + недавние) и остановка без проверки
// владельца — по образцу `SessionRepo`, но для любой сессии, не только своей.
import {
  Db,
  games,
  type SessionStage as DbSessionStage,
  type SessionState as DbSessionState,
  sessions,
  user,
} from "@cg/db";
import { type AdminSession, isSessionId } from "@cg/rpc";
import { and, desc, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";

const terminalStates: Array<DbSessionState> = ["ended", "failed"];

/** Условие «сессия активна» (не `ended`/`failed`), как в `SessionRepo`. */
const isActive = notInArray(sessions.state, terminalStates);

/** Окно «недавних» сессий и предел их числа (спека §«Сессии»). */
const recentWindowMs = 7 * 24 * 60 * 60 * 1000;
const recentLimit = 50;

/** Столбцы `AdminSession` одним select'ом с join `user`/`games` (без N+1). */
const adminSessionColumns = {
  id: sessions.id,
  userId: sessions.userId,
  userName: user.name,
  appId: sessions.appId,
  gameName: games.name,
  workerId: sessions.workerId,
  slot: sessions.slot,
  state: sessions.state,
  stage: sessions.stage,
  createdAt: sessions.createdAt,
  endedAt: sessions.endedAt,
  lastInputAt: sessions.lastInputAt,
  failReason: sessions.failReason,
};

/** Строка `adminSessionColumns`, когда она гарантированно есть (строка сессии нашлась). */
type AdminSessionRow = {
  readonly id: string;
  readonly userId: string;
  readonly userName: string;
  readonly appId: number;
  readonly gameName: string;
  readonly workerId: string | null;
  readonly slot: number | null;
  readonly state: DbSessionState;
  readonly stage: DbSessionStage | null;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
  readonly lastInputAt: Date | null;
  readonly failReason: string | null;
};

/** `AdminSessionRow` → `AdminSession` (используется и для сессий на воркере в `workers.ts`). */
export const toAdminSession = (row: AdminSessionRow): AdminSession => ({
  id: row.id,
  userId: row.userId,
  userName: row.userName,
  appId: row.appId,
  gameName: row.gameName,
  workerId: row.workerId,
  slot: row.slot,
  state: row.state,
  stage: row.stage,
  createdAt: row.createdAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
  lastInputAt: row.lastInputAt?.toISOString() ?? null,
  failReason: row.failReason,
});

/**
 * Активные и недавние (завершённые за 7 дней от `now`, новые сверху, не
 * больше `recentLimit`) сессии. `failedOnly` — показать только `failed`
 * (активных `failed` не бывает — `isActive` их уже исключает, поэтому
 * список активных в этом режиме пуст, что и ожидается).
 */
export const listSessions = (
  failedOnly: boolean,
  now: Date,
): Effect.Effect<
  { active: Array<AdminSession>; recent: Array<AdminSession> },
  never,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;

    const activeRows = yield* db
      .select(adminSessionColumns)
      .from(sessions)
      .innerJoin(games, eq(sessions.appId, games.appId))
      .innerJoin(user, eq(sessions.userId, user.id))
      .where(
        failedOnly ? and(isActive, eq(sessions.state, "failed")) : isActive,
      );

    const recentCutoff = new Date(now.getTime() - recentWindowMs);
    const recentStates = failedOnly ? (["failed"] as const) : terminalStates;
    const recentRows = yield* db
      .select(adminSessionColumns)
      .from(sessions)
      .innerJoin(games, eq(sessions.appId, games.appId))
      .innerJoin(user, eq(sessions.userId, user.id))
      .where(
        and(
          inArray(sessions.state, recentStates),
          gte(sessions.endedAt, recentCutoff),
        ),
      )
      .orderBy(desc(sessions.endedAt))
      .limit(recentLimit);

    return {
      active: activeRows.map(toAdminSession),
      recent: recentRows.map(toAdminSession),
    };
  }).pipe(Effect.orDie);

/**
 * Остановка любой сессии администратором: как `SessionRepo.requestStop`, но
 * без проверки владельца. Активной — `stopRequestedAt = coalesce(..., now)`
 * (первый запрос не перезаписывается), завершённой — ничего. Неверный
 * формат id или сессии нет — `false`.
 */
export const adminStop = (
  sessionId: string,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    if (!isSessionId(sessionId)) return false;
    const db = yield* Db;
    const now = yield* DateTime.nowAsDate;
    const [existing] = yield* db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (existing === undefined) return false;
    yield* db
      .update(sessions)
      .set({
        stopRequestedAt: sql`coalesce(${sessions.stopRequestedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(and(eq(sessions.id, sessionId), isActive));
    return true;
  }).pipe(Effect.orDie);
