// Загрузчики действующего тарифа, остатка минут и лимита сессии (Task 3,
// спека 2026-11-10 §2–§3): `currentTariff`/`loadBalance` — тонкая обвязка
// над `computeBalance` (Task 2, покрыт `minutes.test.ts`), здесь проверяется
// только сбор входных данных из БД и выбор действующей выдачи/лимита сессии.
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  Db,
  games,
  playSegments,
  sessions,
  tariffGrants,
  tariffs,
  user,
  type Database,
} from "../src/index";
import { FALLBACK_TARIFF } from "../src/minutes";
import { currentTariff, loadBalance, sessionLimit } from "../src/tariffs";
import { DbTest } from "./testDb";

const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.provide(DbTest))));

const d = (iso: string) => new Date(iso);
const min = (n: number) => n * 60_000;

const insertUser = (db: Database, id: string) =>
  db
    .insert(user)
    .values({ id, name: id, email: `${id}@test.invalid`, emailVerified: false });

/** Игра `appId` и сессия `sessionId` для `userId` — нужны FK `play_segments`. */
const insertSession = (db: Database, sessionId: string, userId: string) =>
  Effect.gen(function* () {
    yield* db.insert(games).values({ appId: 1, name: "G1" });
    yield* db.insert(sessions).values({ id: sessionId, userId, appId: 1 });
  });

describe("currentTariff", () => {
  it("returns the active grant, else default", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");

        // Без выдач — тариф по умолчанию (сидированный «Базовый»).
        const withoutGrant = yield* currentTariff("u1", d("2026-06-10T00:00:00Z"));
        expect(withoutGrant.name).toBe("Базовый");
        expect(withoutGrant.monthlyMinutes).toBeNull();

        const [vip] = yield* db
          .insert(tariffs)
          .values({ id: "vip", name: "VIP", queuePriority: 5, monthlyMinutes: 1000 })
          .returning();
        const [future] = yield* db
          .insert(tariffs)
          .values({ id: "future", name: "Future", queuePriority: 9 })
          .returning();

        // Просроченная выдача не действует.
        yield* db.insert(tariffGrants).values({
          id: "g-old",
          userId: "u1",
          tariffId: vip!.id,
          startsAt: d("2026-01-01T00:00:00Z"),
          endsAt: d("2026-02-01T00:00:00Z"),
        });
        // Будущая выдача ещё не действует.
        yield* db.insert(tariffGrants).values({
          id: "g-future",
          userId: "u1",
          tariffId: future!.id,
          startsAt: d("2026-12-01T00:00:00Z"),
          endsAt: null,
        });
        const stillDefault = yield* currentTariff("u1", d("2026-06-10T00:00:00Z"));
        expect(stillDefault.name).toBe("Базовый");

        // Действующая бессрочная выдача.
        yield* db.insert(tariffGrants).values({
          id: "g-active",
          userId: "u1",
          tariffId: vip!.id,
          startsAt: d("2026-01-01T00:00:00Z"),
          endsAt: null,
        });
        const active = yield* currentTariff("u1", d("2026-06-10T00:00:00Z"));
        expect(active.id).toBe("vip");
        expect(active.queuePriority).toBe(5);
        expect(active.monthlyMinutes).toBe(1000);
      }),
    ));

  it("falls back to FALLBACK_TARIFF when no default row", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* db.delete(tariffs); // удаляем сидированный тариф по умолчанию

        const t = yield* currentTariff("u1", d("2026-06-10T00:00:00Z"));
        expect(t).toBe(FALLBACK_TARIFF);
      }),
    ));
});

describe("loadBalance", () => {
  it("sums only billable segments", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        const [t600] = yield* db
          .insert(tariffs)
          .values({ id: "t600", name: "600", monthlyMinutes: 600 })
          .returning();
        yield* db.insert(tariffGrants).values({
          id: "g1",
          userId: "u1",
          tariffId: t600!.id,
          startsAt: d("2026-01-01T00:00:00Z"),
          endsAt: null,
        });
        yield* insertSession(db, "s1", "u1");
        yield* db.insert(playSegments).values([
          {
            sessionId: "s1",
            userId: "u1",
            appId: 1,
            startedAt: d("2026-01-05T00:00:00Z"),
            endedAt: d("2026-01-05T01:40:00Z"), // 100 минут, billable
            billable: true,
            open: false,
          },
          {
            sessionId: "s1",
            userId: "u1",
            appId: 1,
            startedAt: d("2026-01-05T02:00:00Z"),
            endedAt: d("2026-01-05T02:50:00Z"), // 50 минут, не billable
            billable: false,
            open: false,
          },
        ]);

        const balance = yield* loadBalance("u1", d("2026-01-10T00:00:00Z"));
        expect(balance.remainingMs).toBe(min(500));
      }),
    ));
});

describe("sessionLimit", () => {
  it("picks the smaller of minutes and session length", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        const [t] = yield* db
          .insert(tariffs)
          .values({
            id: "t-cap",
            name: "Cap",
            monthlyMinutes: 600,
            maxSessionMinutes: 60,
          })
          .returning();
        yield* db.insert(tariffGrants).values({
          id: "g1",
          userId: "u1",
          tariffId: t!.id,
          startsAt: d("2026-01-01T00:00:00Z"),
          endsAt: null,
        });
        yield* insertSession(db, "s1", "u1");

        const now = d("2026-01-10T00:00:00Z");
        yield* db.insert(playSegments).values({
          sessionId: "s1",
          userId: "u1",
          appId: 1,
          startedAt: new Date(now.getTime() - min(50)),
          endedAt: now,
          billable: true,
          open: false,
        });

        const limit = yield* sessionLimit("u1", "s1", now);
        expect(limit).toEqual({ reason: "session_length", remainingMs: min(10) });
      }),
    ));

  it("is null for unlimited tariff without session cap", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        yield* insertSession(db, "s1", "u1");

        const limit = yield* sessionLimit("u1", "s1", d("2026-01-10T00:00:00Z"));
        expect(limit).toBeNull();
      }),
    ));

  it("limited minutes without a session cap still returns the minutes limit", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1");
        const [t600] = yield* db
          .insert(tariffs)
          .values({ id: "t600-nocap", name: "600 без лимита сессии", monthlyMinutes: 600 })
          .returning();
        yield* db.insert(tariffGrants).values({
          id: "g1",
          userId: "u1",
          tariffId: t600!.id,
          startsAt: d("2026-01-01T00:00:00Z"),
          endsAt: null,
        });
        yield* insertSession(db, "s1", "u1");

        const now = d("2026-01-10T00:00:00Z");
        yield* db.insert(playSegments).values({
          sessionId: "s1",
          userId: "u1",
          appId: 1,
          startedAt: new Date(now.getTime() - min(100)),
          endedAt: now,
          billable: true,
          open: false,
        });

        const limit = yield* sessionLimit("u1", "s1", now);
        expect(limit).toEqual({ reason: "minutes", remainingMs: min(500) });
      }),
    ));
});
