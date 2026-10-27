// Кэш Steam Store и схемы достижений для страницы игры (`game_details`,
// `game_achievements`, спека 2026-10-27 §4.1–4.2): чтение свежей записи, запись
// результата похода в Steam, замена схемы достижений. Срок жизни — 7 суток.
import { Db, gameAchievements, gameDetails } from "@cg/db";
import type { GameDetails } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { AchievementSchemaEntry } from "../steam/SteamApi";
import type { StoreLookup } from "../steam/SteamStoreApi";

export const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Строка кэша: `details: null` — Steam игру не знает (`found = false`). */
export type CachedDetails = {
  readonly fetchedAt: Date;
  readonly details: GameDetails | null;
  readonly achievementsFetchedAt: Date | null;
};

const isFresh = (fetchedAt: Date, now: Date) =>
  now.getTime() - fetchedAt.getTime() < DETAILS_TTL_MS;

const toDetails = (row: typeof gameDetails.$inferSelect): GameDetails | null =>
  row.found
    ? {
        shortDescription: row.shortDescription ?? "",
        aboutTheGame: row.aboutTheGame ?? "",
        developers: row.developers ?? [],
        publishers: row.publishers ?? [],
        genres: row.genres ?? [],
        releaseDate: row.releaseDate,
        metacriticScore: row.metacriticScore,
        metacriticUrl: row.metacriticUrl,
        controllerSupport:
          row.controllerSupport === "full" ||
          row.controllerSupport === "partial"
            ? row.controllerSupport
            : null,
        linux: row.linux,
        achievementsTotal: row.achievementsTotal,
        screenshots: row.screenshots ?? [],
        movies: row.movies ?? [],
      }
    : null;

/** Запись кэша как есть (любой давности); `null` — её нет. */
export const get = (
  appId: number,
): Effect.Effect<CachedDetails | null, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select()
      .from(gameDetails)
      .where(eq(gameDetails.appId, appId));
    const row = rows[0];
    if (row === undefined) return null;
    return {
      fetchedAt: row.fetchedAt,
      details: toDetails(row),
      achievementsFetchedAt: row.achievementsFetchedAt,
    };
  }).pipe(Effect.orDie);

/** Свежа ли запись (моложе 7 суток). */
export const fresh = (cached: CachedDetails, now: Date) =>
  isFresh(cached.fetchedAt, now);

/**
 * Сохранить результат похода в Steam Store (`Found`/`NotFound`); `Unavailable`
 * не пишется. `achievementsFetchedAt` сбрасывается только если запись новая.
 */
export const upsert = (
  appId: number,
  lookup: Exclude<StoreLookup, { _tag: "Unavailable" }>,
  now: Date,
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const details = lookup._tag === "Found" ? lookup.details : null;
    const values = {
      fetchedAt: now,
      found: lookup._tag === "Found",
      shortDescription: details?.shortDescription ?? null,
      aboutTheGame: details?.aboutTheGame ?? null,
      developers: details ? [...details.developers] : null,
      publishers: details ? [...details.publishers] : null,
      genres: details ? [...details.genres] : null,
      releaseDate: details?.releaseDate ?? null,
      metacriticScore: details?.metacriticScore ?? null,
      metacriticUrl: details?.metacriticUrl ?? null,
      controllerSupport: details?.controllerSupport ?? null,
      linux: details?.linux ?? false,
      achievementsTotal: details?.achievementsTotal ?? 0,
      screenshots: details ? details.screenshots.map((s) => ({ ...s })) : null,
      movies: details ? details.movies.map((m) => ({ ...m })) : null,
    };
    yield* db
      .insert(gameDetails)
      .values({ appId, ...values })
      .onConflictDoUpdate({ target: gameDetails.appId, set: values });
  }).pipe(Effect.orDie);

/** Схема достижений игры из кэша (может быть пустой, если ещё не брали). */
export const listAchievements = (
  appId: number,
): Effect.Effect<ReadonlyArray<AchievementSchemaEntry>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select()
      .from(gameAchievements)
      .where(eq(gameAchievements.appId, appId));
    return rows.map((row) => ({
      apiName: row.apiName,
      name: row.name,
      description: row.description,
      icon: row.icon,
      iconGray: row.iconGray,
      hidden: row.hidden,
    }));
  }).pipe(Effect.orDie);

/**
 * Заменить схему достижений и отметить время в `game_details` (строка кэша
 * должна существовать — вызывается после `upsert`).
 */
export const replaceAchievements = (
  appId: number,
  rows: ReadonlyArray<AchievementSchemaEntry>,
  now: Date,
): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.delete(gameAchievements).where(eq(gameAchievements.appId, appId));
    if (rows.length > 0)
      yield* db
        .insert(gameAchievements)
        .values(rows.map((row) => ({ appId, ...row })));
    yield* db
      .update(gameDetails)
      .set({ achievementsFetchedAt: now })
      .where(eq(gameDetails.appId, appId));
  }).pipe(Effect.orDie);
