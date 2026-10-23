// Блок «В тренде» на главной /app: сейчас играют и за неделю — по числу
// сессий (now) и разных пользователей (week) на игру.
import { Db, games, sessions } from "@cg/db";
import type { TrendingEntry, TrendingView } from "@cg/rpc";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  ne,
  notInArray,
} from "drizzle-orm";
import { Effect } from "effect";
import * as CloudRepo from "./CloudRepo";
import * as LibraryRepo from "./LibraryRepo";
import { coverUrl } from "./LibraryService";

/** Не больше стольких игр в каждом из списков «сейчас»/«за неделю». */
const maxEntries = 12;

/** Окно «за неделю» — последние 7 суток от `now`. */
const weekMillis = 7 * 24 * 60 * 60 * 1000;

interface RankedGame {
  readonly appId: number;
  readonly name: string;
  readonly players: number;
}

const toEntries = (
  ranked: ReadonlyArray<RankedGame>,
  cloudStatuses: ReadonlyMap<number, TrendingEntry["cloud"]>,
  ownedAppIds: ReadonlySet<number>,
): ReadonlyArray<TrendingEntry> =>
  ranked.map((game) => ({
    appId: game.appId,
    name: game.name,
    coverUrl: coverUrl(game.appId),
    cloud: CloudRepo.cloudStatusOf(cloudStatuses, game.appId),
    players: game.players,
    inLibrary: ownedAppIds.has(game.appId),
  }));

/**
 * «В тренде» для текущего пользователя: `now` — игры с сессиями в состояниях,
 * отличных от `ended`/`failed` (`players` — число таких сессий); `week` —
 * игры с сессиями за последние 7 суток от `now` в любом состоянии кроме
 * `failed` (`players` — число разных `user_id`). Оба списка — по убыванию
 * `players`, затем по имени, не больше 12; игра может быть в обоих.
 */
export const trending = (
  userId: string,
  now: Date,
): Effect.Effect<TrendingView, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const weekAgo = new Date(now.getTime() - weekMillis);

    const [nowRows, weekRows, ownedAppIds] = yield* Effect.all([
      db
        .select({
          appId: games.appId,
          name: games.name,
          players: count(sessions.id),
        })
        .from(sessions)
        .innerJoin(games, eq(sessions.appId, games.appId))
        .where(notInArray(sessions.state, ["ended", "failed"]))
        .groupBy(games.appId, games.name)
        .orderBy(desc(count(sessions.id)), asc(games.name))
        .limit(maxEntries),
      db
        .select({
          appId: games.appId,
          name: games.name,
          players: countDistinct(sessions.userId),
        })
        .from(sessions)
        .innerJoin(games, eq(sessions.appId, games.appId))
        .where(
          and(gte(sessions.createdAt, weekAgo), ne(sessions.state, "failed")),
        )
        .groupBy(games.appId, games.name)
        .orderBy(desc(countDistinct(sessions.userId)), asc(games.name))
        .limit(maxEntries),
      LibraryRepo.ownedAppIds(userId),
    ]);

    const appIds = [
      ...new Set([...nowRows, ...weekRows].map((row) => row.appId)),
    ];
    const cloudStatuses = yield* CloudRepo.cloudStatuses(appIds);
    const owned = new Set(ownedAppIds);

    return {
      now: toEntries(nowRows, cloudStatuses, owned),
      week: toEntries(weekRows, cloudStatuses, owned),
    };
  }).pipe(Effect.orDie);
