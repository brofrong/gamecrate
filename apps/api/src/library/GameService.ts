// Страница игры (`library.game`, спека 2026-10-27 §4.3): карточка из каталога и
// библиотеки пользователя, статус облака и размер, сессии пользователя в игре,
// описание из кэша Steam Store (с походом в Steam при устаревшем кэше) и достижения
// (схема кэшируется, открытые — запрашиваются при каждом открытии). Steam Store и
// достижения запрашиваются параллельно; ни один из них не роняет ответ.
import {
  Db,
  gameAvailable,
  games,
  gamestoreApps,
  playSegments,
  sessions,
  userGames,
} from "@cg/db";
import {
  type GameAchievements,
  type GameDetails,
  GameNotFound,
  type GameSessionEntry,
  type GameView,
  ProtonTier,
} from "@cg/rpc";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { SteamApi } from "../steam/SteamApi";
import { SteamStoreApi } from "../steam/SteamStoreApi";
import * as CloudRepo from "./CloudRepo";
import * as GameDetailsRepo from "./GameDetailsRepo";
import { coverUrl } from "./LibraryService";
import { sessionDurationMinutes } from "./RecentRepo";

const isProtonTier = Schema.is(ProtonTier);

/** Сколько последних сессий пользователя в игре отдаём на страницу. */
const sessionsLimit = 10;

/**
 * Описание из кэша: свежее — как есть; устаревшее или отсутствующее — поход в
 * Steam Store, результат (`Found`/`NotFound`) сохраняется; `Unavailable` — старая
 * запись, если была. Возвращает и строку кэша (для `achievementsFetchedAt`).
 */
const resolveDetails = (appId: number, now: Date) =>
  Effect.gen(function* () {
    const cached = yield* GameDetailsRepo.get(appId);
    if (cached !== null && GameDetailsRepo.fresh(cached, now)) return cached;
    const store = yield* SteamStoreApi;
    const lookup = yield* store.fetchDetails(appId);
    if (lookup._tag === "Unavailable") return cached;
    yield* GameDetailsRepo.upsert(appId, lookup, now);
    return yield* GameDetailsRepo.get(appId);
  });

/**
 * Достижения пользователя: без Steam — `Unlinked`; у игры их нет (по Steam Store)
 * — `None`; схема из кэша (свежая) или из Steam; открытые — всегда из Steam.
 */
const resolveAchievements = (
  appId: number,
  steamId: string | null,
  details: GameDetails | null,
  cached: GameDetailsRepo.CachedDetails | null,
  now: Date,
): Effect.Effect<GameAchievements, never, Db | SteamApi> =>
  Effect.gen(function* () {
    if (steamId === null) return { _tag: "Unlinked" } as const;
    if (details === null || details.achievementsTotal === 0)
      return { _tag: "None" } as const;
    const steam = yield* SteamApi;

    const schemaFresh =
      cached?.achievementsFetchedAt != null &&
      now.getTime() - cached.achievementsFetchedAt.getTime() <
        GameDetailsRepo.DETAILS_TTL_MS;
    const [schema, player] = yield* Effect.all(
      [
        schemaFresh
          ? GameDetailsRepo.listAchievements(appId)
          : steam.getAchievementSchema(appId).pipe(
              Effect.tap((rows) =>
                rows === null
                  ? Effect.void
                  : GameDetailsRepo.replaceAchievements(appId, rows, now),
              ),
              Effect.map((rows) => rows ?? []),
            ),
        steam.getPlayerAchievements(steamId, appId),
      ],
      { concurrency: "unbounded" },
    );

    if (player._tag !== "Ready") return player;
    // Схема не пришла (сеть, таймаут, пустой ответ) — без неё нечего рисовать:
    // «0 из 54» над пустой сеткой хуже, чем отсутствие панели.
    if (schema.length === 0) return { _tag: "None" } as const;
    const byApiName = new Map(schema.map((row) => [row.apiName, row]));
    const unlockedAt = new Map(
      player.unlocked.map((entry) => [entry.apiName, entry.unlockedAt]),
    );
    const unlocked = player.unlocked
      .flatMap((entry) => {
        const row = byApiName.get(entry.apiName);
        return row === undefined
          ? []
          : [
              {
                apiName: row.apiName,
                name: row.name,
                description: row.description,
                icon: row.icon,
                unlockedAt: entry.unlockedAt,
              },
            ];
      })
      .sort((a, b) => b.unlockedAt.localeCompare(a.unlockedAt));
    const locked = schema
      .filter((row) => !unlockedAt.has(row.apiName))
      .map((row) => ({
        apiName: row.apiName,
        name: row.name,
        description: row.description,
        iconGray: row.iconGray,
        hidden: row.hidden,
      }));
    return {
      _tag: "Ready",
      total: details.achievementsTotal,
      unlocked,
      locked,
    } as const;
  });

