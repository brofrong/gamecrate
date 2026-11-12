// RPC `account.plan` (спека §2, §3): тариф и остаток минут текущего игрока,
// каталог не скрытых тарифов и пакетов часов — по образцу `streamSettings.test.ts`.
import { describe, expect, it } from "bun:test";
import { Db, hourPacks, tariffGrants, tariffs, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { AccountRpcs, type CurrentUserShape } from "@cg/rpc";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { AccountRpcHandlers } from "../src/account/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";

const player: CurrentUserShape = {
  id: "u1",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: null,
  email: null,
  emailVerified: false,
};

const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.succeed(Option.some(player)),
});

const env = Layer.mergeAll(AccountRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));

const insertUser = (db: Db["Service"], id: string) =>
  db.insert(user).values({ id, name: "Игрок", email: `${id}@example.test` });

const client = RpcTest.makeClient(AccountRpcs);

describe("account.plan", () => {
  it("returns default unlimited plan for a new user", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, player.id);
        return yield* (yield* client)["account.plan"]();
      }),
    );
    expect(plan.tariff.name).toBe("Базовый");
    expect(plan.tariff.monthlyMinutes).toBeNull();
    expect(plan.remainingMinutes).toBeNull();
    expect(plan.grantEndsAt).toBeNull();
    expect(plan.nextRefillAt).toBeNull();
  });

  it("lists non-archived tariffs by priority and hour packs", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, player.id);
        yield* db.insert(tariffs).values([
          {
            id: "t-plus",
            name: "Плюс",
            queuePriority: 10,
            maxResolution: "1080p",
            maxBitrateMbps: 20,
          },
          {
            id: "t-pro",
            name: "Про",
            queuePriority: 20,
            maxResolution: "1440p",
            maxBitrateMbps: 40,
          },
          {
            id: "t-old",
            name: "Старый",
            queuePriority: 5,
            maxResolution: "720p",
            maxBitrateMbps: 10,
            archivedAt: new Date(),
          },
        ]);
        yield* db.insert(hourPacks).values([
          { id: "h-small", name: "Малый", minutes: 60 },
          {
            id: "h-old",
            name: "Старый",
            minutes: 120,
            archivedAt: new Date(),
          },
        ]);
        return yield* (yield* client)["account.plan"]();
      }),
    );
    // Базовый (приоритет 0) + Плюс (10) + Про (20), без архивного Старого.
    expect(result.tariffs.map((t) => t.name)).toEqual([
      "Базовый",
      "Плюс",
      "Про",
    ]);
    expect(result.hourPacks.map((p) => p.name)).toEqual(["Малый"]);
  });

  it("reflects the player's granted tariff, remaining minutes and refill date", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, player.id);
        yield* db.insert(tariffs).values({
          id: "t-plus",
          name: "Плюс",
          priceRub: 50_000,
          queuePriority: 10,
          monthlyMinutes: 60,
          maxResolution: "1080p",
          maxBitrateMbps: 20,
        });
        const now = new Date();
        yield* db.insert(tariffGrants).values({
          id: "g1",
          userId: player.id,
          tariffId: "t-plus",
          startsAt: now,
          endsAt: null,
        });
        return yield* (yield* client)["account.plan"]();
      }),
    );
    expect(result.tariff.name).toBe("Плюс");
    expect(result.tariff.priceRub).toBe(50_000);
    expect(result.remainingMinutes).toBe(60);
    expect(result.grantEndsAt).toBeNull();
    expect(result.nextRefillAt).not.toBeNull();
  });

  it("drops to the default tariff after a grant ends", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, player.id);
        yield* db.insert(tariffs).values({
          id: "t-plus",
          name: "Плюс",
          queuePriority: 10,
          maxResolution: "1080p",
          maxBitrateMbps: 20,
        });
        const past = new Date(Date.now() - 60_000);
        yield* db.insert(tariffGrants).values({
          id: "g1",
          userId: player.id,
          tariffId: "t-plus",
          startsAt: new Date(past.getTime() - 60_000),
          endsAt: past,
        });
        return yield* (yield* client)["account.plan"]();
      }),
    );
    expect(result.tariff.name).toBe("Базовый");
    expect(result.tariff.monthlyMinutes).toBeNull();
  });
});
