// Игры общей библиотеки для админки: список с размером/запуском/занятостью и
// пометка на удаление. Само удаление (агент удаляет файлы, строку убирает
// `GameDeleted`) выполняет оркестратор по `deleting_at` (`GameDeleter.ts`).
import {
  Db,
  games,
  gamestoreApps,
  installJobs,
  sessions,
  workers,
} from "@cg/db";
import { type AdminGame, type AdminGames } from "@cg/rpc";
import { and, arrayContains, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { holdsSlot, isActive } from "../session/SessionRepo";
import { activeInstallStates } from "./installs";

/**
 * Сессии этой игры, дошедшие до размещения на воркере (`worker_id is not
 * null`) — «запуски» по спеке; `lastLaunchAt` — момент создания последней из
 * них (у сессии нет отдельной метки «поставлена на воркер»).
 */
const launchesSql = sql<number>`(select count(*)::int from ${sessions} where ${sessions.appId} = ${gamestoreApps.appId} and ${sessions.workerId} is not null)`;
const lastLaunchAtSql = sql<Date | null>`(select max(${sessions.createdAt}) from ${sessions} where ${sessions.appId} = ${gamestoreApps.appId} and ${sessions.workerId} is not null)`;

/** Активные (не `ended`/`failed`, `isActive`) сессии этой игры — ещё не размещённые тоже считаются. */
const activeSessionsSql = sql<number>`(select count(*)::int from ${sessions} where ${sessions.appId} = ${gamestoreApps.appId} and ${isActive})`;

/** Активная (`queued`/`running`) задача установки этой игры. */
const installingSql = sql<boolean>`exists (select 1 from ${installJobs} where ${installJobs.appId} = ${gamestoreApps.appId} and ${installJobs.state} in ('queued', 'running'))`;

/** Столбцы `AdminGame` одним select'ом (без N+1 по играм). */
const gameColumns = {
  appId: gamestoreApps.appId,
  name: games.name,
  sizeBytes: gamestoreApps.sizeBytes,
  installedAt: gamestoreApps.installedAt,
  deletingAt: gamestoreApps.deletingAt,
  launches: launchesSql,
  lastLaunchAt: lastLaunchAtSql,
  activeSessions: activeSessionsSql,
  installing: installingSql,
};

/** Строка `gameColumns`. */
type GameRow = {
  readonly appId: number;
  readonly name: string;
  readonly sizeBytes: number;
  readonly installedAt: Date;
  readonly deletingAt: Date | null;
  readonly launches: number;
  readonly lastLaunchAt: Date | null;
  readonly activeSessions: number;
  readonly installing: boolean;
};

/** `GameRow` → `AdminGame`. */
const toAdminGame = (row: GameRow): AdminGame => ({
  appId: row.appId,
  name: row.name,
  sizeBytes: row.sizeBytes,
  installedAt: row.installedAt.toISOString(),
  lastLaunchAt: row.lastLaunchAt?.toISOString() ?? null,
  launches: row.launches,
  activeSessions: row.activeSessions,
  installing: row.installing,
  deleting: row.deletingAt !== null,
});

/**
 * Игры общей библиотеки (по размеру убыв.) + служебные пакеты. `service` —
 * часть библиотеки первого по `id` воркера с ролью `gamestore`, которой нет
 * в `gamestore_apps` (Proton, Steam Linux Runtime и т. п.); нет снимка его
 * библиотеки (или такого воркера вовсе нет) — `null`.
 */
export const listGames = (): Effect.Effect<AdminGames, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select(gameColumns)
      .from(gamestoreApps)
      .innerJoin(games, eq(gamestoreApps.appId, games.appId))
      .orderBy(desc(gamestoreApps.sizeBytes));

    const [gamestoreWorker] = yield* db
      .select({ stats: workers.stats })
      .from(workers)
      .where(arrayContains(workers.roles, ["gamestore"]))
      .orderBy(asc(workers.id))
      .limit(1);
    const library = gamestoreWorker?.stats?.library;
    const installedAppIds = new Set(rows.map((row) => row.appId));
    const serviceApps = library?.filter(
      (app) => !installedAppIds.has(app.appId),
    );

    return {
      games: rows.map(toAdminGame),
      service:
        serviceApps === undefined
          ? null
          : {
              count: serviceApps.length,
              sizeBytes: serviceApps.reduce(
                (sum, app) => sum + app.sizeBytes,
                0,
              ),
              names: serviceApps.map((app) => app.name),
            },
    };
  }).pipe(Effect.orDie);

/**
 * Удаление игры: строка `gamestore_apps` под `FOR UPDATE` (нет — `notFound`);
 * активная сессия (или сессия, ещё держащая слот воркера, — контейнер мог
 * пережить `ended`/`failed`, `holdsSlot`), либо активная задача установки
 * этой игры — `inUse`; иначе `deleting_at = coalesce(deleting_at, now)` —
 * `started` (первый запрос не перезаписывается, как `adminStop`).
 * `Scheduler.placeOne` перечитывает строку под `FOR SHARE` перед размещением
 * сессии — либо он видит эту пометку, либо мы здесь увидим его сессию.
 */
export const deleteGame = (
  appId: number,
  now: Date,
): Effect.Effect<"started" | "inUse" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [app] = yield* db
          .select({ id: gamestoreApps.appId })
          .from(gamestoreApps)
          .where(eq(gamestoreApps.appId, appId))
          .for("update");
        if (app === undefined) return "notFound" as const;

        // Активна (не ended/failed) ИЛИ ещё держит слот воркера — строка
        // уже терминальная, но контейнер на GPU жив и агент его не отпустил.
        const [activeSession] = yield* db
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.appId, appId), or(isActive, holdsSlot)))
          .limit(1);
        if (activeSession !== undefined) return "inUse" as const;

        const [activeJob] = yield* db
          .select({ id: installJobs.id })
          .from(installJobs)
          .where(
            and(
              eq(installJobs.appId, appId),
              inArray(installJobs.state, activeInstallStates),
            ),
          )
          .limit(1);
        if (activeJob !== undefined) return "inUse" as const;

        yield* db
          .update(gamestoreApps)
          .set({
            deletingAt: sql`coalesce(${gamestoreApps.deletingAt}, ${now.toISOString()}::timestamptz)`,
          })
          .where(eq(gamestoreApps.appId, appId));
        return "started" as const;
      }),
    );
  }).pipe(Effect.orDie);
