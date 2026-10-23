// Сводка игрового времени за месяц (`time.summary`) для главной /app: тест
// TimeRepo через RPC, плюс отдельная проверка `monthRangeMoscow`.
import { describe, expect, it } from "bun:test";
import { Db, games, playSegments, sessions, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, TimeRpcs } from "@cg/rpc";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { TimeRpcHandlers } from "../src/time/rpc";
import { monthRangeMoscow } from "../src/time/TimeRepo";

const timeUser: CurrentUserShape = {
  id: "u-time",
  name: "Игрок",
  image: null,
  role: "player",
  steamId: null,
  email: null,
  emailVerified: false,
};

const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.succeed(Option.some(timeUser)),
});

const env = Layer.mergeAll(TimeRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));

const insertUser = (db: Db["Service"], id: string) =>
  db.insert(user).values({ id, name: "Игрок", email: `${id}@example.test` });

const insertGames = (db: Db["Service"], appIds: ReadonlyArray<number>) =>
  db
    .insert(games)
    .values(appIds.map((appId) => ({ appId, name: `Game ${appId}` })));

const insertSession = (
  db: Db["Service"],
  session: {
    id: string;
    userId: string;
    appId: number;
    createdAt: Date;
  },
) =>
  db.insert(sessions).values({
    id: session.id,
    userId: session.userId,
    appId: session.appId,
    state: "ended",
    createdAt: session.createdAt,
  });

const insertSegment = (
  db: Db["Service"],
  segment: {
    sessionId: string;
    userId: string;
    appId: number;
    startedAt: Date;
    endedAt: Date;
    billable: boolean;
    open: boolean;
  },
) => db.insert(playSegments).values(segment);

const client = RpcTest.makeClient(TimeRpcs);

describe("monthRangeMoscow", () => {
  it("returns the Moscow-time month boundary (UTC+3, no DST)", () => {
    expect(monthRangeMoscow("2026-10")).toEqual({
      from: new Date("2026-09-30T21:00:00Z"),
      to: new Date("2026-10-31T21:00:00Z"),
    });
  });

  it("rolls over the year", () => {
    expect(monthRangeMoscow("2026-12")).toEqual({
      from: new Date("2026-11-30T21:00:00Z"),
      to: new Date("2026-12-31T21:00:00Z"),
    });
  });
});

