// RPC `admin.workers.*`/`admin.sessions.*`: воркеры с онлайном и активными
// сессиями, обслуживание, журнал сессий, остановка (по образцу settings.test.ts).
import { describe, expect, it } from "bun:test";
import {
  account,
  Db,
  games,
  sessions,
  steamLogins,
  user,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";

const admin: CurrentUserShape = {
  id: "u-admin",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};
const player: CurrentUserShape = { ...admin, id: "u-player", role: "player" };

const auth = { current: admin as CurrentUserShape | null };
const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.sync(() => Option.fromNullishOr(auth.current)),
});

const env = Layer.mergeAll(AdminRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => {
  auth.current = admin;
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const client = RpcTest.makeClient(AdminRpcs);

const insertUser = (db: Db["Service"], id: string, name = id) =>
  db.insert(user).values({ id, name, email: `${id}@example.test` });

const insertGame = (db: Db["Service"], appId: number, name: string) =>
  db.insert(games).values({ appId, name });

const insertWorker = (
  db: Db["Service"],
  values: Partial<typeof workers.$inferInsert> & { id: string },
) =>
  db.insert(workers).values({
    publicIp: "37.153.14.138",
    slots: 2,
    ...values,
  });

const insertSession = (
  db: Db["Service"],
  values: Partial<typeof sessions.$inferInsert> & {
    id: string;
    userId: string;
    appId: number;
  },
) => db.insert(sessions).values(values);

describe("admin.workers", () => {
  it("workers.list returns hardware, stats, online and active sessions", async () => {
    const now = new Date();
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1", "Alice");
        yield* insertGame(db, 570, "Dota 2");
        yield* insertWorker(db, {
          id: "online-worker",
          statsAt: new Date(now.getTime() - 5_000),
          stats: { cpuPercent: 10 } as never,
          hardware: { cpuModel: "x" } as never,
          versions: { agentCommit: "abc" } as never,
          roles: ["worker"],
        });
        yield* insertWorker(db, {
          id: "offline-worker",
          statsAt: new Date(now.getTime() - 60_000),
          stats: { cpuPercent: 5 } as never,
        });
        yield* insertWorker(db, { id: "no-stats-worker" });
        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 570,
          workerId: "online-worker",
          slot: 0,
          state: "playing",
        });

        const rpc = yield* client;
        return yield* rpc["admin.workers.list"]();
      }),
    );
    const byId = new Map(result.map((w) => [w.id, w]));
    expect(byId.get("online-worker")?.online).toBe(true);
    expect(byId.get("offline-worker")?.online).toBe(false);
    expect(byId.get("no-stats-worker")?.online).toBe(false);
    expect(byId.get("no-stats-worker")?.stats).toBeNull();
    const online = byId.get("online-worker");
    expect(online?.sessions).toHaveLength(1);
    expect(online?.sessions[0]).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      userId: "u1",
      userName: "Alice",
      appId: 570,
      gameName: "Dota 2",
      workerId: "online-worker",
      slot: 0,
      state: "playing",
    });
    expect(byId.get("offline-worker")?.sessions).toHaveLength(0);
    // Воркеры по id.
    expect(result.map((w) => w.id)).toEqual([
      "no-stats-worker",
      "offline-worker",
      "online-worker",
    ]);
  });

  it("setDraining persists and returns false for unknown worker", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertWorker(db, { id: "w1" });
        const rpc = yield* client;
        const ok = yield* rpc["admin.workers.setDraining"]({
          workerId: "w1",
          draining: true,
        });
        const [row] = yield* db
          .select({ draining: workers.draining })
          .from(workers)
          .where(eq(workers.id, "w1"));
        const unknown = yield* rpc["admin.workers.setDraining"]({
          workerId: "no-such-worker",
          draining: true,
        });
        return { ok, draining: row?.draining, unknown };
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.draining).toBe(true);
    expect(result.unknown).toBe(false);
  });
});

