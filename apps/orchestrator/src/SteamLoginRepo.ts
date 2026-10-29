// Попытки входа в Steam по QR в БД (`steam_logins`) и привязка Steam-аккаунта
// к пользователю сайта. Строку заводит API (`pending`) и отменяет при новой
// попытке (`cancelled`); всё остальное пишет SteamLoginRunner. Каждая запись
// раннера условна: меняется только ещё активная строка, так что отменённую
// API попытку (или проваленную при старте) раннер уже не перезапишет.
//
// В строке — только состояние, ссылка QR и причина; токен и имя аккаунта
// Steam сюда не попадают никогда.
import { account, Db, type SteamLoginState, steamLogins, user } from "@cg/db";
import { steamLoginReasons } from "@cg/rpc";
import { and, asc, eq, inArray, lt, ne, notInArray } from "drizzle-orm";
import { Effect } from "effect";

/** Активные состояния — те же, что в частичном индексе `steam_logins_active_user_idx`. */
const activeStates: Array<SteamLoginState> = ["pending", "waiting", "scanned"];
const isActive = inArray(steamLogins.state, activeStates);

/** Конечные состояния попытки (спека §3) — кандидаты на удаление по возрасту. */
const finishedStates: Array<SteamLoginState> = [
  "done",
  "expired",
  "failed",
  "cancelled",
];

/** Попытка, которую раннеру предстоит начать. */
export interface PendingAttempt {
  readonly id: string;
  readonly userId: string;
}

/**
 * Самые старые `pending`-попытки, не больше `limit`, кроме уже взятых этим
 * процессом (`exclude` — они остаются `pending`, пока Steam не выдал QR).
 */
export const pending = (limit: number, exclude: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    if (limit <= 0) return [] as ReadonlyArray<PendingAttempt>;
    const db = yield* Db;
    const rows: ReadonlyArray<PendingAttempt> = yield* db
      .select({ id: steamLogins.id, userId: steamLogins.userId })
      .from(steamLogins)
      .where(
        and(
          eq(steamLogins.state, "pending"),
          exclude.length > 0
            ? notInArray(steamLogins.id, [...exclude])
            : undefined,
        ),
      )
      .orderBy(asc(steamLogins.createdAt))
      .limit(limit);
    return rows;
  });

/** Условное обновление: `true`, если строка была в одном из `from` и обновлена. */
const update = (
  id: string,
  from: ReadonlyArray<SteamLoginState>,
  values: Partial<typeof steamLogins.$inferInsert>,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .update(steamLogins)
      .set(values)
      .where(and(eq(steamLogins.id, id), inArray(steamLogins.state, [...from])))
      .returning({ id: steamLogins.id });
    return rows.length > 0;
  });

/** Steam выдал QR: `pending → waiting`. `false` — попытку уже отменили. */
export const setWaiting = (id: string, qrUrl: string) =>
  update(id, ["pending"], { state: "waiting", qrUrl });

/** Steam обновил код (старый больше не сканируется). */
export const setQrUrl = (id: string, qrUrl: string) =>
  update(id, ["waiting", "scanned"], { qrUrl });

/** Код отсканирован, ждём подтверждения в приложении: `waiting → scanned`. */
export const setScanned = (id: string) =>
  update(id, ["waiting"], { state: "scanned" });

/** Итог попытки; `error` — текст для игрока из `steamLoginReasons` или `null`. */
export const finish = (
  id: string,
  state: "done" | "expired" | "failed",
  error: string | null,
) => update(id, activeStates, { state, error });

/** Попытку отменили (API вытеснил её новой) — Steam-вход больше не нужен. */
export const isCancelled = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ state: steamLogins.state })
      .from(steamLogins)
      .where(eq(steamLogins.id, id));
    return row?.state === "cancelled";
  });

/**
 * При старте оркестратора: попыток прежнего процесса больше никто не ведёт —
 * все активные → `failed` «Вход прервался, покажите новый код» (иначе сайт
 * ждал бы их вечно). Возвращает id проваленных.
 */
export const failStale = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .update(steamLogins)
      .set({ state: "failed", error: steamLoginReasons.interrupted })
      .where(isActive)
      .returning({ id: steamLogins.id });
    return rows.map((row) => row.id);
  });

/**
 * Чистка (спека §3): строки в конечных состояниях (`done`/`expired`/`failed`/
 * `cancelled`), обновлённые раньше `before`, удаляются. Раннер зовёт это при
 * старте и раз в сутки с `before = now − 30 дней`. Возвращает число удалённых
 * строк (для лога).
 */
export const pruneFinished = (before: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .delete(steamLogins)
      .where(
        and(
          inArray(steamLogins.state, finishedStates),
          lt(steamLogins.updatedAt, before),
        ),
      )
      .returning({ id: steamLogins.id });
    return rows.length;
  });

export type LinkResult = "linked" | "otherSteamLinked" | "steamTaken";

/**
 * Привязать Steam к пользователю так же, как OpenID-плагин Better Auth:
 * строка `account` (`providerId "steam"`, `accountId` = SteamID64) и
 * `user.steam_id` — одной транзакцией; строка пользователя под `FOR UPDATE`,
 * чтобы две попытки одного пользователя не привязали два аккаунта.
 * - уже привязан этот же Steam — `linked`, ничего не пишем;
 * - привязан другой — `otherSteamLinked`;
 * - этот Steam у другого пользователя — `steamTaken`.
 * Одновременная привязка того же Steam двумя пользователями упирается в
 * уникальность `user.steam_id` — транзакция падает ошибкой, вызывающий
 * проваливает попытку.
 */
export const linkSteam = (userId: string, steamId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [current] = yield* db
          .select({ steamId: user.steamId })
          .from(user)
          .where(eq(user.id, userId))
          .for("update");
        if (current === undefined)
          return yield* Effect.die(`linkSteam: no user ${userId}`);
        if (current.steamId === steamId) return "linked" as LinkResult;
        if (current.steamId !== null) return "otherSteamLinked" as LinkResult;
        const [owner] = yield* db
          .select({ id: user.id })
          .from(user)
          .where(and(eq(user.steamId, steamId), ne(user.id, userId)));
        if (owner !== undefined) return "steamTaken" as LinkResult;
        const now = new Date();
        yield* db.insert(account).values({
          id: crypto.randomUUID(),
          accountId: steamId,
          providerId: "steam",
          userId,
          createdAt: now,
          updatedAt: now,
        });
        yield* db.update(user).set({ steamId }).where(eq(user.id, userId));
        return "linked" as LinkResult;
      }),
    );
  });
