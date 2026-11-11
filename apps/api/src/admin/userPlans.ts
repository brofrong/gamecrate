// Тариф, остаток минут и история выдач/начислений пользователя (карточка
// пользователя, спека §2, §3, §8): `loadUserPlan` отдаёт их разом (без N+1),
// `grantTariff`/`revokeTariff`/`addMinutes` — меняют историю. Эффективный
// тариф берётся из `loadBalance` (`@cg/db`, Task 3: `currentTariff` +
// остаток минут одним расчётом); если это встроенный `FALLBACK_TARIFF` (нет
// строки по умолчанию в БД), полный `Tariff` для него строится из его полей
// вручную (`isDefault: true, archived: false, priceRub: null`) — у fallback
// нет настоящей строки `tariffs`, маппинг `toTariff` (`tariffs.ts`) к нему
// не применим; для настоящего тарифа используется он же — не дублируем
// маппинг строки `tariffs` в форму для админки.
import {
  Db,
  FALLBACK_TARIFF,
  loadBalance,
  minuteCredits,
  tariffGrants,
  tariffs,
  user,
} from "@cg/db";
import type { AdminUserPlan, Tariff } from "@cg/rpc";
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { toTariff } from "./tariffs";

/** Алиас `user` для имени админа, выдавшего/начислившего вручную. */
const granter = alias(user, "granter");

/** Полный `Tariff` действующего тарифа: настоящая строка или `FALLBACK_TARIFF`. */
const loadEffectiveTariff = (
  tariffId: string,
): Effect.Effect<Tariff, never, Db> =>
  Effect.gen(function* () {
    if (tariffId === FALLBACK_TARIFF.id) {
      return {
        id: FALLBACK_TARIFF.id,
        name: FALLBACK_TARIFF.name,
        priceRub: null,
        queuePriority: FALLBACK_TARIFF.queuePriority,
        monthlyMinutes: FALLBACK_TARIFF.monthlyMinutes,
        rollover: FALLBACK_TARIFF.rollover,
        maxResolution: FALLBACK_TARIFF.maxResolution,
        maxBitrateMbps: FALLBACK_TARIFF.maxBitrateMbps,
        maxSessionMinutes: FALLBACK_TARIFF.maxSessionMinutes,
        isDefault: true,
        archived: false,
      };
    }
    const db = yield* Db;
    // `tariffId` взят из действующей выдачи или тарифа по умолчанию
    // (`loadBalance`/`currentTariff`), оба ссылаются на реальную строку
    // `tariffs` (FK) — строка гарантированно есть.
    const [row] = yield* db
      .select()
      .from(tariffs)
      .where(eq(tariffs.id, tariffId))
      .limit(1);
    return toTariff(row!);
  }).pipe(Effect.orDie);

/** Условие «эта выдача действует на момент `now`» — как в `currentTariff` (`@cg/db`). */
const activeGrant = (userId: string, now: Date) =>
  and(
    eq(tariffGrants.userId, userId),
    lte(tariffGrants.startsAt, now),
    or(isNull(tariffGrants.endsAt), gt(tariffGrants.endsAt, now)),
  );

/**
 * Карточка пользователя: действующий тариф, остаток минут и история выдач/
 * начислений (новые сверху). Нет пользователя — `null`.
 */
