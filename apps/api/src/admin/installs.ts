// Задачи установки игр для админки: журнал (активные + недавние) и отмена
// (само удаление/CancelInstall выполняет оркестратор по `cancel_requested_at`).
import {
  Db,
  games,
  type InstallJobState,
  installJobs,
  type InstallStage as DbInstallStage,
  sessions,
  user,
} from "@cg/db";
import { type AdminInstall, type AdminInstalls } from "@cg/rpc";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

/** Состояния активной задачи (как `activeStates` в `apps/orchestrator/src/InstallRepo.ts`). */
export const activeInstallStates: Array<InstallJobState> = [
  "queued",
  "running",
];
const recentInstallStates: Array<InstallJobState> = ["done", "failed"];

/** Окно «недавних» задач и предел их числа — те же значения, что у `admin.sessions.list`. */
const recentWindowMs = 7 * 24 * 60 * 60 * 1000;
const recentLimit = 50;

/** Столбцы `AdminInstall` одним select'ом с join `games`/`user` и подзапросом ждущих сессий. */
const installColumns = {
  id: installJobs.id,
  appId: installJobs.appId,
  gameName: games.name,
  userName: user.name,
  workerId: installJobs.workerId,
  state: installJobs.state,
  stage: installJobs.stage,
  bytesDownloaded: installJobs.bytesDownloaded,
  bytesTotal: installJobs.bytesTotal,
  error: installJobs.error,
  cancelRequestedAt: installJobs.cancelRequestedAt,
  createdAt: installJobs.createdAt,
  updatedAt: installJobs.updatedAt,
  // Сессии, ждущие эту задачу (`installing` с этим `installJobId`), как
  // `waitersOf` в `apps/orchestrator/src/InstallRepo.ts`.
  waitingSessions: sql<number>`(select count(*)::int from ${sessions} where ${sessions.installJobId} = ${installJobs.id} and ${sessions.state} = 'installing')`,
};

/** Строка `installColumns`. */
type InstallRow = {
  readonly id: string;
  readonly appId: number;
  readonly gameName: string;
  readonly userName: string;
  readonly workerId: string | null;
  readonly state: InstallJobState;
  readonly stage: DbInstallStage | null;
  readonly bytesDownloaded: number | null;
  readonly bytesTotal: number | null;
  readonly error: string | null;
  readonly cancelRequestedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly waitingSessions: number;
};

/** `InstallRow` → `AdminInstall`. */
const toAdminInstall = (row: InstallRow): AdminInstall => ({
  id: row.id,
  appId: row.appId,
  gameName: row.gameName,
  userName: row.userName,
  workerId: row.workerId,
  state: row.state,
  stage: row.stage,
  bytesDownloaded: row.bytesDownloaded,
  bytesTotal: row.bytesTotal,
  error: row.error,
  cancelRequested: row.cancelRequestedAt !== null,
  waitingSessions: row.waitingSessions,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Активные (`queued`/`running`, старые сверху) и недавние (`done`/`failed`
 * за 7 дней по `updatedAt`, новые сверху, не больше `recentLimit`) задачи
 * установки.
 */
export const listInstalls = (
  now: Date,
): Effect.Effect<AdminInstalls, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    const activeRows = yield* db
      .select(installColumns)
      .from(installJobs)
      .innerJoin(games, eq(installJobs.appId, games.appId))
      .innerJoin(user, eq(installJobs.userId, user.id))
      .where(inArray(installJobs.state, activeInstallStates))
      .orderBy(asc(installJobs.createdAt));

    const recentCutoff = new Date(now.getTime() - recentWindowMs);
    const recentRows = yield* db
      .select(installColumns)
      .from(installJobs)
      .innerJoin(games, eq(installJobs.appId, games.appId))
      .innerJoin(user, eq(installJobs.userId, user.id))
      .where(
        and(
          inArray(installJobs.state, recentInstallStates),
          gte(installJobs.updatedAt, recentCutoff),
        ),
      )
      .orderBy(desc(installJobs.updatedAt))
      .limit(recentLimit);

    return {
      active: activeRows.map(toAdminInstall),
      recent: recentRows.map(toAdminInstall),
    };
  }).pipe(Effect.orDie);

/**
 * Запрос отмены активной задачи: `cancel_requested_at = coalesce(..., now)`
 * (первый запрос не перезаписывается, как `adminStop`); оркестратор по этой
 * пометке сам проваливает `queued` или шлёт `CancelInstall` агенту для
 * `running` (`InstallDispatcher.cancelRequested`). Задачи нет или она уже не
 * активна — `false`.
 */
export const cancelInstall = (
  jobId: string,
  now: Date,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const updated = yield* db
      .update(installJobs)
      .set({
        cancelRequestedAt: sql`coalesce(${installJobs.cancelRequestedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(installJobs.id, jobId),
          inArray(installJobs.state, activeInstallStates),
        ),
      )
      .returning({ id: installJobs.id });
    return updated.length > 0;
  }).pipe(Effect.orDie);
