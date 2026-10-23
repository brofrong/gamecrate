// Запросы к таблице `steam_logins` для `steamLogin.*`: завести попытку (в
// одной транзакции вытеснив прежнюю активную того же пользователя) и прочитать
// свою попытку по id.
import { Db, type SteamLoginState, steamLogins } from "@cg/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

/** Активные (незавершённые) состояния — те же, что в частичном индексе БД `steam_logins_active_user_idx`. */
const activeStates: ReadonlyArray<SteamLoginState> = [
  "pending",
  "waiting",
  "scanned",
];

/** Строка попытки, достаточная для построения `SteamLoginView`. */
export interface SteamLoginRow {
  readonly id: string;
  readonly state: SteamLoginState;
  readonly qrUrl: string | null;
  readonly error: string | null;
}

/**
 * Заводит новую попытку входа для пользователя: отмена прежней активной
 * попытки и вставка новой `pending` — одной транзакцией. Простая транзакция
 * этого не гарантирует сама по себе: при READ COMMITTED два параллельных
 * `steamLogin.start` того же пользователя без активной строки оба увидят
 * `UPDATE` без совпадений и дойдут до `INSERT`; второй `INSERT` дождётся
 * коммита первого и упадёт на уникальном индексе `steam_logins_active_user_idx`
 * (23505). Поэтому первым делом в транзакции берём advisory-лок по
 * `userId` — конкурентный `start` того же пользователя ждёт на этом локе, а
 * не на уникальном индексе, и после коммита первого видит уже вставленную
 * активную строку и корректно её отменяет. Лок держится до конца
 * транзакции и освобождается автоматически при commit/rollback.
 */
export const start = (userId: string): Effect.Effect<string, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const id = crypto.randomUUID();
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${userId})::bigint)`,
        );
        yield* tx
          .update(steamLogins)
          .set({ state: "cancelled" })
          .where(
            and(
              eq(steamLogins.userId, userId),
              inArray(steamLogins.state, activeStates),
            ),
          );
        yield* tx.insert(steamLogins).values({ id, userId });
      }),
    );
    return id;
  }).pipe(Effect.orDie);

/** Своя попытка пользователя по id; чужая или отсутствующая — undefined. */
export const ownRow = (
  userId: string,
  attemptId: string,
): Effect.Effect<SteamLoginRow | undefined, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({
        id: steamLogins.id,
        state: steamLogins.state,
        qrUrl: steamLogins.qrUrl,
        error: steamLogins.error,
      })
      .from(steamLogins)
      .where(
        and(eq(steamLogins.id, attemptId), eq(steamLogins.userId, userId)),
      );
    return row;
  }).pipe(Effect.orDie);