describe("admin.sessions", () => {
  const seedBase = (db: Db["Service"]) =>
    Effect.gen(function* () {
      yield* insertUser(db, "u1", "Alice");
      yield* insertGame(db, 570, "Dota 2");
      yield* insertWorker(db, { id: "w1" });
    });

  it("sessions.list: active, recent within 7 days, failedOnly filters", async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedBase(db);
        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 570,
          workerId: "w1",
          slot: 0,
          state: "playing",
        });
        yield* insertSession(db, {
          id: "22222222-2222-2222-2222-222222222222",
          userId: "u1",
          appId: 570,
          state: "ended",
          endedAt: new Date(now.getTime() - 2 * dayMs),
        });
        yield* insertSession(db, {
          id: "33333333-3333-3333-3333-333333333333",
          userId: "u1",
          appId: 570,
          state: "ended",
          endedAt: new Date(now.getTime() - 10 * dayMs),
        });
        yield* insertSession(db, {
          id: "44444444-4444-4444-4444-444444444444",
          userId: "u1",
          appId: 570,
          state: "failed",
          failReason: "boom",
          endedAt: new Date(now.getTime() - 3 * dayMs),
        });

        const rpc = yield* client;
        const all = yield* rpc["admin.sessions.list"]({ failedOnly: false });
        const failedOnly = yield* rpc["admin.sessions.list"]({
          failedOnly: true,
        });
        return { all, failedOnly };
      }),
    );
    expect(result.all.active.map((s) => s.id)).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
    // Новые сверху, 10-дневная сессия не попадает в окно 7 дней.
    expect(result.all.recent.map((s) => s.id)).toEqual([
      "22222222-2222-2222-2222-222222222222",
      "44444444-4444-4444-4444-444444444444",
    ]);
    const failed = result.all.recent.find(
      (s) => s.id === "44444444-4444-4444-4444-444444444444",
    );
    expect(failed?.failReason).toBe("boom");

    expect(result.failedOnly.active).toHaveLength(0);
    expect(result.failedOnly.recent.map((s) => s.id)).toEqual([
      "44444444-4444-4444-4444-444444444444",
    ]);
  });

  it("recent is capped at 50 entries", async () => {
    const now = new Date();
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedBase(db);
        for (let i = 0; i < 55; i++) {
          yield* insertSession(db, {
            id: crypto.randomUUID(),
            userId: "u1",
            appId: 570,
            state: "ended",
            endedAt: new Date(now.getTime() - i * 1000),
          });
        }
        const rpc = yield* client;
        return yield* rpc["admin.sessions.list"]({ failedOnly: false });
      }),
    );
    expect(result.recent).toHaveLength(50);
  });

  it("sessions.stop sets stop_requested_at once; ended session and unknown id are no-ops", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* seedBase(db);
        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 570,
          workerId: "w1",
          slot: 0,
          state: "playing",
        });
        yield* insertSession(db, {
          id: "22222222-2222-2222-2222-222222222222",
          userId: "u1",
          appId: 570,
          state: "ended",
        });

        const rpc = yield* client;
        const first = yield* rpc["admin.sessions.stop"]({
          sessionId: "11111111-1111-1111-1111-111111111111",
        });
        const [rowAfterFirst] = yield* db
          .select({ stopRequestedAt: sessions.stopRequestedAt })
          .from(sessions)
          .where(eq(sessions.id, "11111111-1111-1111-1111-111111111111"));
        yield* Effect.sleep("10 millis");
        const second = yield* rpc["admin.sessions.stop"]({
          sessionId: "11111111-1111-1111-1111-111111111111",
        });
        const [rowAfterSecond] = yield* db
          .select({ stopRequestedAt: sessions.stopRequestedAt })
          .from(sessions)
          .where(eq(sessions.id, "11111111-1111-1111-1111-111111111111"));

        const ended = yield* rpc["admin.sessions.stop"]({
          sessionId: "22222222-2222-2222-2222-222222222222",
        });
        const [endedRow] = yield* db
          .select({ stopRequestedAt: sessions.stopRequestedAt })
          .from(sessions)
          .where(eq(sessions.id, "22222222-2222-2222-2222-222222222222"));

        const unknown = yield* rpc["admin.sessions.stop"]({
          sessionId: "99999999-9999-9999-9999-999999999999",
        });
        const malformed = yield* rpc["admin.sessions.stop"]({
          sessionId: "not-a-uuid",
        });

        return {
          first,
          second,
          ended,
          unknown,
          malformed,
          stopRequestedAtFirst: rowAfterFirst?.stopRequestedAt,
          stopRequestedAtSecond: rowAfterSecond?.stopRequestedAt,
          endedStopRequestedAt: endedRow?.stopRequestedAt,
        };
      }),
    );
    expect(result.first).toBe(true);
    expect(result.second).toBe(true);
    expect(result.stopRequestedAtFirst).not.toBeNull();
    expect(result.stopRequestedAtSecond?.getTime()).toBe(
      result.stopRequestedAtFirst?.getTime(),
    );
    // Сессия существует (не "неверный id/нет") — true, как у requestStop,
    // но запись не меняется, раз сессия уже не активна.
    expect(result.ended).toBe(true);
    expect(result.endedStopRequestedAt).toBeNull();
    expect(result.unknown).toBe(false);
    expect(result.malformed).toBe(false);
  });
});

describe("admin.workers/sessions access", () => {
  it("player gets Forbidden on every new admin method", async () => {
    const result = await run(
      Effect.gen(function* () {
        auth.current = player;
        const rpc = yield* client;
        const workersList = yield* Effect.flip(rpc["admin.workers.list"]());
        const setDraining = yield* Effect.flip(
          rpc["admin.workers.setDraining"]({
            workerId: "w1",
            draining: true,
          }),
        );
        const sessionsList = yield* Effect.flip(
          rpc["admin.sessions.list"]({ failedOnly: false }),
        );
        const stop = yield* Effect.flip(
          rpc["admin.sessions.stop"]({ sessionId: "x" }),
        );
        return { workersList, setDraining, sessionsList, stop };
      }),
    );
    expect(result.workersList._tag).toBe("Forbidden");
    expect(result.setDraining._tag).toBe("Forbidden");
    expect(result.sessionsList._tag).toBe("Forbidden");
    expect(result.stop._tag).toBe("Forbidden");
  });

  it("admin responses never contain Steam secrets", async () => {
    const secretToken = "s3cr3t-steam-refresh-token";
    const secretAccountName = "s3cr3t-steam-account-name";
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u1", "Alice");
        yield* insertGame(db, 570, "Dota 2");
        yield* insertWorker(db, { id: "w1" });
        yield* insertSession(db, {
          id: "11111111-1111-1111-1111-111111111111",
          userId: "u1",
          appId: 570,
          workerId: "w1",
          slot: 0,
          state: "playing",
        });
        // Секреты Steam (как в steamLogin.test.ts: steam_logins + account с токеном).
        yield* db.insert(steamLogins).values({
          id: "steam-login-1",
          userId: "u1",
          qrUrl: "https://s.team/q/1/abcdef",
        });
        yield* db.insert(account).values({
          id: "acc-steam-u1",
          accountId: secretAccountName,
          providerId: "steam",
          userId: "u1",
          refreshToken: secretToken,
        });

        const rpc = yield* client;
        const workersList = yield* rpc["admin.workers.list"]();
        const sessionsList = yield* rpc["admin.sessions.list"]({
          failedOnly: false,
        });
        return { workersList, sessionsList };
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain(secretAccountName);
  });
});
