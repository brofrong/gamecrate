// Последние игры пользователя для блока «Недавние» на главной /app.
import { Db, games, playSegments, sessions } from "@cg/db";
import type { RecentEntry } from "@cg/rpc";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import * as CloudRepo from "./CloudRepo";
import { coverUrl } from "./LibraryService";
import { shownToPlayers } from "./OwnGamesRepo";

/**
 * Сколько последних (не-failed) сессий пользователя просматриваем, сворачивая
 * до уникальных игр. Больше, чем разумное число повторных запусков одной игры
 * подряд, прежде чем встретится следующая — для `limit` (обычно 3) этого
 * достаточно.
 */
const sessionWindow = 50;

const minutesBetween = (start: Date, end: Date) =>
  Math.floor((end.getTime() - start.getTime()) / 60_000);

/**
 * Длительность сессии: сумма закрытых (`open = false`) отрезков в минутах
 * (округление вниз общей суммы), а если их нет — от начала сессии до её
 * конца или, если она ещё идёт, до `now`.
 */
export const sessionDurationMinutes = (
  session: { readonly createdAt: Date; readonly endedAt: Date | null },
  closedSegments: ReadonlyArray<{
    readonly startedAt: Date;
    readonly endedAt: Date;
  }>,
  now: Date,
): number => {
  if (closedSegments.length === 0)
    return minutesBetween(session.createdAt, session.endedAt ?? now);
  const totalMillis = closedSegments.reduce(
    (sum, segment) =>
      sum + (segment.endedAt.getTime() - segment.startedAt.getTime()),
    0,
  );
  return Math.floor(totalMillis / 60_000);
};

/**
 * Последние `limit` игр пользователя: для каждого `appId` — самая свежая по
 * `created_at` сессия в состоянии, отличном от `failed`; порядок — по
 * `created_at` этой сессии, новые первыми. `lastPlayedAt` = `ended_at ??
 * created_at`. Игра без такой сессии не попадает в список, скрытая своя
 * игра — тоже (`shownToPlayers`).
 */
export const recentGames = (
  userId: string,
  limit = 3,
): Effect.Effect<ReadonlyArray<RecentEntry>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    const recentSessions = yield* db
      .select({
        id: sessions.id,
        appId: sessions.appId,
        createdAt: sessions.createdAt,
        endedAt: sessions.endedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          ne(sessions.state, "failed"),
          shownToPlayers(sessions.appId),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(sessionWindow);

    // Сессии уже отсортированы по created_at (новые первыми) — первое
    // попадание appId в этом порядке и есть его самая свежая сессия.
    const latest: Array<(typeof recentSessions)[number]> = [];
    const seenAppIds = new Set<number>();
    for (const session of recentSessions) {
      if (seenAppIds.has(session.appId)) continue;
      seenAppIds.add(session.appId);
      latest.push(session);
      if (latest.length === limit) break;
    }

    if (latest.length === 0) return [];

    const appIds = latest.map((session) => session.appId);
    const sessionIds = latest.map((session) => session.id);

    const [gameRows, segmentRows, cloudStatuses, now] = yield* Effect.all([
      db
        .select({ appId: games.appId, name: games.name })
        .from(games)
        .where(inArray(games.appId, appIds)),
      db
        .select({
          sessionId: playSegments.sessionId,
          startedAt: playSegments.startedAt,
          endedAt: playSegments.endedAt,
        })
        .from(playSegments)
        .where(
          and(
            inArray(playSegments.sessionId, sessionIds),
            eq(playSegments.open, false),
          ),
        ),
      CloudRepo.cloudStatuses(appIds),
      DateTime.nowAsDate,
    ]);

    const nameByAppId = new Map(gameRows.map((row) => [row.appId, row.name]));
    const segmentsBySession = new Map<
      string,
      Array<{ startedAt: Date; endedAt: Date }>
    >();
    for (const segment of segmentRows) {
      const list = segmentsBySession.get(segment.sessionId) ?? [];
      list.push({ startedAt: segment.startedAt, endedAt: segment.endedAt });
      segmentsBySession.set(segment.sessionId, list);
    }

    return latest.map((session) => ({
      appId: session.appId,
      name: nameByAppId.get(session.appId) ?? "",
      coverUrl: coverUrl(session.appId),
      cloud: CloudRepo.cloudStatusOf(cloudStatuses, session.appId),
      lastPlayedAt: (session.endedAt ?? session.createdAt).toISOString(),
      lastDurationMinutes: sessionDurationMinutes(
        session,
        segmentsBySession.get(session.id) ?? [],
        now,
      ),
    }));
  }).pipe(Effect.orDie);
