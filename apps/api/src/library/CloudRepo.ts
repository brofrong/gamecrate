// Статус облачной версии игры (установка на сервере стриминга), облачный
// профиль Steam (MVP-3) и время последней сессии — для `library.list`.
import { Db, gamestoreApps, installJobs, profiles, sessions } from "@cg/db";
import type { CloudStatus } from "@cg/rpc";
import { and, eq, inArray, max, ne } from "drizzle-orm";
import { Effect } from "effect";

/** Процент загрузки: неизвестен, если размер ещё не определён (`bytesTotal` null). */
const installPercent = (
  bytesDownloaded: number | null,
  bytesTotal: number | null,
) =>
  bytesTotal == null
    ? null
    : Math.round(((bytesDownloaded ?? 0) / bytesTotal) * 100);

/**
 * Статус облака для каждой из `appIds`: `Ready` — игра есть в `gamestore_apps`;
 * иначе `Installing`, если есть активная (`queued`/`running`) задача установки
 * (частичный уникальный индекс гарантирует не более одной); иначе `Missing`
 * (в карту не попадает — см. `cloudStatusOf`). Пустой список — пустая карта
 * без запроса к БД.
 */
export const cloudStatuses = (
  appIds: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, CloudStatus>, never, Db> =>
  Effect.gen(function* () {
    if (appIds.length === 0) return new Map();
    const db = yield* Db;
    const ids = [...appIds];
    const status = new Map<number, CloudStatus>();

    const ready = yield* db
      .select({ appId: gamestoreApps.appId })
      .from(gamestoreApps)
      .where(inArray(gamestoreApps.appId, ids));
    for (const row of ready) status.set(row.appId, { _tag: "Ready" });

    const active = yield* db
      .select({
        appId: installJobs.appId,
        bytesDownloaded: installJobs.bytesDownloaded,
        bytesTotal: installJobs.bytesTotal,
      })
      .from(installJobs)
      .where(
        and(
          inArray(installJobs.appId, ids),
          inArray(installJobs.state, ["queued", "running"]),
        ),
      );
    for (const row of active)
      if (!status.has(row.appId))
        status.set(row.appId, {
          _tag: "Installing",
          percent: installPercent(row.bytesDownloaded, row.bytesTotal),
        });

    return status;
  }).pipe(Effect.orDie);

/** `Missing`, если статус игры не попал в карту `cloudStatuses`. */
export const cloudStatusOf = (
  statuses: ReadonlyMap<number, CloudStatus>,
  appId: number,
): CloudStatus => statuses.get(appId) ?? { _tag: "Missing" };

/** Есть ли у пользователя облачный профиль Steam (сохранения и настройки, MVP-3). */
export const hasSteamProfile = (
  userId: string,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    return rows.length > 0;
  }).pipe(Effect.orDie);

/**
 * Время последней не-failed сессии пользователя для каждой из `appIds`
 * (ISO 8601); игры без такой сессии в карту не попадают.
 */
export const lastPlayedAt = (
  userId: string,
  appIds: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, string>, never, Db> =>
  Effect.gen(function* () {
    if (appIds.length === 0) return new Map();
    const db = yield* Db;
    const rows = yield* db
      .select({
        appId: sessions.appId,
        lastPlayedAt: max(sessions.createdAt),
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          inArray(sessions.appId, [...appIds]),
          ne(sessions.state, "failed"),
        ),
      )
      .groupBy(sessions.appId);

    const map = new Map<number, string>();
    for (const row of rows)
      if (row.lastPlayedAt != null)
        map.set(row.appId, row.lastPlayedAt.toISOString());
    return map;
  }).pipe(Effect.orDie);
