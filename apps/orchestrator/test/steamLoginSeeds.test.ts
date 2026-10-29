import { describe, expect, it } from "bun:test";
import { Db, steamLoginSeeds, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import type { SteamLoginSeed } from "@cg/rpc";
import { eq } from "drizzle-orm";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Logger,
  Redacted,
  References,
  type Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { SEED_TTL, SteamLoginSeeds } from "../src/SteamLoginSeeds";
import { SteamLoginSeedsTest } from "./seedKey";

const ACCOUNT = "s3cr3t-steam-account";
const STEAM_ID = "76561198000000000";

const makeSeed = (refreshToken: string): SteamLoginSeed => ({
  accountName: Redacted.make(ACCOUNT),
  steamId: STEAM_ID,
  refreshToken: Redacted.make(refreshToken),
});

/** Сравнимый вид входа (значения `Redacted` раскрыты). */
const plain = (seed: SteamLoginSeed | null) =>
  seed === null
    ? null
    : {
        accountName: Redacted.value(seed.accountName),
        steamId: seed.steamId,
        refreshToken: Redacted.value(seed.refreshToken),
      };

type Env = Db | SteamLoginSeeds | Scope.Scope;

const run = <A, E>(body: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedUser("u1");
        yield* seedUser("u2");
        // Тестовые часы — только телу: пул соединений БД живёт по настоящим.
        return yield* body.pipe(Effect.provide(TestClock.layer()));
      }),
    ).pipe(
      Effect.provide(SteamLoginSeedsTest.pipe(Layer.provideMerge(DbTest))),
    ),
  );

const seedUser = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(user).values({
      id,
      name: id,
      email: `${id}@example.invalid`,
      emailVerified: true,
    });
  });

/** Строки посевов пользователя как они лежат в БД. */
const rowsOf = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select()
      .from(steamLoginSeeds)
      .where(eq(steamLoginSeeds.userId, userId));
  });

/** Отдельный экземпляр сервиса (новый слой) на той же БД. */
const freshInstance = (
  layer: Layer.Layer<SteamLoginSeeds, never, Db> = SteamLoginSeedsTest,
) => Effect.map(Layer.build(layer), Context.get(SteamLoginSeeds));

