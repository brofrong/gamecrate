// RPC `session.*` на временной БД: запуск, наблюдение, heartbeat, остановка, игровое время.
import { describe, expect, it } from "bun:test";
import {
  Db,
  games,
  playSegments,
  sessions,
  settings,
  user,
  userGames,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  type CurrentUserShape,
  SessionRpcs,
  type SessionView,
  sessionSettingsKey,
} from "@cg/rpc";
import { eq } from "drizzle-orm";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  type Scope,
  Stream,
} from "effect";
import { RpcTest } from "effect/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { SessionEvents } from "../src/session/SessionEvents";
import { SessionRpcHandlers } from "../src/session/rpc";

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

const env = Layer.mergeAll(SessionRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provide(SessionEvents.layer),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => {
  auth.current = alice;
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const client = RpcTest.makeClient(SessionRpcs);

/** alice владеет Hades (10); Celeste (20) есть в каталоге, но не у неё; у bob — Hades. */
const seed = Effect.gen(function* () {
  const db = yield* Db;
  yield* db.insert(user).values(
    [alice, bob].map((u) => ({
      id: u.id,
      name: u.name,
      email: `${u.id}@example.test`,
    })),
  );
  yield* db.insert(games).values([
    { appId: 10, name: "Hades" },
    { appId: 20, name: "Celeste" },
  ]);
  yield* db.insert(userGames).values([
    { userId: alice.id, appId: 10 },
    { userId: bob.id, appId: 10 },
  ]);
});

const sessionRow = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db.select().from(sessions).where(eq(sessions.id, id));
    if (row === undefined) return yield* Effect.die(`no session ${id}`);
    return row;
  });

const setSession = (
  id: string,
  values: Partial<typeof sessions.$inferInsert>,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.update(sessions).set(values).where(eq(sessions.id, id));
  });

