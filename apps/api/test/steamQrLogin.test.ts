// RPC `steamLogin.*` на временной БД: старт попытки, вытеснение прежней
// активной, чтение состояния своей попытки, авторизация.
import { describe, expect, it } from "bun:test";
import { Db, steamLogins, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, SteamLoginRpcs } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { SteamLoginRpcHandlers } from "../src/steamLogin/rpc";

const player = (id: string): CurrentUserShape => ({
  id,
  name: id,
  image: null,
  role: "player",
  steamId: null,
  email: null,
  emailVerified: false,
});
const alice = player("u-alice");
const bob = player("u-bob");

/** Better Auth-заглушка: пользователь сессии — `auth.current` на момент вызова. */
const auth = { current: alice as CurrentUserShape | null };
const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.sync(() => Option.fromNullishOr(auth.current)),
});

const env = Layer.mergeAll(SteamLoginRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => {
  auth.current = alice;
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const client = RpcTest.makeClient(SteamLoginRpcs);

const seed = Effect.gen(function* () {
  const db = yield* Db;
  yield* db.insert(user).values(
    [alice, bob].map((u) => ({
      id: u.id,
      name: u.name,
      email: `${u.id}@example.test`,
    })),
  );
});

const loginRow = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select()
      .from(steamLogins)
      .where(eq(steamLogins.id, id));
    if (row === undefined) return yield* Effect.die(`no steam login ${id}`);
    return row;
  });

const setLoginRow = (
  id: string,
  values: Partial<typeof steamLogins.$inferInsert>,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.update(steamLogins).set(values).where(eq(steamLogins.id, id));
  });

describe("steamLogin rpc", () => {
  it("start cancels the previous active attempt", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const first = yield* rpc["steamLogin.start"]();
        const second = yield* rpc["steamLogin.start"]();
        const firstRow = yield* loginRow(first.attemptId);
        const secondRow = yield* loginRow(second.attemptId);
        const firstStatus = yield* rpc["steamLogin.status"]({
          attemptId: first.attemptId,
        });
        return { first, second, firstRow, secondRow, firstStatus };
      }),
    );
    expect(result.second.attemptId).not.toBe(result.first.attemptId);
    expect(result.firstRow.state).toBe("cancelled");
    expect(result.secondRow.state).toBe("pending");
    // Старая вкладка видит «истекло», а не «сбой» — отдельная причина не нужна.
    expect(result.firstStatus).toEqual({
      attemptId: result.first.attemptId,
      status: "expired",
      qrUrl: null,
      reason: null,
    });
  });

  it("concurrent starts do not crash on the active-attempt unique index", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        // Двойной клик: два одновременных вызова того же пользователя.
        const [a, b] = yield* Effect.all(
          [rpc["steamLogin.start"](), rpc["steamLogin.start"]()],
          { concurrency: "unbounded" },
        );
        const db = yield* Db;
        const rows = yield* db
          .select()
          .from(steamLogins)
          .where(eq(steamLogins.userId, alice.id));
        return { a, b, rows };
      }),
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.filter((r) => r.state === "pending")).toHaveLength(1);
    expect(result.rows.filter((r) => r.state === "cancelled")).toHaveLength(
      1,
    );
  });

  it("status of another user's attempt is SteamLoginNotFound", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        auth.current = bob;
        const { attemptId } = yield* rpc["steamLogin.start"]();
        auth.current = alice;
        const foreign = yield* Effect.flip(
          rpc["steamLogin.status"]({ attemptId }),
        );
        const missing = yield* Effect.flip(
          rpc["steamLogin.status"]({ attemptId: "no-such-attempt" }),
        );
        return { foreign, missing };
      }),
    );
    expect(result.foreign._tag).toBe("SteamLoginNotFound");
    expect(result.missing._tag).toBe("SteamLoginNotFound");
  });

  it("pending maps to waiting without qrUrl", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { attemptId } = yield* rpc["steamLogin.start"]();
        const row = yield* loginRow(attemptId);
        const status = yield* rpc["steamLogin.status"]({ attemptId });
        return { row, status };
      }),
    );
    expect(result.row.state).toBe("pending");
    expect(result.status).toEqual({
      attemptId: result.row.id,
      status: "waiting",
      qrUrl: null,
      reason: null,
    });
  });

  it("waiting carries the qrUrl through", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { attemptId } = yield* rpc["steamLogin.start"]();
        yield* setLoginRow(attemptId, {
          state: "waiting",
          qrUrl: "https://s.team/q/1/abcdef",
        });
        return yield* rpc["steamLogin.status"]({ attemptId });
      }),
    );
    expect(result).toEqual({
      attemptId: result.attemptId,
      status: "waiting",
      qrUrl: "https://s.team/q/1/abcdef",
      reason: null,
    });
  });

  it("failed carries the reason", async () => {
    const reason = "Steam не ответил, попробуйте ещё раз";
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { attemptId } = yield* rpc["steamLogin.start"]();
        yield* setLoginRow(attemptId, { state: "failed", error: reason });
        return yield* rpc["steamLogin.status"]({ attemptId });
      }),
    );
    expect(result).toEqual({
      attemptId: result.attemptId,
      status: "failed",
      qrUrl: null,
      reason,
    });
  });

  it("done has no reason", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { attemptId } = yield* rpc["steamLogin.start"]();
        yield* setLoginRow(attemptId, { state: "done" });
        return yield* rpc["steamLogin.status"]({ attemptId });
      }),
    );
    expect(result).toEqual({
      attemptId: result.attemptId,
      status: "done",
      qrUrl: null,
      reason: null,
    });
  });

  it("steamLogin RPCs require a session", async () => {
    const result = await run(
      Effect.gen(function* () {
        auth.current = null;
        const rpc = yield* client;
        const start = yield* Effect.flip(rpc["steamLogin.start"]());
        const status = yield* Effect.flip(
          rpc["steamLogin.status"]({ attemptId: "whatever" }),
        );
        return { start, status };
      }),
    );
    expect(result.start._tag).toBe("Unauthorized");
    expect(result.status._tag).toBe("Unauthorized");
  });
});