describe("time.summary", () => {
  it("sums billable closed segments of the month by game and by session", async () => {
    const summary = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, timeUser.id);
        yield* insertGames(db, [1, 2]);

        // Game 1 (A): две сессии в октябре — 30 и 45 минут.
        yield* insertSession(db, {
          id: "s-a1",
          userId: timeUser.id,
          appId: 1,
          createdAt: new Date("2026-10-05T10:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-a1",
          userId: timeUser.id,
          appId: 1,
          startedAt: new Date("2026-10-05T10:00:00Z"),
          endedAt: new Date("2026-10-05T10:30:00Z"),
          billable: true,
          open: false,
        });
        yield* insertSession(db, {
          id: "s-a2",
          userId: timeUser.id,
          appId: 1,
          createdAt: new Date("2026-10-10T08:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-a2",
          userId: timeUser.id,
          appId: 1,
          startedAt: new Date("2026-10-10T08:00:00Z"),
          endedAt: new Date("2026-10-10T08:45:00Z"),
          billable: true,
          open: false,
        });

        // Game 2 (B): одна сессия — 20 минут.
        yield* insertSession(db, {
          id: "s-b",
          userId: timeUser.id,
          appId: 2,
          createdAt: new Date("2026-10-07T09:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-b",
          userId: timeUser.id,
          appId: 2,
          startedAt: new Date("2026-10-07T09:00:00Z"),
          endedAt: new Date("2026-10-07T09:20:00Z"),
          billable: true,
          open: false,
        });

        // Не-billable отрезок (100 минут) — не считается.
        yield* insertSession(db, {
          id: "s-nb",
          userId: timeUser.id,
          appId: 1,
          createdAt: new Date("2026-10-12T00:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-nb",
          userId: timeUser.id,
          appId: 1,
          startedAt: new Date("2026-10-12T00:00:00Z"),
          endedAt: new Date("2026-10-12T01:40:00Z"),
          billable: false,
          open: false,
        });

        // Открытый отрезок (100 минут) — не считается.
        yield* insertSession(db, {
          id: "s-open",
          userId: timeUser.id,
          appId: 2,
          createdAt: new Date("2026-10-13T00:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-open",
          userId: timeUser.id,
          appId: 2,
          startedAt: new Date("2026-10-13T00:00:00Z"),
          endedAt: new Date("2026-10-13T01:40:00Z"),
          billable: true,
          open: true,
        });

        // Отрезок прошлого месяца (60 минут) — не считается.
        yield* insertSession(db, {
          id: "s-prev",
          userId: timeUser.id,
          appId: 1,
          createdAt: new Date("2026-09-15T00:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-prev",
          userId: timeUser.id,
          appId: 1,
          startedAt: new Date("2026-09-15T00:00:00Z"),
          endedAt: new Date("2026-09-15T01:00:00Z"),
          billable: true,
          open: false,
        });

        return yield* (yield* client)["time.summary"]({ month: "2026-10" });
      }),
    );

    expect(summary.month).toBe("2026-10");
    expect(summary.totalMinutes).toBe(95);
    expect(summary.sessionCount).toBe(3);
    expect(summary.byGame).toEqual([
      { appId: 1, name: "Game 1", minutes: 75 },
      { appId: 2, name: "Game 2", minutes: 20 },
    ]);
    expect(summary.sessions.map((s) => s.sessionId)).toEqual([
      "s-a2",
      "s-b",
      "s-a1",
    ]);
    expect(summary.sessions.map((s) => s.minutes)).toEqual([45, 20, 30]);
  });

  it("floors minutes per segment before summing, not the total", async () => {
    const summary = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, timeUser.id);
        yield* insertGames(db, [5, 6]);

        // Game 5: two 50s segments. Floor per segment = 0 + 0 = 0; flooring
        // the raw sum (100s ≈ 1.67 min) would wrongly give 1.
        yield* insertSession(db, {
          id: "s-floor-zero",
          userId: timeUser.id,
          appId: 5,
          createdAt: new Date("2026-10-02T00:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-floor-zero",
          userId: timeUser.id,
          appId: 5,
          startedAt: new Date("2026-10-02T00:00:00Z"),
          endedAt: new Date("2026-10-02T00:00:50Z"),
          billable: true,
          open: false,
        });
        yield* insertSegment(db, {
          sessionId: "s-floor-zero",
          userId: timeUser.id,
          appId: 5,
          startedAt: new Date("2026-10-02T00:01:00Z"),
          endedAt: new Date("2026-10-02T00:01:50Z"),
          billable: true,
          open: false,
        });

        // Game 6: two 90s segments. Floor per segment = 1 + 1 = 2; flooring
        // the raw sum (180s = 3 min exactly) would wrongly give 3.
        yield* insertSession(db, {
          id: "s-floor-two",
          userId: timeUser.id,
          appId: 6,
          createdAt: new Date("2026-10-03T00:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-floor-two",
          userId: timeUser.id,
          appId: 6,
          startedAt: new Date("2026-10-03T00:00:00Z"),
          endedAt: new Date("2026-10-03T00:01:30Z"),
          billable: true,
          open: false,
        });
        yield* insertSegment(db, {
          sessionId: "s-floor-two",
          userId: timeUser.id,
          appId: 6,
          startedAt: new Date("2026-10-03T00:02:00Z"),
          endedAt: new Date("2026-10-03T00:03:30Z"),
          billable: true,
          open: false,
        });

        return yield* (yield* client)["time.summary"]({ month: "2026-10" });
      }),
    );

    expect(summary.totalMinutes).toBe(2);
    expect(summary.sessionCount).toBe(2);
    expect(summary.byGame).toEqual([
      { appId: 6, name: "Game 6", minutes: 2 },
      { appId: 5, name: "Game 5", minutes: 0 },
    ]);
    expect(
      summary.sessions.find((s) => s.sessionId === "s-floor-zero")?.minutes,
    ).toBe(0);
    expect(
      summary.sessions.find((s) => s.sessionId === "s-floor-two")?.minutes,
    ).toBe(2);
  });

  it("month boundary is Moscow time", async () => {
    const summary = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, timeUser.id);
        yield* insertGames(db, [1]);

        // 2026-10-31T21:30:00Z = 2026-11-01T00:30 МСК — уже ноябрь.
        yield* insertSession(db, {
          id: "s-nov",
          userId: timeUser.id,
          appId: 1,
          createdAt: new Date("2026-10-31T21:30:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-nov",
          userId: timeUser.id,
          appId: 1,
          startedAt: new Date("2026-10-31T21:30:00Z"),
          endedAt: new Date("2026-10-31T22:00:00Z"),
          billable: true,
          open: false,
        });

        return yield* (yield* client)["time.summary"]({ month: "2026-10" });
      }),
    );

    expect(summary.totalMinutes).toBe(0);
    expect(summary.sessionCount).toBe(0);
    expect(summary.byGame).toEqual([]);
    expect(summary.sessions).toEqual([]);
  });

  it("empty month and future month give zeros", async () => {
    const summary = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, timeUser.id);
        return yield* (yield* client)["time.summary"]({ month: "2030-01" });
      }),
    );

    expect(summary).toEqual({
      month: "2030-01",
      totalMinutes: 0,
      sessionCount: 0,
      byGame: [],
      sessions: [],
    });
  });

  it("another user's segments are not counted", async () => {
    const summary = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, timeUser.id);
        yield* insertUser(db, "u-other");
        yield* insertGames(db, [1]);

        yield* insertSession(db, {
          id: "s-other",
          userId: "u-other",
          appId: 1,
          createdAt: new Date("2026-10-05T10:00:00Z"),
        });
        yield* insertSegment(db, {
          sessionId: "s-other",
          userId: "u-other",
          appId: 1,
          startedAt: new Date("2026-10-05T10:00:00Z"),
          endedAt: new Date("2026-10-05T10:30:00Z"),
          billable: true,
          open: false,
        });

        return yield* (yield* client)["time.summary"]({ month: "2026-10" });
      }),
    );

    expect(summary.totalMinutes).toBe(0);
    expect(summary.sessionCount).toBe(0);
    expect(summary.sessions).toEqual([]);
  });
});
