import { describe, expect, it } from "bun:test";
import type { SteamLoginSeed } from "@cg/rpc";
import { Duration, Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { SEED_TTL, SteamLoginSeeds } from "../src/SteamLoginSeeds";

const makeSeed = (refreshToken: string): SteamLoginSeed => ({
  accountName: Redacted.make("steamuser"),
  steamId: "76561198000000000",
  refreshToken: Redacted.make(refreshToken),
});

const run = <A, E>(body: Effect.Effect<A, E, SteamLoginSeeds>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(SteamLoginSeeds.layer),
      Effect.provide(TestClock.layer()),
    ),
  );

describe("SteamLoginSeeds", () => {
  it("put then get returns the seed for that user; other users get null", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        const seed = makeSeed("t1");
        yield* seeds.put("u1", seed);
        expect(yield* seeds.get("u1")).toBe(seed);
        expect(yield* seeds.get("u2")).toBeNull();
      }),
    ));

  it("seed expires after 24 hours", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        const seed = makeSeed("t1");
        yield* seeds.put("u1", seed);

        yield* TestClock.adjust("23 hours");
        expect(yield* seeds.get("u1")).toBe(seed);

        // Ещё час и секунду — 24 ч 1 с с момента put.
        yield* TestClock.adjust("1 hours");
        yield* TestClock.adjust("1 seconds");
        expect(yield* seeds.get("u1")).toBeNull();
        // Просроченная запись удалена, а не просто игнорируется повторно.
        expect(yield* seeds.get("u1")).toBeNull();
      }),
    ));

  it("put replaces the previous seed", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("old"));
        const fresh = makeSeed("new");
        yield* seeds.put("u1", fresh);
        expect(yield* seeds.get("u1")).toBe(fresh);
      }),
    ));

  it("clear removes the pending seed", () =>
    run(
      Effect.gen(function* () {
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", makeSeed("t1"));
        yield* seeds.clear("u1");
        expect(yield* seeds.get("u1")).toBeNull();
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
        expect(yield* seeds.get("u1")).toBe(fresh);

        // Нет входа — ничего не делает; чужой вход не трогает.
        yield* seeds.clearOlderThan("u2", new Date(5000));
        expect(yield* seeds.get("u1")).toBe(fresh);
      }),
    ));

  it("SEED_TTL is 24 hours", () => {
    expect(Duration.toHours(SEED_TTL)).toBe(24);
  });
});
