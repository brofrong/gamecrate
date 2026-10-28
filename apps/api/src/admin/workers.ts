// Воркеры для админки: список с онлайном, снимком железа/загрузки и
// активными сессиями на каждом; включение/выключение обслуживания.
import {
  Db,
  games,
  type SessionState as DbSessionState,
  sessions,
  user,
  workers,
} from "@cg/db";
import { type AdminSession, type AdminWorker, WORKER_ONLINE_MS } from "@cg/rpc";
import { and, eq, notInArray } from "drizzle-orm";
import { Effect } from "effect";
import { toAdminSession } from "./sessions";

const terminalStates: Array<DbSessionState> = ["ended", "failed"];

/** Условие «сессия активна» (не `ended`/`failed`), как в `SessionRepo`. */
const isActiveSession = notInArray(sessions.state, terminalStates);

/**
 * Воркеры + их активные сессии одним select'ом: `left join` сессий (иначе
 * воркер без сессий пропал бы) с условием активности в `on`, затем `left
 * join` игры и пользователя сессии (без N+1).
 */
const workerColumns = {
  id: workers.id,
  publicIp: workers.publicIp,
  slots: workers.slots,
  roles: workers.roles,
  draining: workers.draining,
  hardware: workers.hardware,
  versions: workers.versions,
  stats: workers.stats,
  statsAt: workers.statsAt,
  lastSeenAt: workers.lastSeenAt,
  sessionId: sessions.id,
  sessionUserId: sessions.userId,
  sessionUserName: user.name,
  sessionAppId: sessions.appId,
  sessionGameName: games.name,
  sessionWorkerId: sessions.workerId,
  sessionSlot: sessions.slot,
  sessionState: sessions.state,
  sessionStage: sessions.stage,
  sessionCreatedAt: sessions.createdAt,
  sessionEndedAt: sessions.endedAt,
  sessionLastInputAt: sessions.lastInputAt,
  sessionFailReason: sessions.failReason,
};

/** Все воркеры по `id`, с активными сессиями на каждом. */
export const listWorkers = (
  now: Date,
): Effect.Effect<Array<AdminWorker>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select(workerColumns)
      .from(workers)
      .leftJoin(
        sessions,
        and(eq(sessions.workerId, workers.id), isActiveSession),
      )
      .leftJoin(games, eq(sessions.appId, games.appId))
      .leftJoin(user, eq(sessions.userId, user.id))
      .orderBy(workers.id);

    // Группируем построчно: порядок выборки уже по `workers.id`, несколько
    // строк на воркер — по одной на активную сессию (или одна без сессии).
    // Сессии копятся в отдельной (мутируемой) карте — поле `sessions` схемы
    // читается как `ReadonlyArray`.
    const byId = new Map<string, Omit<AdminWorker, "sessions">>();
    const sessionsById = new Map<string, Array<AdminSession>>();
    for (const row of rows) {
      if (!byId.has(row.id)) {
        const online =
          row.statsAt !== null &&
          now.getTime() - row.statsAt.getTime() < WORKER_ONLINE_MS;
        byId.set(row.id, {
          id: row.id,
          publicIp: row.publicIp,
          slots: row.slots,
          roles: row.roles as AdminWorker["roles"],
          online,
          lastSeenAt: (row.statsAt ?? row.lastSeenAt)?.toISOString() ?? null,
          draining: row.draining,
          hardware: row.hardware,
          versions: row.versions,
          stats: row.stats,
        });
        sessionsById.set(row.id, []);
      }
      if (row.sessionId !== null) {
        sessionsById.get(row.id)?.push(
          toAdminSession({
            id: row.sessionId,
            userId: row.sessionUserId as string,
            userName: row.sessionUserName as string,
            appId: row.sessionAppId as number,
            gameName: row.sessionGameName as string,
            workerId: row.sessionWorkerId,
            slot: row.sessionSlot,
            state: row.sessionState as NonNullable<typeof row.sessionState>,
            stage: row.sessionStage,
            createdAt: row.sessionCreatedAt as Date,
            endedAt: row.sessionEndedAt,
            lastInputAt: row.sessionLastInputAt,
            failReason: row.sessionFailReason,
          }),
        );
      }
    }
    return Array.from(byId.entries()).map(([id, worker]) => ({
      ...worker,
      sessions: sessionsById.get(id) ?? [],
    }));
  }).pipe(Effect.orDie);

/** Включить/выключить обслуживание воркера; уже идущие сессии/установки не трогает. */
export const setDraining = (
  workerId: string,
  draining: boolean,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const updated = yield* db
      .update(workers)
      .set({ draining })
      .where(eq(workers.id, workerId))
      .returning({ id: workers.id });
    return updated.length > 0;
  }).pipe(Effect.orDie);
