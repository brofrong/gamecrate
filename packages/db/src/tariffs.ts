// Загрузка действующего тарифа пользователя, остатка минут и лимита длины
// сессии (спека 2026-11-10 §2–§3) — обвязка над чистым расчётом
// `computeBalance` (`minutes.ts`, Task 2): здесь только сбор входных данных
// из БД, сама арифметика остатка — там.
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "./Db";
import {
  type Balance,
  computeBalance,
  FALLBACK_TARIFF,
  type Credit,
  type GrantSpan,
  type TariffLimits,
  type Usage,
} from "./minutes";
import {
  minuteCredits,
  playSegments,
  tariffGrants,
  tariffs,
  user,
  type TariffRow,
} from "./schema";

/** Строка `tariffs` → лимиты, которые нужны расчёту остатка и сессии. */
export const toLimits = (row: TariffRow): TariffLimits => ({
  id: row.id,
  name: row.name,
  queuePriority: row.queuePriority,
  monthlyMinutes: row.monthlyMinutes,
  rollover: row.rollover,
  maxResolution: row.maxResolution,
  maxBitrateMbps: row.maxBitrateMbps,
  maxSessionMinutes: row.maxSessionMinutes,
});

/**
 * Тариф по умолчанию (`is_default = true`, спека §2); если такой строки нет
 * (не должно случаться — ровно одна сидируется миграцией, но админка может
 * удалить её без замены), действует встроенный `FALLBACK_TARIFF` — анти-цель
 * спеки «никогда не запрещать игру» не допускает здесь ошибку.
 */
export const defaultTariff = (): Effect.Effect<TariffLimits, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select()
      .from(tariffs)
      .where(eq(tariffs.isDefault, true))
      .limit(1);
    return row ? toLimits(row) : FALLBACK_TARIFF;
  }).pipe(Effect.orDie);

/**
 * Действующий тариф пользователя на момент `now`: самая свежая по `startsAt`
 * выдача с `startsAt <= now` и (`endsAt` пуст или `endsAt > now`); если такой
 * выдачи нет — тариф по умолчанию (`defaultTariff`).
 */
export const currentTariff = (
  userId: string,
  now: Date,
): Effect.Effect<TariffLimits, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ tariff: tariffs })
      .from(tariffGrants)
      .innerJoin(tariffs, eq(tariffGrants.tariffId, tariffs.id))
      .where(
        and(
          eq(tariffGrants.userId, userId),
          lte(tariffGrants.startsAt, now),
          or(isNull(tariffGrants.endsAt), gt(tariffGrants.endsAt, now)),
        ),
      )
      .orderBy(desc(tariffGrants.startsAt))
      .limit(1);
    return row ? toLimits(row.tariff) : yield* defaultTariff();
  }).pipe(Effect.orDie);

/**
 * Остаток минут пользователя на момент `now` (`computeBalance`, Task 2):
 * грузит все его выдачи и начисления, `user.createdAt` и billable-отрезки
 * `play_segments`. У открытого отрезка конец берётся как сохранён —
 * `max(endedAt, startedAt)` (продлевается heartbeat'ом, не обрезается по
 * `now` здесь — это делает сам `computeBalance`). Пользователь не найден —
 * не должно случаться (сессия требует существующего `user_id`), но на этот
 * случай якорь полос — само `now`, чтобы не упасть.
 */
export const loadBalance = (
  userId: string,
  now: Date,
): Effect.Effect<Balance, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [userRow] = yield* db
      .select({ createdAt: user.createdAt })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const grantRows = yield* db
      .select({
        tariff: tariffs,
        startsAt: tariffGrants.startsAt,
        endsAt: tariffGrants.endsAt,
      })
      .from(tariffGrants)
      .innerJoin(tariffs, eq(tariffGrants.tariffId, tariffs.id))
      .where(eq(tariffGrants.userId, userId));
    const creditRows = yield* db
      .select({ minutes: minuteCredits.minutes, at: minuteCredits.createdAt })
      .from(minuteCredits)
      .where(eq(minuteCredits.userId, userId));
    const segmentRows = yield* db
      .select({
        startedAt: playSegments.startedAt,
        endedAt: playSegments.endedAt,
      })
      .from(playSegments)
      .where(
        and(eq(playSegments.userId, userId), eq(playSegments.billable, true)),
      );
    const fallback = yield* defaultTariff();

    const grants: ReadonlyArray<GrantSpan> = grantRows.map((g) => ({
      tariff: toLimits(g.tariff),
      startsAt: g.startsAt,
      endsAt: g.endsAt,
    }));
    const credits: ReadonlyArray<Credit> = creditRows.map((c) => ({
      minutes: c.minutes,
      at: c.at,
    }));
    const usage: ReadonlyArray<Usage> = segmentRows.map((s) => ({
      startedAt: s.startedAt,
      endedAt: new Date(Math.max(s.endedAt.getTime(), s.startedAt.getTime())),
    }));

    return computeBalance({
      userCreatedAt: userRow?.createdAt ?? now,
      defaultTariff: fallback,
      grants,
      credits,
      usage,
      now,
    });
  }).pipe(Effect.orDie);

/** Почему сессию пора останавливать: кончились минуты или длина сессии. */
export type LimitReason = "minutes" | "session_length";

export type SessionLimit = {
  readonly remainingMs: number;
  readonly reason: LimitReason;
};

/**
 * Меньший из остатков: минуты пользователя (`loadBalance`) и длина сессии
 * (billable-время сессии `sessionId` против `maxSessionMinutes` действующего
 * тарифа); `null` — ограничений нет вовсе (оба безлимитны). При равенстве
 * остатков возвращает `"minutes"`.
 */
export const sessionLimit = (
  userId: string,
  sessionId: string,
  now: Date,
): Effect.Effect<SessionLimit | null, never, Db> =>
  Effect.gen(function* () {
    const balance = yield* loadBalance(userId, now);
    const maxSessionMinutes = balance.tariff.maxSessionMinutes;

    // Без лимита длины сессии запрос отрезков этой сессии не нужен вовсе —
    // `sessionLimit` зовётся на каждый тик оркестратора и `session.watch`.
    if (maxSessionMinutes === null) {
      return balance.remainingMs === null
        ? null
        : { remainingMs: balance.remainingMs, reason: "minutes" as const };
    }

    const db = yield* Db;
    const segmentRows = yield* db
      .select({
        startedAt: playSegments.startedAt,
        endedAt: playSegments.endedAt,
      })
      .from(playSegments)
      .where(
        and(
          eq(playSegments.sessionId, sessionId),
          eq(playSegments.billable, true),
        ),
      );
    const usedMs = segmentRows.reduce((sum, s) => {
      const end = Math.min(
        Math.max(s.endedAt.getTime(), s.startedAt.getTime()),
        now.getTime(),
      );
      return sum + Math.max(0, end - s.startedAt.getTime());
    }, 0);
    const sessionRemainingMs = maxSessionMinutes * 60_000 - usedMs;

    if (balance.remainingMs === null) {
      return { remainingMs: sessionRemainingMs, reason: "session_length" as const };
    }
    return sessionRemainingMs < balance.remainingMs
      ? { remainingMs: sessionRemainingMs, reason: "session_length" as const }
      : { remainingMs: balance.remainingMs, reason: "minutes" as const };
  }).pipe(Effect.orDie);
