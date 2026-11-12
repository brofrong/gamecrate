// Миграция «тарифы, выдачи, начисления минут и поля очереди» (Task 1, спека §2):
// проверяем, что миграция сеет ровно один тариф по умолчанию «Базовый» с нужными
// значениями, что второй тариф по умолчанию не проходит (частичный уникальный
// индекс), и что начисление минут требует положительного значения (CHECK).
import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { Db, minuteCredits, tariffs, user } from "../src/index";
import { DbTest } from "./testDb";

const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.provide(DbTest))));

describe("tariffs migration", () => {
  it("default tariff is seeded", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const rows = yield* db
          .select()
          .from(tariffs)
          .where(eq(tariffs.isDefault, true));
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row?.name).toBe("Базовый");
        expect(row?.monthlyMinutes).toBeNull();
        expect(row?.maxResolution).toBe("1440p");
        expect(row?.maxBitrateMbps).toBe(40);
        expect(row?.queuePriority).toBe(0);
      }),
    ));

  it("second default is rejected", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const result = yield* Effect.exit(
          db.insert(tariffs).values({
            id: crypto.randomUUID(),
            name: "Второй",
            isDefault: true,
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ));

  it("minute credit must be positive", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(user).values({
          id: "u1",
          name: "n",
          email: "u1@steam.invalid",
          emailVerified: false,
        });
        const result = yield* Effect.exit(
          db.insert(minuteCredits).values({
            id: crypto.randomUUID(),
            userId: "u1",
            minutes: 0,
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ));
});
