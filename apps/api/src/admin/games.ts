// Игры библиотек серверов для админки (библиотека своя у каждого сервера,
// спека 2026-11-09 §5): список пар (сервер, игра) с размером/запуском/
// занятостью по серверу и пометка на удаление с одного сервера. Само удаление
// (агент сервера удаляет файлы, строку убирает `GameDeleted`) выполняет
// оркестратор по `deleting_at` (`GameDeleter.ts`).
// Плюс свои сборки вне Steam (раздел «Свои сборки», спека 2026-11-03 «Свои
// игры»): у них нет размера/установки/удаления — только где раскатан пакет и
// переключатель «Открыта игрокам» (`setPublished`).
import {
  Db,
  games,
  gamestoreApps,
  hasPackage,
  installJobs,
  ownGames,
  sessions,
  workers,
} from "@cg/db";
import { type AdminGame, type AdminGames, type AdminOwnGame } from "@cg/rpc";
import {
  type AnyColumn,
  and,
  arrayContains,
  asc,
  desc,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { Effect } from "effect";
import { OwnGameCatalog } from "../library/OwnGameCatalog";
import { holdsSlot, isActive } from "../session/SessionRepo";
import { activeInstallStates } from "./installs";

/**
 * Сессии игры `appId`, дошедшие до размещения на воркере (`worker_id is not
 * null`; с `workerId` — именно на этом сервере) — «запуски» по спеке; общая
 * для Steam-игр (`gamestoreApps.appId`, по серверу строки) и своих сборок
 * (`ownGames.appId`, по всем серверам) — колонки просто подставляются
 * параметрами.
 */
const placedOn = (workerId: AnyColumn | undefined) =>
  workerId === undefined
    ? sql`${sessions.workerId} is not null`
    : sql`${sessions.workerId} = ${workerId}`;

const launchesSqlFor = (appId: AnyColumn, workerId?: AnyColumn) =>
  sql<number>`(select count(*)::int from ${sessions} where ${sessions.appId} = ${appId} and ${placedOn(workerId)})`;

/** Момент создания последней из сессий `launchesSqlFor` (у сессии нет отдельной метки «поставлена на воркер»). */
const lastLaunchAtSqlFor = (appId: AnyColumn, workerId?: AnyColumn) =>
  sql<Date | null>`(select max(${sessions.createdAt}) from ${sessions} where ${sessions.appId} = ${appId} and ${placedOn(workerId)})`;

/**
 * Активные (не `ended`/`failed`, `isActive`) сессии игры `appId`: без
 * `workerId` — все, ещё не размещённые тоже (свои сборки); с `workerId` —
 * только размещённые на этом сервере.
 */
const activeSessionsSqlFor = (appId: AnyColumn, workerId?: AnyColumn) =>
  workerId === undefined
    ? sql<number>`(select count(*)::int from ${sessions} where ${sessions.appId} = ${appId} and ${isActive})`
    : sql<number>`(select count(*)::int from ${sessions} where ${sessions.appId} = ${appId} and ${sessions.workerId} = ${workerId} and ${isActive})`;

/** Активная (`queued`/`running`) задача установки этой игры на сервер строки. */
const installingSql = sql<boolean>`exists (select 1 from ${installJobs} where ${installJobs.appId} = ${gamestoreApps.appId} and ${installJobs.workerId} = ${gamestoreApps.workerId} and ${installJobs.state} in ('queued', 'running'))`;

/** Столбцы `AdminGame` одним select'ом (без N+1 по играм). */
const gameColumns = {
  workerId: gamestoreApps.workerId,
  appId: gamestoreApps.appId,
  name: games.name,
  sizeBytes: gamestoreApps.sizeBytes,
  installedAt: gamestoreApps.installedAt,
  deletingAt: gamestoreApps.deletingAt,
  deleteError: gamestoreApps.deleteError,
  launches: launchesSqlFor(gamestoreApps.appId, gamestoreApps.workerId),
  lastLaunchAt: lastLaunchAtSqlFor(gamestoreApps.appId, gamestoreApps.workerId),
  activeSessions: activeSessionsSqlFor(
    gamestoreApps.appId,
    gamestoreApps.workerId,
  ),
  installing: installingSql,
};

/** Строка `gameColumns`. */
type GameRow = {
  readonly workerId: string;
  readonly appId: number;
  readonly name: string;
  readonly sizeBytes: number;
  readonly installedAt: Date;
  readonly deletingAt: Date | null;
  readonly deleteError: string | null;
  readonly launches: number;
  readonly lastLaunchAt: Date | null;
  readonly activeSessions: number;
  readonly installing: boolean;
};

/** `GameRow` → `AdminGame`. */
const toAdminGame = (row: GameRow): AdminGame => ({
  workerId: row.workerId,
  appId: row.appId,
  name: row.name,
  sizeBytes: row.sizeBytes,
  installedAt: row.installedAt.toISOString(),
  lastLaunchAt: row.lastLaunchAt?.toISOString() ?? null,
  launches: row.launches,
  activeSessions: row.activeSessions,
  installing: row.installing,
  deleting: row.deletingAt !== null,
  deleteError: row.deleteError,
});

/** Столбцы строки «Свои сборки» одним select'ом (без N+1 по играм). */
const ownGameColumns = {
  appId: ownGames.appId,
  name: games.name,
  slug: ownGames.slug,
  version: ownGames.version,
  published: ownGames.published,
  launches: launchesSqlFor(ownGames.appId),
  lastLaunchAt: lastLaunchAtSqlFor(ownGames.appId),
  activeSessions: activeSessionsSqlFor(ownGames.appId),
};

/** Строка `ownGameColumns`. */
type OwnGameRow = {
  readonly appId: number;
  readonly name: string;
  readonly slug: string;
  readonly version: string;
  readonly published: boolean;
  readonly launches: number;
  readonly lastLaunchAt: Date | null;
  readonly activeSessions: number;
};

/** `OwnGameRow` + воркеры с раскатанным именно этим пакетом → `AdminOwnGame`. */
const toAdminOwnGame = (
  row: OwnGameRow,
  workerIds: ReadonlyArray<string>,
): AdminOwnGame => ({
  appId: row.appId,
  name: row.name,
  slug: row.slug,
  version: row.version,
  published: row.published,
  workers: workerIds,
  launches: row.launches,
  lastLaunchAt: row.lastLaunchAt?.toISOString() ?? null,
  activeSessions: row.activeSessions,
});

/**
 * Свои сборки (раздел «Свои сборки», спека 2026-11-03 «Свои игры»), по
 * имени. `workers` каждой строки — id воркеров с ролью `worker`, у которых
 * раскатан именно её пакет (`hasPackage`, точное совпадение `slug`/`version`
 * в `WorkerStats.ownGames`); считается в памяти — своих игр и воркеров мало,
 * ни одной своей игры нет вовсе не стоит отдельного запроса к `workers`.
 */
const listOwnGames = (): Effect.Effect<
  ReadonlyArray<AdminOwnGame>,
  never,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select(ownGameColumns)
      .from(ownGames)
      .innerJoin(games, eq(ownGames.appId, games.appId))
      .orderBy(asc(games.name));
    if (rows.length === 0) return [];

    const workerRows = yield* db
      .select({ id: workers.id, stats: workers.stats })
      .from(workers)
      .where(arrayContains(workers.roles, ["worker"]))
      .orderBy(asc(workers.id));

    return rows.map((row) =>
      toAdminOwnGame(
        row,
        workerRows
          .filter((w) =>
            hasPackage(w.stats, { slug: row.slug, version: row.version }),
          )
          .map((w) => w.id),
      ),
    );
  }).pipe(Effect.orDie);

