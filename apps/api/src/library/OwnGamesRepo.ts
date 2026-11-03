// Свои игры в БД для библиотеки и страницы игры (спека 2026-11-03 «Свои
// игры»): какие открыты игрокам и сколько пользователь в них наиграл — Steam
// этого не знает, время считается по отрезкам игры наших сессий.
import { Db, games, ownGames, playSegments } from "@cg/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

/**
 * Свои игры, открытые игрокам (`own_games.published`), с именем из `games`;
 * по имени, затем по `appId`. Они есть в библиотеке у каждого пользователя.
 */
export const publishedOwnGames = (): Effect.Effect<
  ReadonlyArray<{ readonly appId: number; readonly name: string }>,
  never,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select({ appId: ownGames.appId, name: games.name })
      .from(ownGames)
      .innerJoin(games, eq(ownGames.appId, games.appId))
      .where(eq(ownGames.published, true))
      .orderBy(asc(games.name), asc(ownGames.appId));
  }).pipe(Effect.orDie);

/**
 * Время пользователя в каждой из `appIds`: сумма закрытых (`open = false`)
 * отрезков `play_segments` его сессий, целые минуты вниз от общей суммы.
 * Игры без отрезков в карту не попадают; пустой список — без запроса к БД.
 */
export const ownPlaytimeMinutes = (
  userId: string,
  appIds: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, number>, never, Db> =>
  Effect.gen(function* () {
    if (appIds.length === 0) return new Map();
    const db = yield* Db;
    const rows = yield* db
      .select({
        appId: playSegments.appId,
        millis: sql<number>`sum(extract(epoch from ${playSegments.endedAt} - ${playSegments.startedAt}) * 1000)::float8`,
      })
      .from(playSegments)
      .where(
        and(
          eq(playSegments.userId, userId),
          inArray(playSegments.appId, [...appIds]),
          eq(playSegments.open, false),
        ),
      )
      .groupBy(playSegments.appId);
    return new Map(
      rows.map((row) => [
        row.appId,
        Math.max(0, Math.floor(Number(row.millis) / 60_000)),
      ]),
    );
  }).pipe(Effect.orDie);
