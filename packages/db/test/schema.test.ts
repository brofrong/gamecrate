import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Db, games, user, userGames } from "../src/index";
import { DbTest } from "./testDb";

const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.provide(DbTest))));

describe("schema", () => {
  it("inserts user with default role player", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(user).values({
          id: "u1",
          name: "n",
          email: "u1@steam.invalid",
          emailVerified: false,
        });
        const [row] = yield* db.select().from(user);
        expect(row?.role).toBe("player");
        expect(row?.libraryPrivate).toBe(false);
        expect(row?.librarySyncedAt).toBeNull();
        expect(row?.steamId).toBeNull();
      }),
    ));

  it("userGames cascade on user delete", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(user).values({
          id: "u1",
          name: "n",
          email: "u1@steam.invalid",
          emailVerified: false,
        });
        yield* db.insert(games).values({ appId: 570, name: "Dota 2" });
        yield* db
          .insert(userGames)
          .values({ userId: "u1", appId: 570, playtimeMinutes: 42 });
        expect(yield* db.select().from(userGames)).toHaveLength(1);

        yield* db.delete(user).where(eq(user.id, "u1"));

        expect(yield* db.select().from(userGames)).toHaveLength(0);
        const [game] = yield* db.select().from(games);
        expect(game?.protonTier).toBe("pending");
      }),
    ));
});