/**
 * Игры библиотек серверов — по строке на пару (сервер, игра), по размеру
 * убыв., при равном — по серверу и appid — + служебные пакеты + свои сборки
 * (`own`, по имени). `service` — часть библиотеки первого по `id` воркера с
 * ролью `gamestore`, которой нет в его строках `gamestore_apps` (Proton,
 * Steam Linux Runtime и т. п.); нет снимка его библиотеки (или такого
 * воркера вовсе нет) — `null`. Полный обзор по серверам — задача 9.
 */
export const listGames = (): Effect.Effect<AdminGames, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select(gameColumns)
      .from(gamestoreApps)
      .innerJoin(games, eq(gamestoreApps.appId, games.appId))
      .orderBy(
        desc(gamestoreApps.sizeBytes),
        asc(gamestoreApps.workerId),
        asc(gamestoreApps.appId),
      );
    const own = yield* listOwnGames();

    const [gamestoreWorker] = yield* db
      .select({ id: workers.id, stats: workers.stats })
      .from(workers)
      .where(arrayContains(workers.roles, ["gamestore"]))
      .orderBy(asc(workers.id))
      .limit(1);
    const library = gamestoreWorker?.stats?.library;
    const installedAppIds = new Set(
      rows
        .filter((row) => row.workerId === gamestoreWorker?.id)
        .map((row) => row.appId),
    );
    const serviceApps = library?.filter(
      (app) => !installedAppIds.has(app.appId),
    );

    return {
      games: rows.map(toAdminGame),
      own,
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
 * Удаление игры `appId` с сервера `workerId`: строка `gamestore_apps` этой
 * пары под `FOR UPDATE` (нет — `notFound`); активная сессия этой игры на этом
 * сервере (или сессия, ещё держащая там слот, — контейнер мог пережить
 * `ended`/`failed`, `holdsSlot`), либо активная задача установки этой игры на
 * этот сервер — `inUse`; сессии и задачи других серверов не мешают. Иначе
 * `deleting_at = coalesce(deleting_at, now)` — `started` (первый запрос не
 * перезаписывается, как `adminStop`); тот же `update` сразу сбрасывает
 * `delete_error`, не дожидаясь итога агента. `Scheduler.placeOne` читает
 * строки библиотеки под `FOR SHARE` перед размещением сессии
 * (`InstallRepo.installedOn`) — либо он видит эту пометку, либо мы здесь
 * увидим его сессию на этом сервере.
 */
export const deleteGame = (
  workerId: string,
  appId: number,
  now: Date,
): Effect.Effect<"started" | "inUse" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const entry = and(
      eq(gamestoreApps.workerId, workerId),
      eq(gamestoreApps.appId, appId),
    );
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [app] = yield* db
          .select({ id: gamestoreApps.appId })
          .from(gamestoreApps)
          .where(entry)
          .for("update");
        if (app === undefined) return "notFound" as const;

        // Активна (не ended/failed) ИЛИ ещё держит слот воркера — строка
        // уже терминальная, но контейнер на GPU жив и агент его не отпустил.
        const [activeSession] = yield* db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.appId, appId),
              eq(sessions.workerId, workerId),
              or(isActive, holdsSlot),
            ),
          )
          .limit(1);
        if (activeSession !== undefined) return "inUse" as const;

        const [activeJob] = yield* db
          .select({ id: installJobs.id })
          .from(installJobs)
          .where(
            and(
              eq(installJobs.appId, appId),
              eq(installJobs.workerId, workerId),
              inArray(installJobs.state, activeInstallStates),
            ),
          )
          .limit(1);
        if (activeJob !== undefined) return "inUse" as const;

        yield* db
          .update(gamestoreApps)
          .set({
            deletingAt: sql`coalesce(${gamestoreApps.deletingAt}, ${now.toISOString()}::timestamptz)`,
            // Новый запрос (или повтор) сразу прячет прежнюю причину отказа —
            // не ждём итога агента, чтобы строка не мигала старой ошибкой.
            deleteError: null,
          })
          .where(entry);
        return "started" as const;
      }),
    );
  }).pipe(Effect.orDie);

/**
 * Открыть/закрыть свою сборку игрокам («Открыта игрокам», раздел «Свои
 * сборки»): `update` строки `own_games` по `appId`, нет такой строки —
 * `"notFound"` (0 обновлённых строк), иначе `"ok"`. Игры нет в каталоге api
 * (`OwnGameCatalog`: её `game.json` убрали из репозитория) — тоже
 * `"notFound"`: открытая, она вела бы с плитки на «игра не найдена» до
 * перезапуска api (тот её и закроет, `syncOwnGames`).
 */
export const setPublished = (
  appId: number,
  published: boolean,
): Effect.Effect<"ok" | "notFound", never, Db | OwnGameCatalog> =>
  Effect.gen(function* () {
    if ((yield* OwnGameCatalog).byAppId(appId) === undefined)
      return "notFound" as const;
    const db = yield* Db;
    const rows = yield* db
      .update(ownGames)
      .set({ published })
      .where(eq(ownGames.appId, appId))
      .returning({ appId: ownGames.appId });
    return rows.length > 0 ? ("ok" as const) : ("notFound" as const);
  }).pipe(Effect.orDie);