describe("SteamLoginSeeds", () => {
  it("put then get returns the seed for that user; other users get null", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        const seed = makeSeed("t1");
        yield* seeds.put("u1", seed);
        expect(plain(yield* seeds.get("u1"))).toEqual(plain(seed));
        expect(yield* seeds.get("u2")).toBeNull();
      }),
    ));

  it("survives a new layer instance", () =>
    run(
      Effect.gen(function* () {
        const first = yield* freshInstance();
        const seed = makeSeed("t1");
        yield* first.put("u1", seed);
        // Новый экземпляр (как после перезапуска оркестратора) видит тот же вход.
        const second = yield* freshInstance();
        expect(plain(yield* second.get("u1"))).toEqual(plain(seed));
      }),
    ));

  it("stores no plaintext", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("eyJ-SECRET-REFRESH-TOKEN"));
        const rows = yield* rowsOf("u1");
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row?.steamId).toBe(STEAM_ID);
        const stored = JSON.stringify(row);
        expect(stored).not.toContain(ACCOUNT);
        expect(stored).not.toContain("eyJ-SECRET-REFRESH-TOKEN");
        // И не в base64 открытого текста: sealed — base64 iv ‖ tag ‖ шифротекст.
        const raw = Buffer.from(row?.sealed ?? "", "base64");
        expect(raw.length).toBeGreaterThan(12 + 16);
        expect(raw.toString("utf8")).not.toContain(ACCOUNT);
        expect(raw.toString("utf8")).not.toContain("eyJ-SECRET-REFRESH-TOKEN");
      }),
    ));

  it("seed expires after 24 hours", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        const seed = makeSeed("t1");
        yield* seeds.put("u1", seed);

        yield* TestClock.adjust("23 hours");
        expect(plain(yield* seeds.get("u1"))).toEqual(plain(seed));

        // Ещё час и секунду — 24 ч 1 с с момента put.
        yield* TestClock.adjust("1 hours");
        yield* TestClock.adjust("1 seconds");
        expect(yield* seeds.get("u1")).toBeNull();
        // Просроченная строка удалена, а не просто игнорируется.
        expect(yield* rowsOf("u1")).toHaveLength(0);
      }),
    ));

  it("put replaces the previous seed", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("old"));
        const fresh = makeSeed("new");
        yield* seeds.put("u1", fresh);
        expect(plain(yield* seeds.get("u1"))).toEqual(plain(fresh));
        expect(yield* rowsOf("u1")).toHaveLength(1);
      }),
    ));

  it("put also drops other users' expired seeds", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u2", makeSeed("stale"));
        yield* TestClock.adjust("25 hours");
        yield* seeds.put("u1", makeSeed("t1"));
        expect(yield* rowsOf("u2")).toHaveLength(0);
        expect(yield* rowsOf("u1")).toHaveLength(1);
      }),
    ));

  it("clear removes the pending seed", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("t1"));
        yield* seeds.clear("u1");
        expect(yield* seeds.get("u1")).toBeNull();
        expect(yield* rowsOf("u1")).toHaveLength(0);
      }),
    ));

  it("clearOlderThan drops only earlier seeds", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        // Вход положен в t=1000 — сброс в t=2000 его убирает.
        yield* TestClock.setTime(1000);
        yield* seeds.put("u1", makeSeed("old"));
        yield* seeds.clearOlderThan("u1", new Date(2000));
        expect(yield* seeds.get("u1")).toBeNull();

        // Вход положен в t=3000, после сброса — остаётся.
        yield* TestClock.setTime(3000);
        const fresh = makeSeed("new");
        yield* seeds.put("u1", fresh);
        yield* seeds.clearOlderThan("u1", new Date(2000));
        expect(plain(yield* seeds.get("u1"))).toEqual(plain(fresh));

        // Положен ровно в момент сброса — остаётся.
        yield* seeds.clearOlderThan("u1", new Date(3000));
        expect(plain(yield* seeds.get("u1"))).toEqual(plain(fresh));

        // Нет входа — ничего не делает; чужой вход не трогает.
        yield* seeds.clearOlderThan("u2", new Date(5000));
        expect(plain(yield* seeds.get("u1"))).toEqual(plain(fresh));
      }),
    ));

  it("wrong key → null and row removed, warning without content", () => {
    const lines: Array<string> = [];
    const capture = Logger.make((options) => {
      lines.push(Logger.formatJson.log(options));
    });
    return run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("eyJ-SECRET-REFRESH-TOKEN"));
        const otherKey = Redacted.make(Buffer.alloc(32, 2).toString("base64"));
        const other = yield* freshInstance(SteamLoginSeeds.layerWith(otherKey));
        expect(yield* other.get("u1")).toBeNull();
        expect(yield* rowsOf("u1")).toHaveLength(0);
      }).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    ).then(() => {
      const text = lines.join("\n");
      expect(text).toContain("u1");
      expect(text).not.toContain(ACCOUNT);
      expect(text).not.toContain("eyJ-SECRET-REFRESH-TOKEN");
    });
  });

  it("corrupt sealed value → null and row removed", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("t1"));
        const db = yield* Db;
        yield* db
          .update(steamLoginSeeds)
          .set({ sealed: Buffer.from("garbage").toString("base64") })
          .where(eq(steamLoginSeeds.userId, "u1"));
        expect(yield* seeds.get("u1")).toBeNull();
        expect(yield* rowsOf("u1")).toHaveLength(0);
      }).pipe(Effect.provideService(References.MinimumLogLevel, "Error")),
    ));

  it("a sealed row does not decrypt for another user", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("t1"));
        yield* seeds.put("u2", makeSeed("t2"));
        const [row] = yield* rowsOf("u1");
        const db = yield* Db;
        // Шифротекст u1, переписанный в строку u2, не принимается.
        yield* db
          .update(steamLoginSeeds)
          .set({ sealed: row?.sealed ?? "" })
          .where(eq(steamLoginSeeds.userId, "u2"));
        expect(yield* seeds.get("u2")).toBeNull();
      }).pipe(Effect.provideService(References.MinimumLogLevel, "Error")),
    ));

  it("seed row goes away with the user", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("t1"));
        const db = yield* Db;
        yield* db.delete(user).where(eq(user.id, "u1"));
        expect(yield* rowsOf("u1")).toHaveLength(0);
      }),
    ));

  it("SEED_TTL is 24 hours", () => {
    expect(Duration.toHours(SEED_TTL)).toBe(24);
  });
});