describe("session rpc", () => {
  it("start twice returns same session", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        // Двойной клик: два одновременных вызова.
        const [a, b] = yield* Effect.all(
          [
            rpc["session.start"]({ appId: 10 }),
            rpc["session.start"]({ appId: 10 }),
          ],
          { concurrency: "unbounded" },
        );
        // Вторая вкладка позже — та же сессия.
        const c = yield* rpc["session.start"]({ appId: 10 });
        const active = yield* rpc["session.active"]();
        const db = yield* Db;
        const rows = yield* db.select().from(sessions);
        return { a, b, c, active, rows };
      }),
    );
    expect(result.b.id).toBe(result.a.id);
    expect(result.c.id).toBe(result.a.id);
    expect(result.active?.id).toBe(result.a.id);
    expect(result.rows).toHaveLength(1);
    expect(result.a).toMatchObject({
      appId: 10,
      gameName: "Hades",
      state: "queued",
      streamReady: false,
      failReason: null,
      idleDeadline: null,
      playedSeconds: 0,
    });
    expect(typeof result.a.createdAt).toBe("string");
  });

  it("start for a game not in library fails GameNotOwned", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const notOwned = yield* Effect.flip(
          rpc["session.start"]({ appId: 20 }),
        );
        const unknown = yield* Effect.flip(
          rpc["session.start"]({ appId: 999 }),
        );
        const active = yield* rpc["session.active"]();
        return { notOwned, unknown, active };
      }),
    );
    expect(result.notOwned._tag).toBe("GameNotOwned");
    expect(result.unknown._tag).toBe("GameNotOwned");
    expect(result.active).toBeNull();
  });

  it("start after the previous session ended creates a new one", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const first = yield* rpc["session.start"]({ appId: 10 });
        yield* setSession(first.id, { state: "ended", endedAt: new Date() });
        const activeAfterEnd = yield* rpc["session.active"]();
        const second = yield* rpc["session.start"]({ appId: 10 });
        return { first, activeAfterEnd, second };
      }),
    );
    expect(result.activeAfterEnd).toBeNull();
    expect(result.second.id).not.toBe(result.first.id);
  });

  it("watch emits current view then each change", async () => {
    const views = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const first = yield* Deferred.make<void>();
        const fiber = yield* rpc["session.watch"]({ sessionId: id }).pipe(
          Stream.tap(() => Deferred.succeed(first, undefined)),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(first);
        yield* setSession(id, { state: "starting", stateSince: new Date() });
        yield* Effect.sleep("300 millis");
        yield* setSession(id, { streamUrl: "http://cg-session-x:8080" });
        yield* Effect.sleep("300 millis");
        yield* setSession(id, {
          state: "failed",
          failReason: "Сервер с игрой перестал отвечать",
          endedAt: new Date(),
        });
        // Поток сам завершается после терминального состояния.
        return yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"));
      }),
    );
    const list: ReadonlyArray<SessionView> = Array.from(views);
    expect(list.map((v) => [v.state, v.streamReady])).toEqual([
      ["queued", false],
      ["starting", false],
      ["starting", true],
      ["failed", true],
    ]);
    expect(list.at(-1)?.failReason).toBe("Сервер с игрой перестал отвечать");
  });

  it("watch of an ended session emits it once and completes", async () => {
    const views = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        yield* setSession(id, { state: "ended", endedAt: new Date() });
        return yield* rpc["session.watch"]({ sessionId: id }).pipe(
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
      }),
    );
    expect(Array.from(views).map((v) => v.state)).toEqual(["ended"]);
  });

  it("watch of someone else's session fails SessionNotFound", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        auth.current = bob;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        auth.current = alice;
        const foreign = yield* rpc["session.watch"]({ sessionId: id }).pipe(
          Stream.runCollect,
          Effect.flip,
        );
        const missing = yield* rpc["session.watch"]({
          sessionId: "no-such-session",
        }).pipe(Stream.runCollect, Effect.flip);
        const heartbeat = yield* Effect.flip(
          rpc["session.heartbeat"]({ sessionId: id, inputAgeMs: 0 }),
        );
        const stop = yield* Effect.flip(rpc["session.stop"]({ sessionId: id }));
        const row = yield* sessionRow(id);
        return { foreign, missing, heartbeat, stop, row };
      }),
    );
    expect(result.foreign._tag).toBe("SessionNotFound");
    expect(result.missing._tag).toBe("SessionNotFound");
    expect(result.heartbeat._tag).toBe("SessionNotFound");
    expect(result.stop._tag).toBe("SessionNotFound");
    expect(result.row.clientSeenAt).toBeNull();
    expect(result.row.stopRequestedAt).toBeNull();
  });

  it("heartbeat updates clientSeenAt and clamps future lastInputAt", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });

        // Возраст ввода больше суток — считается сутками.
        const t0 = Date.now();
        yield* rpc["session.heartbeat"]({
          sessionId: id,
          inputAgeMs: 10 * 24 * 60 * 60 * 1000,
        });
        const huge = yield* sessionRow(id);

        // Свежий ввод: lastInputAt = now - 5 s, clientSeenAt = now.
        const t1 = Date.now();
        yield* rpc["session.heartbeat"]({ sessionId: id, inputAgeMs: 5000 });
        const fresh = yield* sessionRow(id);
        const t1end = Date.now();

        // Другая вкладка без ввода: lastInputAt не уезжает назад.
        yield* rpc["session.heartbeat"]({
          sessionId: id,
          inputAgeMs: 60 * 60 * 1000,
        });
        const stale = yield* sessionRow(id);

        // Отрицательный возраст (ввод «в будущем») отклоняется схемой.
        const negative = yield* Effect.exit(
          rpc["session.heartbeat"]({ sessionId: id, inputAgeMs: -1000 }),
        );
        const afterNegative = yield* sessionRow(id);

        // Завершённая сессия — heartbeat не принимается.
        yield* setSession(id, { state: "ended", endedAt: new Date() });
        const ended = yield* Effect.flip(
          rpc["session.heartbeat"]({ sessionId: id, inputAgeMs: 0 }),
        );
        return {
          t0,
          t1,
          t1end,
          huge,
          fresh,
          stale,
          negative,
          afterNegative,
          ended,
        };
      }),
    );
    const day = 24 * 60 * 60 * 1000;
    const hugeInput = result.huge.lastInputAt?.getTime() ?? 0;
    expect(hugeInput).toBeGreaterThanOrEqual(result.t0 - day - 50);
    expect(hugeInput).toBeLessThanOrEqual(result.t0 - day + 2000);

    const seen = result.fresh.clientSeenAt?.getTime() ?? 0;
    expect(seen).toBeGreaterThanOrEqual(result.t1 - 50);
    expect(seen).toBeLessThanOrEqual(result.t1end + 50);
    expect(seen - (result.fresh.lastInputAt?.getTime() ?? 0)).toBe(5000);

    expect(result.stale.lastInputAt?.getTime()).toBe(
      result.fresh.lastInputAt?.getTime(),
    );
    expect(result.stale.clientSeenAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      seen,
    );

    expect(result.negative._tag).toBe("Failure");
    expect(result.afterNegative.lastInputAt?.getTime()).toBe(
      result.stale.lastInputAt?.getTime(),
    );
    expect(result.ended._tag).toBe("SessionNotFound");
  });

  it("stop writes stopRequestedAt and is a no-op for an ended session", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const before = Date.now();
        yield* rpc["session.stop"]({ sessionId: id });
        const stopped = yield* sessionRow(id);
        yield* setSession(id, { state: "ended", endedAt: new Date() });
        yield* rpc["session.stop"]({ sessionId: id });
        const ended = yield* sessionRow(id);
        return { before, stopped, ended };
      }),
    );
    expect(
      result.stopped.stopRequestedAt?.getTime() ?? 0,
    ).toBeGreaterThanOrEqual(result.before - 50);
    expect(result.ended.stopRequestedAt?.getTime()).toBe(
      result.stopped.stopRequestedAt?.getTime(),
    );
  });

  it("playedSeconds sums only billable segments", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const now = Date.now();
        const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
        const db = yield* Db;
        const base = { sessionId: id, userId: alice.id, appId: 10 };
        yield* db.insert(playSegments).values([
          // Запуск — не игровое время.
          {
            ...base,
            startedAt: at(1000),
            endedAt: at(880),
            billable: false,
            open: false,
          },
          // Закрытый игровой отрезок: 60 с.
          {
            ...base,
            startedAt: at(880),
            endedAt: at(820),
            billable: true,
            open: false,
          },
          // Отключение без возврата — не учитывается.
          {
            ...base,
            startedAt: at(820),
            endedAt: at(500),
            billable: false,
            open: false,
          },
          // Открытый игровой отрезок: считается до now (30 с), а не до endedAt.
          {
            ...base,
            startedAt: at(30),
            endedAt: at(30),
            billable: true,
            open: true,
          },
        ]);
        yield* setSession(id, { state: "playing" });
        return yield* rpc["session.watch"]({ sessionId: id }).pipe(
          Stream.take(1),
          Stream.runHead,
        );
      }),
    );
    const seconds = Option.getOrThrow(view).playedSeconds;
    expect(seconds).toBeGreaterThanOrEqual(90);
    expect(seconds).toBeLessThanOrEqual(92);
  });

  it("idleDeadline is stateSince + idleGraceMinutes in idle_warning", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        yield* db.insert(settings).values({
          key: sessionSettingsKey,
          value: {
            idleWarningMinutes: 15,
            idleGraceMinutes: 3,
            disconnectGraceMinutes: 5,
            startTimeoutMinutes: 15,
          },
        });
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const since = new Date("2026-10-17T10:00:00.000Z");
        yield* setSession(id, { state: "idle_warning", stateSince: since });
        const warning = yield* rpc["session.active"]();
        yield* setSession(id, { state: "playing", stateSince: since });
        const playing = yield* rpc["session.active"]();
        return { warning, playing };
      }),
    );
    expect(result.warning?.idleDeadline).toBe("2026-10-17T10:03:00.000Z");
    expect(result.playing?.idleDeadline).toBeNull();
  });
  it("malformed session ids are SessionNotFound without touching the db", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const ids = ["\u0000", `${id}\u0000`, id.toUpperCase(), "", "x"];
        const tags: Array<string> = [];
        for (const sessionId of ids) {
          const watch = yield* rpc["session.watch"]({ sessionId }).pipe(
            Stream.runCollect,
            Effect.flip,
          );
          const heartbeat = yield* Effect.flip(
            rpc["session.heartbeat"]({ sessionId, inputAgeMs: 0 }),
          );
          const stop = yield* Effect.flip(rpc["session.stop"]({ sessionId }));
          tags.push(watch._tag, heartbeat._tag, stop._tag);
        }
        return { tags, count: ids.length * 3, row: yield* sessionRow(id) };
      }),
    );
    expect(result.tags).toEqual(Array(result.count).fill("SessionNotFound"));
    expect(result.row.clientSeenAt).toBeNull();
    expect(result.row.stopRequestedAt).toBeNull();
  });
});
