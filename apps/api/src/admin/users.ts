// Пользователи для админки: список (без Steam-секретов), роль, блокировка и
// сброс входа Steam в контейнере (само сброс выполняет оркестратор, Task 3).
import {
  account,
  Db,
  playSegments,
  profiles,
  sessions,
  type Role,
  user,
} from "@cg/db";
import { type AdminUser, isSyntheticEmail } from "@cg/rpc";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { isActive } from "../session/SessionRepo";

/** Алфавитный список способов входа (`account.provider_id`, без дублей). */
const providersSql = sql<
  Array<string>
>`(select coalesce(array_agg(distinct ${account.providerId} order by ${account.providerId}), '{}') from ${account} where ${account.userId} = ${user.id})`;

/** Момент последней сессии (любой) этого пользователя, нет — null. */
const lastSessionAtSql = sql<Date | null>`(select max(${sessions.createdAt}) from ${sessions} where ${sessions.userId} = ${user.id})`;

/**
 * Игровое время пользователя за всё время в секундах: сумма billable и
 * закрытых (`open = false`) отрезков `play_segments` (как `TimeRepo.monthSummary`,
 * только без границ месяца и в секундах, а не минутах).
 */
const playedSecondsSql = sql<number>`(select coalesce(floor(extract(epoch from sum(${playSegments.endedAt} - ${playSegments.startedAt})))::int, 0) from ${playSegments} where ${playSegments.userId} = ${user.id} and ${playSegments.billable} = true and ${playSegments.open} = false)`;

/** Есть ли у пользователя активная (не `ended`/`failed`) сессия. */
const activeSessionSql = sql<boolean>`exists (select 1 from ${sessions} where ${sessions.userId} = ${user.id} and ${isActive})`;

/** Столбцы `AdminUser` одним select'ом (без N+1 по пользователям). */
const userColumns = {
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  steamId: user.steamId,
  createdAt: user.createdAt,
  blockedAt: user.blockedAt,
  steamLoginResetAt: user.steamLoginResetAt,
  profileSizeBytes: profiles.sizeBytes,
  profileVersion: profiles.version,
  providers: providersSql,
  lastSessionAt: lastSessionAtSql,
  playedSeconds: playedSecondsSql,
  activeSession: activeSessionSql,
};

/** Строка `userColumns`. */
type UserRow = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly steamId: string | null;
  readonly createdAt: Date;
  readonly blockedAt: Date | null;
  readonly steamLoginResetAt: Date | null;
  readonly profileSizeBytes: number | null;
  readonly profileVersion: number | null;
  readonly providers: Array<string>;
  readonly lastSessionAt: Date | null;
  readonly playedSeconds: number;
  readonly activeSession: boolean;
};

/** `UserRow` → `AdminUser`; синтетическая почта (Steam/Telegram) → `null`. */
const toAdminUser = (row: UserRow): AdminUser => ({
  id: row.id,
  name: row.name,
  email: isSyntheticEmail(row.email) ? null : row.email,
  role: row.role,
  providers: row.providers,
  steamId: row.steamId,
  createdAt: row.createdAt.toISOString(),
  lastSessionAt: row.lastSessionAt?.toISOString() ?? null,
  playedSeconds: row.playedSeconds,
  profileSizeBytes: row.profileSizeBytes,
  profileVersion: row.profileVersion,
  blockedAt: row.blockedAt?.toISOString() ?? null,
  steamLoginResetPending: row.steamLoginResetAt !== null,
  activeSession: row.activeSession,
});

/** Все пользователи, новые сверху (`created_at desc`), одним запросом. */
export const listUsers = (): Effect.Effect<Array<AdminUser>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select(userColumns)
      .from(user)
      .leftJoin(profiles, eq(profiles.userId, user.id))
      .orderBy(sql`${user.createdAt} desc`);
    return rows.map(toAdminUser);
  }).pipe(Effect.orDie);

/**
 * Сменить роль пользователя. Себе — `"self"` (роль не меняется, админ не может
 * разжаловать себя не глядя), нет такого пользователя — `"notFound"`, иначе
 * `"ok"`.
 */
export const setRole = (
  actorId: string,
  userId: string,
  role: Role,
): Effect.Effect<"ok" | "self" | "notFound", never, Db> =>
  Effect.gen(function* () {
    if (actorId === userId) return "self" as const;
    const db = yield* Db;
    const updated = yield* db
      .update(user)
      .set({ role })
      .where(eq(user.id, userId))
      .returning({ id: user.id });
    return updated.length > 0 ? ("ok" as const) : ("notFound" as const);
  }).pipe(Effect.orDie);

/**
 * Заблокировать/разблокировать пользователя. Блокировка не запрещает вход на
 * сайт (better-auth не трогаем) — только игровую сессию (`session.start` →
 * `AccessDenied`, проверка в `SessionRepo.startSession`). Блокировка — одна
 * транзакция: строка `user` под `FOR UPDATE` (нет — `notFound`), `blocked_at
 * = coalesce(blocked_at, now)` (первый запрос не перезаписывается) и
 * `stop_requested_at = coalesce(..., now)` для всех активных сессий
 * пользователя (как `stopSession` в `SessionRepo`). Разблокировка просто
 * очищает `blocked_at`. Себе — `"self"`.
 */
export const setBlocked = (
  actorId: string,
  userId: string,
  blocked: boolean,
  now: Date,
): Effect.Effect<"ok" | "self" | "notFound", never, Db> =>
  Effect.gen(function* () {
    if (actorId === userId) return "self" as const;
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [found] = yield* db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, userId))
          .for("update");
        if (found === undefined) return "notFound" as const;

        if (blocked) {
          yield* db
            .update(user)
            .set({
              blockedAt: sql`coalesce(${user.blockedAt}, ${now.toISOString()}::timestamptz)`,
            })
            .where(eq(user.id, userId));
          yield* db
            .update(sessions)
            .set({
              stopRequestedAt: sql`coalesce(${sessions.stopRequestedAt}, ${now.toISOString()}::timestamptz)`,
            })
            .where(and(eq(sessions.userId, userId), isActive));
        } else {
          yield* db
            .update(user)
            .set({ blockedAt: null })
            .where(eq(user.id, userId));
        }
        return "ok" as const;
      }),
    );
  }).pipe(Effect.orDie);

/**
 * Попросить сбросить вход Steam в контейнере пользователя: `steam_login_reset_at
 * = now` (точное значение — оркестратор, Task 3, сравнивает его при сбросе).
 * Не трогает `steam_id`/строки `account`. Нет пользователя — `false`.
 */
export const resetSteamLogin = (
  userId: string,
  now: Date,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const updated = yield* db
      .update(user)
      .set({ steamLoginResetAt: now })
      .where(eq(user.id, userId))
      .returning({ id: user.id });
    return updated.length > 0;
  }).pipe(Effect.orDie);
