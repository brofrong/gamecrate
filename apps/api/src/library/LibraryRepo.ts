// Запросы библиотеки к БД: состояние синхронизации пользователя, игры, тиры ProtonDB.
import { Db, games, user, userGames } from "@cg/db";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Array as Arr, Effect } from "effect";

/** Игра из Steam для записи в библиотеку. */
export interface OwnedGame {
  readonly appId: number;
  readonly name: string;
  readonly playtimeMinutes: number;
}

/** Размер пачки upsert: 500 строк × ≤4 параметра — далеко от лимита Postgres (65535). */
const batchSize = 500;

/** Состояние библиотеки пользователя; нет такого пользователя — undefined. */
export const libraryState = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({
        steamId: user.steamId,
        librarySyncedAt: user.librarySyncedAt,
        libraryPrivate: user.libraryPrivate,
      })
      .from(user)
      .where(eq(user.id, userId));
    return row;
  });

/** Профиль Steam скрыт: только флаг, сохранённая библиотека не трогается. */
export const markPrivate = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(user)
      .set({ libraryPrivate: true })
      .where(eq(user.id, userId));
  });

/**
 * Заменяет библиотеку пользователя списком из Steam в одной транзакции:
 * upsert `games` (имя) и `userGames` пачками, удаление игр, которых больше нет,
 * `librarySyncedAt = now`, `libraryPrivate = false`.
 */
export const replaceLibrary = (
  userId: string,
  owned: ReadonlyArray<OwnedGame>,
  now: Date,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Без дублей (ON CONFLICT не может обновить строку дважды за запрос) и по appId:
    // одинаковый порядок блокировок строк `games` у параллельных синхронизаций.
    const list = [
      ...new Map(owned.map((game) => [game.appId, game])).values(),
    ].toSorted((a, b) => a.appId - b.appId);

    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        for (const batch of Arr.chunksOf(list, batchSize)) {
          yield* tx
            .insert(games)
            .values(batch.map(({ appId, name }) => ({ appId, name })))
            .onConflictDoUpdate({
              target: games.appId,
              set: { name: sql`excluded.name`, updatedAt: now },
              setWhere: sql`${games.name} is distinct from excluded.name`,
            });
          yield* tx
            .insert(userGames)
            .values(
              batch.map(({ appId, playtimeMinutes }) => ({
                userId,
                appId,
                playtimeMinutes,
                syncedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: [userGames.userId, userGames.appId],
              set: {
                playtimeMinutes: sql`excluded.playtime_minutes`,
                syncedAt: now,
              },
            });
        }
        // Все строки этой синхронизации получили syncedAt = now; остальные — игр больше нет.
        yield* tx
          .delete(userGames)
          .where(
            and(eq(userGames.userId, userId), ne(userGames.syncedAt, now)),
          );
        yield* tx
          .update(user)
          .set({ librarySyncedAt: now, libraryPrivate: false })
          .where(eq(user.id, userId));
      }),
    );
  });

/** Игры пользователя: по убыванию времени в игре, затем по имени. */
export const listEntries = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select({
        appId: games.appId,
        name: games.name,
        playtimeMinutes: userGames.playtimeMinutes,
        protonTier: games.protonTier,
      })
      .from(userGames)
      .innerJoin(games, eq(userGames.appId, games.appId))
      .where(eq(userGames.userId, userId))
      .orderBy(
        desc(userGames.playtimeMinutes),
        asc(games.name),
        asc(games.appId),
      );
  });

/** appId игр пользователя. */
export const ownedAppIds = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({ appId: userGames.appId })
      .from(userGames)
      .where(eq(userGames.userId, userId));
    return rows.map((row) => row.appId);
  });

/** Из `appIds` — игры, тир которых не проверялся или проверялся раньше `checkedBefore`. */
export const staleTierAppIds = (
  appIds: ReadonlyArray<number>,
  checkedBefore: Date,
) =>
  Effect.gen(function* () {
    if (appIds.length === 0) return [];
    const db = yield* Db;
    const rows = yield* db
      .select({ appId: games.appId })
      .from(games)
      .where(
        and(
          inArray(games.appId, [...appIds]),
          or(
            isNull(games.protonCheckedAt),
            lt(games.protonCheckedAt, checkedBefore),
          ),
        ),
      );
    return rows.map((row) => row.appId);
  });

/** Сохраняет тир ProtonDB и время проверки. */
export const setTier = (appId: number, tier: string, checkedAt: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(games)
      .set({ protonTier: tier, protonCheckedAt: checkedAt })
      .where(eq(games.appId, appId));
  });