export const loadUserPlan = (
  userId: string,
  now: Date,
): Effect.Effect<AdminUserPlan | null, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [found] = yield* db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (found === undefined) return null;

    const balance = yield* loadBalance(userId, now);
    const tariff = yield* loadEffectiveTariff(balance.tariff.id);

    const grantRows = yield* db
      .select({
        id: tariffGrants.id,
        tariffName: tariffs.name,
        startsAt: tariffGrants.startsAt,
        endsAt: tariffGrants.endsAt,
        grantedBy: granter.name,
      })
      .from(tariffGrants)
      .innerJoin(tariffs, eq(tariffGrants.tariffId, tariffs.id))
      .leftJoin(granter, eq(tariffGrants.grantedBy, granter.id))
      .where(eq(tariffGrants.userId, userId))
      .orderBy(desc(tariffGrants.startsAt));

    const creditRows = yield* db
      .select({
        id: minuteCredits.id,
        minutes: minuteCredits.minutes,
        comment: minuteCredits.comment,
        createdAt: minuteCredits.createdAt,
        grantedBy: granter.name,
      })
      .from(minuteCredits)
      .leftJoin(granter, eq(minuteCredits.grantedBy, granter.id))
      .where(eq(minuteCredits.userId, userId))
      .orderBy(desc(minuteCredits.createdAt));

    const remainingMinutes =
      balance.remainingMs === null
        ? null
        : Math.max(0, Math.floor(balance.remainingMs / 60_000));

    return {
      tariff,
      grantEndsAt: balance.grantEndsAt?.toISOString() ?? null,
      periodEndsAt: balance.periodEndsAt.toISOString(),
      remainingMinutes,
      grants: grantRows.map((g) => ({
        id: g.id,
        tariffName: g.tariffName,
        startsAt: g.startsAt.toISOString(),
        endsAt: g.endsAt?.toISOString() ?? null,
        grantedBy: g.grantedBy,
      })),
      credits: creditRows.map((c) => ({
        id: c.id,
        minutes: c.minutes,
        comment: c.comment,
        createdAt: c.createdAt.toISOString(),
        grantedBy: c.grantedBy,
      })),
    };
  }).pipe(Effect.orDie);

/**
 * Выдать тариф: закрывает действующую выдачу текущим моментом (если она
 * есть) и открывает новую с этого же момента (спека §2, «новая выдача
 * заменяет предыдущую»). Лочит строку пользователя (`for("update")`) первым
 * делом в транзакции — как `setBlocked` (`users.ts`): без этого лока два
 * конкурентных вызова оба видят "нет действующей выдачи" (пустой список под
 * `activeGrant`) и оставляют две открытые выдачи одновременно; с локом
 * второй вызов блокируется до коммита первого и видит его свежую выдачу уже
 * под `select ... for update`. `endsAt <= now` — `"badEnd"` (проверяется до
 * транзакции — чистое сравнение дат, без похода в БД); архивный тариф —
 * `"archived"`; нет пользователя или тарифа — `"notFound"`.
 */
export const grantTariff = (
  userId: string,
  tariffId: string,
  endsAt: Date | null,
  grantedBy: string,
  now: Date,
): Effect.Effect<"ok" | "notFound" | "archived" | "badEnd", never, Db> =>
  Effect.gen(function* () {
    if (endsAt !== null && endsAt.getTime() <= now.getTime()) {
      return "badEnd" as const;
    }
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [userRow] = yield* db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, userId))
          .for("update");
        if (userRow === undefined) return "notFound" as const;

        const [tariffRow] = yield* db
          .select({ archivedAt: tariffs.archivedAt })
          .from(tariffs)
          .where(eq(tariffs.id, tariffId));
        if (tariffRow === undefined) return "notFound" as const;
        if (tariffRow.archivedAt !== null) return "archived" as const;

        yield* db
          .update(tariffGrants)
          .set({ endsAt: now })
          .where(activeGrant(userId, now));

        yield* db.insert(tariffGrants).values({
          id: crypto.randomUUID(),
          userId,
          tariffId,
          startsAt: now,
          endsAt,
          grantedBy,
        });
        return "ok" as const;
      }),
    );
  }).pipe(Effect.orDie);

/**
 * «Снять тариф»: закрыть действующую выдачу текущим моментом (пользователь
 * падает на тариф по умолчанию). Нет действующей выдачи — `"none"`.
 */
export const revokeTariff = (
  userId: string,
  now: Date,
): Effect.Effect<"ok" | "none", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const updated = yield* db
      .update(tariffGrants)
      .set({ endsAt: now })
      .where(activeGrant(userId, now))
      .returning({ id: tariffGrants.id });
    return updated.length > 0 ? ("ok" as const) : ("none" as const);
  }).pipe(Effect.orDie);

/**
 * Начислить минуты сверх тарифа с комментарием (докупка/компенсация, спека
 * §3: «ручное начисление… не сгорает никогда»). Нет пользователя —
 * `"notFound"`.
 */
export const addMinutes = (
  userId: string,
  minutes: number,
  comment: string,
  grantedBy: string,
  now: Date,
): Effect.Effect<"ok" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [userRow] = yield* db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (userRow === undefined) return "notFound" as const;

    yield* db.insert(minuteCredits).values({
      id: crypto.randomUUID(),
      userId,
      minutes,
      comment,
      grantedBy,
      createdAt: now,
    });
    return "ok" as const;
  }).pipe(Effect.orDie);
