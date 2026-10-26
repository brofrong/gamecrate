// RPC `steamLogin.*` на временной БД: старт попытки, вытеснение прежней
// активной, чтение состояния своей попытки, авторизация.
import { describe, expect, it } from "bun:test";
import { Db, steamLogins, user } from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, SteamLoginRpcs } from "@cg/rpc";
import { eq, sql } from "drizzle-orm";
import { Deferred, Effect, Fiber, Layer, Option, type Scope } from "effect";
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

  /**
   * Воспроизводит гонку двойного клика детерминированно, без надежды на
   * совпадение по времени: вручную держим открытой "первую" транзакцию
   * (взят advisory-лок по userId + вставлена незакоммиченная активная
   * строка), запускаем `steamLogin.start` вторым клиентом и проверяем, что
   * он не завершается, пока первая транзакция открыта (блокируется на
   * локе, а не на уникальном индексе) — это и есть контрэвиденс для гонки
   * из ревью. Коммитим первую — вторая должна тогда же успешно завершиться,
   * увидеть уже закоммиченную активную строку и отменить именно её.
   */
  it("a concurrent start waits for the open transaction, then cancels its row", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const db = yield* Db;
        const manualId = "manual-first-attempt";

        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        // "Первый клиент": держит advisory-лок и незакоммиченную активную
        // строку, пока мы не разрешим ему закоммититься.
        const firstFiber = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${alice.id})::bigint)`,
              );
              yield* tx
                .insert(steamLogins)
                .values({ id: manualId, userId: alice.id });
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkScoped);

        yield* Deferred.await(locked);

        // Пока первая транзакция открыта, её вставка не видна снаружи
        // (READ COMMITTED) — активных строк пока не существует для внешнего наблюдателя.
        const beforeCommit = yield* db
          .select()
          .from(steamLogins)
          .where(eq(steamLogins.userId, alice.id));
        expect(beforeCommit).toHaveLength(0);

        // "Второй клиент" — конкурентный вызов того же пользователя.
        // Должен заблокироваться на advisory-локе, а не упасть на индексе.
        const secondFiber = yield* rpc["steamLogin.start"]().pipe(
          Effect.forkScoped,
        );
        yield* Effect.sleep("200 millis");
        const secondStillRunning = secondFiber.pollUnsafe() === undefined;

        // Отпускаем первую транзакцию — только теперь она коммитится.
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(firstFiber);

        const second = yield* Fiber.join(secondFiber).pipe(
          Effect.timeout("5 seconds"),
        );
        const rows = yield* db
          .select()
          .from(steamLogins)
          .where(eq(steamLogins.userId, alice.id));
        return { secondStillRunning, second, rows };
      }),
    );
    // Второй вызов не завершился, пока первая транзакция оставалась открытой.
    expect(result.secondStillRunning).toBe(true);
    expect(result.rows).toHaveLength(2);
    const manualRow = result.rows.find((r) => r.id === "manual-first-attempt");
    const secondRow = result.rows.find((r) => r.id === result.second.attemptId);
    expect(manualRow?.state).toBe("cancelled");
    expect(secondRow?.state).toBe("pending");
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