/** Последние сессии пользователя в игре (не `failed`), новые первыми, с минутами. */
const userSessions = (
  userId: string,
  appId: number,
  now: Date,
): Effect.Effect<ReadonlyArray<GameSessionEntry>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        endedAt: sessions.endedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.appId, appId),
          ne(sessions.state, "failed"),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(sessionsLimit);
    if (rows.length === 0) return [];
    const segments = yield* db
      .select({
        sessionId: playSegments.sessionId,
        startedAt: playSegments.startedAt,
        endedAt: playSegments.endedAt,
      })
      .from(playSegments)
      .where(
        and(
          inArray(
            playSegments.sessionId,
            rows.map((row) => row.id),
          ),
          eq(playSegments.open, false),
        ),
      );
    const bySession = new Map<
      string,
      Array<{ startedAt: Date; endedAt: Date }>
    >();
    for (const segment of segments) {
      const list = bySession.get(segment.sessionId) ?? [];
      list.push({ startedAt: segment.startedAt, endedAt: segment.endedAt });
      bySession.set(segment.sessionId, list);
    }
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.createdAt.toISOString(),
      minutes: sessionDurationMinutes(row, bySession.get(row.id) ?? [], now),
    }));
  }).pipe(Effect.orDie);

export const gameView = (
  userId: string,
  steamId: string | null,
  appId: number,
  now: Date,
): Effect.Effect<GameView, GameNotFound, Db | SteamStoreApi | SteamApi> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [gameRow] = yield* db
      .select({ name: games.name, protonTier: games.protonTier })
      .from(games)
      .where(eq(games.appId, appId))
      .pipe(Effect.orDie);
    if (gameRow === undefined) return yield* new GameNotFound({ appId });

    const [owned, installed, cloud, sessionList, cached, available] =
      yield* Effect.all(
        [
          db
            .select({ playtimeMinutes: userGames.playtimeMinutes })
            .from(userGames)
            .where(
              and(eq(userGames.userId, userId), eq(userGames.appId, appId)),
            )
            .pipe(Effect.orDie),
          db
            .select({ sizeBytes: gamestoreApps.sizeBytes })
            .from(gamestoreApps)
            .where(eq(gamestoreApps.appId, appId))
            .pipe(Effect.orDie),
          CloudRepo.cloudStatuses([appId]),
          userSessions(userId, appId, now),
          resolveDetails(appId, now),
          gameAvailable(userId, appId, now),
        ],
        { concurrency: "unbounded" },
      );
    const details = cached?.details ?? null;
    const achievements = yield* resolveAchievements(
      appId,
      steamId,
      details,
      cached,
      now,
    );

    return {
      appId,
      name: gameRow.name,
      coverUrl: coverUrl(appId),
      cloud: CloudRepo.cloudStatusOf(cloud, appId),
      protonTier: isProtonTier(gameRow.protonTier)
        ? gameRow.protonTier
        : "pending",
      inLibrary: owned.length > 0,
      playtimeMinutes: owned[0]?.playtimeMinutes ?? 0,
      sizeBytes: installed[0]?.sizeBytes ?? null,
      lastSession: sessionList[0] ?? null,
      sessions: sessionList,
      details,
      achievements,
      available,
    };
  });
