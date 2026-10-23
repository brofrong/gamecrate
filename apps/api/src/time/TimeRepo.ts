// Сводка игрового времени за месяц для главной /app: группа `time.*`.
import { Db, games, playSegments, sessions } from "@cg/db";
import type { TimeSummary } from "@cg/rpc";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { Effect } from "effect";

/** Москва — фиксированный UTC+3, без перехода на летнее время. */
const moscowOffsetMillis = 3 * 60 * 60 * 1000;

/**
 * Границы месяца `YYYY-MM` в `Europe/Moscow`, выраженные как UTC-моменты:
 * `from` — 00:00 первого числа месяца по Москве, `to` — то же для следующего
 * месяца (половина интервала открыта: `[from, to)`).
 */
export const monthRangeMoscow = (month: string): { from: Date; to: Date } => {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  return {
    from: new Date(Date.UTC(year, monthIndex, 1) - moscowOffsetMillis),
    to: new Date(Date.UTC(year, monthIndex + 1, 1) - moscowOffsetMillis),
  };
};

const minutesOfSegment = (startedAt: Date, endedAt: Date) =>
  Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000);

const zeroSummary = (month: string): TimeSummary => ({
  month,
  totalMinutes: 0,
  sessionCount: 0,
  byGame: [],
  sessions: [],
});

/**
 * Сводка времени пользователя за месяц `month` (`YYYY-MM`): учитываются
 * `play_segments` с `billable = true` и `open = false`, у которых
 * `started_at` попадает в границы месяца по Москве (см. `monthRangeMoscow`).
 * Минуты сегмента = `floor((ended_at − started_at) / 60s)`, суммируются по
 * игре (`byGame`, по убыванию минут, затем по имени) и по сессии
 * (`sessions`, по убыванию `startedAt` = `created_at` сессии).
 */
export const monthSummary = (
  userId: string,
  month: string,
): Effect.Effect<TimeSummary, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const { from, to } = monthRangeMoscow(month);

    const segmentRows = yield* db
      .select({
        sessionId: playSegments.sessionId,
        appId: playSegments.appId,
        startedAt: playSegments.startedAt,
        endedAt: playSegments.endedAt,
      })
      .from(playSegments)
      .where(
        and(
          eq(playSegments.userId, userId),
          eq(playSegments.billable, true),
          eq(playSegments.open, false),
          gte(playSegments.startedAt, from),
          lt(playSegments.startedAt, to),
        ),
      );

    if (segmentRows.length === 0) return zeroSummary(month);

    const sessionIds = [...new Set(segmentRows.map((s) => s.sessionId))];
    const appIds = [...new Set(segmentRows.map((s) => s.appId))];

    const [sessionRows, gameRows] = yield* Effect.all([
      db
        .select({
          id: sessions.id,
          appId: sessions.appId,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .where(inArray(sessions.id, sessionIds)),
      db
        .select({ appId: games.appId, name: games.name })
        .from(games)
        .where(inArray(games.appId, appIds)),
    ]);

    const nameByAppId = new Map(gameRows.map((g) => [g.appId, g.name]));
    const sessionById = new Map(sessionRows.map((s) => [s.id, s]));

    const minutesBySession = new Map<string, number>();
    const minutesByGame = new Map<number, number>();
    let totalMinutes = 0;

    for (const segment of segmentRows) {
      const minutes = minutesOfSegment(segment.startedAt, segment.endedAt);
      totalMinutes += minutes;
      minutesBySession.set(
        segment.sessionId,
        (minutesBySession.get(segment.sessionId) ?? 0) + minutes,
      );
      minutesByGame.set(
        segment.appId,
        (minutesByGame.get(segment.appId) ?? 0) + minutes,
      );
    }

    const byGame = [...minutesByGame.entries()]
      .map(([appId, minutes]) => ({
        appId,
        name: nameByAppId.get(appId) ?? "",
        minutes,
      }))
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));

    // `sessionId` взят из `segmentRows`, ссылающихся на `sessions` по внешнему
    // ключу — сессия всегда найдена; запасной вариант нужен только типам.
    const sessionsSummary = [...minutesBySession.entries()]
      .map(([sessionId, minutes]) => {
        const session = sessionById.get(sessionId) ?? {
          appId: 0,
          createdAt: new Date(0),
        };
        return {
          sessionId,
          appId: session.appId,
          name: nameByAppId.get(session.appId) ?? "",
          createdAt: session.createdAt,
          minutes,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ createdAt, ...rest }) => ({
        ...rest,
        startedAt: createdAt.toISOString(),
      }));

    return {
      month,
      totalMinutes,
      sessionCount: sessionsSummary.length,
      byGame,
      sessions: sessionsSummary,
    };
  }).pipe(Effect.orDie);
