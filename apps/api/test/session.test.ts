// RPC `session.*` на временной БД: запуск, наблюдение, heartbeat, остановка, игровое время.
import { describe, expect, it } from "bun:test";
import {
  Db,
  games,
  installJobs,
  installStageMarks,
  playSegments,
  sessionStageMarks,
  sessions,
  settings,
  tariffGrants,
  tariffs,
  user,
  userGames,
  workerClasses,
  workers,
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
import { SessionRpcHandlers, sameView } from "../src/session/rpc";
import * as StageNorms from "../src/session/StageNorms";

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
  // Нормы этапов кэшируются в памяти по appId, а БД у каждого теста своя.
  StageNorms.clearCache();
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const client = RpcTest.makeClient(SessionRpcs);

/**
 * alice владеет Hades (10); Celeste (20) есть в каталоге, но не у неё; у bob —
 * Hades. Воркер `w1` недавно на связи и с классом — у Hades и Celeste нет
 * строки в `game_requirements`, так что ей годится любой подключённый
 * воркер с классом (§2.3); без него `session.start` вернул бы `NoServer`.
 */
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
  // Миграция уже завела класс «Стандарт» (rank 1) — переиспользуем его.
  const [cls] = yield* db.select().from(workerClasses);
  yield* db.insert(workers).values({
    id: "w1",
    publicIp: "203.0.113.1",
    slots: 1,
    roles: ["worker"],
    classId: cls!.id,
    lastSeenAt: new Date(),
    // Клиент Steam собран — без него Steam-игры недоступны (спека 2026-11-09 §5).
    versions: {
      agentCommit: "test",
      sessionImage: "cg-session:test",
      driver: null,
      steamClientBuiltAt: "2026-11-01T00:00:00.000Z",
    },
  });
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

  it("start for a blocked user fails with AccessDenied", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        yield* db
          .update(user)
          .set({ blockedAt: new Date() })
          .where(eq(user.id, alice.id));
        const rpc = yield* client;
        const denied = yield* Effect.flip(rpc["session.start"]({ appId: 10 }));
        const active = yield* rpc["session.active"]();
        const rows = yield* db.select().from(sessions);
        return { denied, active, rows };
      }),
    );
    expect(result.denied._tag).toBe("AccessDenied");
    expect(result.active).toBeNull();
    expect(result.rows).toHaveLength(0);
  });

  it("session.start fails with NoServer and inserts nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        // Единственный воркер уходит на обслуживание — Hades больше никому не годится.
        yield* db
          .update(workers)
          .set({ draining: true })
          .where(eq(workers.id, "w1"));
        const rpc = yield* client;
        const noServer = yield* Effect.flip(
          rpc["session.start"]({ appId: 10 }),
        );
        const rows = yield* db.select().from(sessions);
        return { noServer, rows };
      }),
    );
    expect(result.noServer._tag).toBe("NoServer");
    expect(result.rows).toHaveLength(0);
  });

  it("active session is returned even if game became unavailable", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        const rpc = yield* client;
        const first = yield* rpc["session.start"]({ appId: 10 });
        // Воркер, на котором держалась Hades, уходит на обслуживание уже после запуска.
        yield* db
          .update(workers)
          .set({ draining: true })
          .where(eq(workers.id, "w1"));
        const second = yield* rpc["session.start"]({ appId: 10 });
        return { first, second };
      }),
    );
    expect(result.second.id).toBe(result.first.id);
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

  it("previousPlayedAt — конец последнего отрезка в других сессиях пользователя", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const first = yield* rpc["session.start"]({ appId: 10 });
        const firstView = first.previousPlayedAt;
        const now = Date.now();
        const daysAgo = (days: number) => new Date(now - days * 86_400_000);
        const db = yield* Db;
        const old = { sessionId: first.id, appId: 10, open: false };
        yield* db.insert(playSegments).values([
          // Прошлая сессия alice: позже всего — 20 дней назад (не важно, оплачиваемый ли).
          {
            ...old,
            userId: alice.id,
            startedAt: daysAgo(21),
            endedAt: daysAgo(20),
            billable: true,
          },
          {
            ...old,
            userId: alice.id,
            startedAt: daysAgo(20),
            endedAt: daysAgo(20 - 0.01),
            billable: false,
          },
          // Чужие отрезки не считаются.
          {
            ...old,
            userId: bob.id,
            startedAt: daysAgo(2),
            endedAt: daysAgo(1),
            billable: true,
          },
        ]);
        yield* setSession(first.id, { state: "ended", endedAt: new Date() });
        const second = yield* rpc["session.start"]({ appId: 10 });
        // Отрезок текущей сессии — тоже не «прошлая игра».
        yield* db.insert(playSegments).values({
          sessionId: second.id,
          userId: alice.id,
          appId: 10,
          startedAt: new Date(now - 60_000),
          endedAt: new Date(now),
          billable: true,
          open: true,
        });
        const view = yield* rpc["session.watch"]({ sessionId: second.id }).pipe(
          Stream.take(1),
          Stream.runHead,
        );
        return {
          firstView,
          expected: daysAgo(20 - 0.01).toISOString(),
          second: Option.getOrThrow(view).previousPlayedAt,
        };
      }),
    );
    expect(result.firstView).toBeNull();
    expect(result.second).toBe(result.expected);
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
            installTimeoutMinutes: 180,
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

  it("session view reports installPercent 34 for 34 of 100 bytes", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const db = yield* Db;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const jobId = crypto.randomUUID();
        yield* db.insert(installJobs).values({
          id: jobId,
          appId: 10,
          userId: alice.id,
          state: "running",
          bytesDownloaded: 34,
          bytesTotal: 100,
        });
        yield* setSession(id, { state: "installing", installJobId: jobId });
        const installing = yield* rpc["session.active"]();
        // bytesTotal неизвестен (ещё не пришёл от Steam) — 0, не деление на 0.
        yield* db
          .update(installJobs)
          .set({ bytesDownloaded: null, bytesTotal: null })
          .where(eq(installJobs.id, jobId));
        const unknownTotal = yield* rpc["session.active"]();
        // Steam иногда докачивает больше заявленного (зависимости) — не больше 100.
        yield* db
          .update(installJobs)
          .set({ bytesDownloaded: 150, bytesTotal: 100 })
          .where(eq(installJobs.id, jobId));
        const overshoot = yield* rpc["session.active"]();
        return { installing, unknownTotal, overshoot };
      }),
    );
    expect(result.installing?.installPercent).toBe(34);
    expect(result.unknownTotal?.installPercent).toBe(0);
    expect(result.overshoot?.installPercent).toBe(100);
  });

  it("installPercent is null outside installing", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const db = yield* Db;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const queued = yield* rpc["session.active"]();
        const jobId = crypto.randomUUID();
        yield* db.insert(installJobs).values({
          id: jobId,
          appId: 10,
          userId: alice.id,
          state: "done",
          bytesDownloaded: 100,
          bytesTotal: 100,
        });
        // Задача установки уже отмечена на сессии, но сессия перешла дальше —
        // installJobId не очищается (история), а installPercent — только в installing.
        yield* setSession(id, { state: "starting", installJobId: jobId });
        const starting = yield* rpc["session.active"]();
        return { queued, starting };
      }),
    );
    expect(result.queued?.installPercent).toBeNull();
    expect(result.starting?.installPercent).toBeNull();
  });

  it("view carries stage, install stage only while installing, and hadInstall", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const db = yield* Db;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const jobId = crypto.randomUUID();
        yield* db.insert(installJobs).values({
          id: jobId,
          appId: 10,
          userId: alice.id,
          state: "running",
          stage: "downloading",
        });
        yield* setSession(id, { state: "installing", installJobId: jobId });
        const installing = yield* rpc["session.active"]();

        // Задача завершена и сессия пошла дальше: installStage уже не её, а
        // stage запуска идёт своим чередом (installJobId остаётся — история).
        yield* db
          .update(installJobs)
          .set({ state: "done" })
          .where(eq(installJobs.id, jobId));
        yield* setSession(id, { state: "starting", stage: "login" });
        const starting = yield* rpc["session.active"]();

        return { installing, starting };
      }),
    );
    expect(result.installing).toMatchObject({
      stage: null,
      installStage: "downloading",
      hadInstall: true,
    });
    expect(result.starting).toMatchObject({
      stage: "login",
      installStage: null,
      hadInstall: true,
    });
  });

  it("watch view carries timing with server marks", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        // 5 прошлых запусков Hades: `computer` 8 с, `steam` 20 с, всего 90 с.
        const past = Date.parse("2026-10-20T10:00:00.000Z");
        for (let i = 0; i < 5; i++) {
          const pastId = crypto.randomUUID();
          const start = past + i * 3_600_000;
          yield* db.insert(sessions).values({
            id: pastId,
            userId: bob.id,
            appId: 10,
            state: "ended",
          });
          yield* db.insert(sessionStageMarks).values(
            (
              [
                ["computer", 0],
                ["steam", 8],
                ["login", 28],
                ["visible", 90],
              ] as const
            ).map(([stage, seconds]) => ({
              sessionId: pastId,
              stage,
              at: new Date(start + seconds * 1000),
            })),
          );
        }
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const t0 = new Date("2026-10-29T10:00:00.000Z");
        const t1 = new Date("2026-10-29T10:00:07.000Z");
        yield* db.insert(sessionStageMarks).values([
          { sessionId: id, stage: "computer", at: t0 },
          { sessionId: id, stage: "steam", at: t1 },
        ]);
        yield* setSession(id, { state: "starting", stage: "steam" });
        const before = Date.now();
        const view = yield* rpc["session.watch"]({ sessionId: id }).pipe(
          Stream.runHead,
        );
        const after = Date.now();

        // Установка: отметки задачи видны только пока сессия в `installing`.
        const { id: otherId } = yield* Effect.gen(function* () {
          auth.current = bob;
          const started = yield* rpc["session.start"]({ appId: 10 });
          auth.current = alice;
          return started;
        });
        const jobId = crypto.randomUUID();
        yield* db.insert(installJobs).values({
          id: jobId,
          appId: 10,
          userId: bob.id,
          state: "running",
          stage: "downloading",
        });
        yield* db.insert(installStageMarks).values([
          { jobId, stage: "preparing", at: t0 },
          { jobId, stage: "downloading", at: t1 },
        ]);
        yield* setSession(otherId, {
          state: "installing",
          installJobId: jobId,
        });
        auth.current = bob;
        const installing = yield* rpc["session.active"]();
        yield* setSession(otherId, { state: "starting" });
        const afterInstall = yield* rpc["session.active"]();
        return {
          view: Option.getOrThrow(view),
          before,
          after,
          installing,
          afterInstall,
        };
      }),
    );
    const timing = result.view.timing;
    if (timing === null) throw new Error("timing is null");
    const serverNow = Date.parse(timing.serverNow);
    expect(serverNow).toBeGreaterThanOrEqual(result.before - 50);
    expect(serverNow).toBeLessThanOrEqual(result.after + 50);
    expect(timing.launch).toEqual([
      {
        stage: "computer",
        startedAt: "2026-10-29T10:00:00.000Z",
        endedAt: "2026-10-29T10:00:07.000Z",
        normMs: 8_000,
      },
      {
        stage: "steam",
        startedAt: "2026-10-29T10:00:07.000Z",
        endedAt: null,
        normMs: 20_000,
      },
    ]);
    expect(timing.install).toEqual([]);
    expect(timing.launchNormMs).toBe(90_000);

    expect(result.installing?.timing?.install).toEqual([
      {
        stage: "preparing",
        startedAt: "2026-10-29T10:00:00.000Z",
        endedAt: "2026-10-29T10:00:07.000Z",
        normMs: null,
      },
      {
        stage: "downloading",
        startedAt: "2026-10-29T10:00:07.000Z",
        endedAt: null,
        normMs: null,
      },
    ]);
    expect(result.installing?.timing?.launch).toEqual([]);
    expect(result.afterInstall?.timing?.install).toEqual([]);
  });

  it("timing is null after visible", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const queued = yield* rpc["session.active"]();
        yield* db.insert(sessionStageMarks).values([
          { sessionId: id, stage: "computer", at: new Date(Date.now() - 9000) },
          { sessionId: id, stage: "visible", at: new Date() },
        ]);
        yield* setSession(id, { state: "playing", stage: "visible" });
        const visible = yield* rpc["session.active"]();
        yield* setSession(id, { stage: "loading" });
        yield* setSession(id, { state: "failed", endedAt: new Date() });
        const failed = yield* rpc["session.watch"]({ sessionId: id }).pipe(
          Stream.runHead,
        );
        return { queued, visible, failed: Option.getOrThrow(failed) };
      }),
    );
    // В очереди — экран загрузки, но отметок ещё нет.
    expect(result.queued?.timing).toMatchObject({
      launch: [],
      install: [],
      launchNormMs: null,
    });
    expect(result.visible?.timing).toBeNull();
    expect(result.failed.timing).toBeNull();
  });

  it("sameView ignores serverNow", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        yield* db.insert(sessionStageMarks).values({
          sessionId: id,
          stage: "computer",
          at: new Date(),
        });
        yield* setSession(id, { state: "starting", stage: "computer" });
        return yield* rpc["session.active"]();
      }),
    );
    if (view === null || view.timing === null) throw new Error("no timing");
    const later = {
      ...view,
      timing: { ...view.timing, serverNow: new Date().toISOString() + "x" },
    };
    expect(sameView(view, later)).toBe(true);
    // Остальное в timing по-прежнему считается изменением.
    const ended = {
      ...view,
      timing: {
        ...view.timing,
        launch: view.timing.launch.map((mark) => ({
          ...mark,
          endedAt: view.timing?.serverNow ?? null,
        })),
      },
    };
    expect(sameView(view, ended)).toBe(false);
    expect(sameView({ ...view, timing: null }, { ...view, timing: null })).toBe(
      true,
    );
    expect(sameView(view, { ...view, timing: null })).toBe(false);
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

/** Выдать alice тариф `tariffId` с момента `startsAt` (без конца). */
const grantTariff = (tariffId: string, startsAt: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(tariffGrants).values({
      id: crypto.randomUUID(),
      userId: alice.id,
      tariffId,
      startsAt,
      endsAt: null,
    });
  });

describe("session.start и тариф", () => {
  it("fails with NoMinutes when the current tariff's minutes are used up", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        yield* db.insert(tariffs).values({
          id: "t-limited",
          name: "Лимит",
          monthlyMinutes: 1,
          maxResolution: "1080p",
          maxBitrateMbps: 20,
        });
        const grantedAt = new Date(Date.now() - 120_000);
        yield* grantTariff("t-limited", grantedAt);
        // Прежняя (уже завершённая) сессия: 90 с billable-времени — больше
        // лимита в 1 минуту, остаток уходит в долг.
        const oldId = crypto.randomUUID();
        yield* db
          .insert(sessions)
          .values({ id: oldId, userId: alice.id, appId: 10, state: "ended" });
        yield* db.insert(playSegments).values({
          sessionId: oldId,
          userId: alice.id,
          appId: 10,
          startedAt: new Date(Date.now() - 100_000),
          endedAt: new Date(Date.now() - 10_000),
          billable: true,
          open: false,
        });
        const rpc = yield* client;
        const noMinutes = yield* Effect.flip(
          rpc["session.start"]({ appId: 10 }),
        );
        const rows = yield* db
          .select()
          .from(sessions)
          .where(eq(sessions.state, "queued"));
        return { noMinutes, rows };
      }),
    );
    expect(result.noMinutes._tag).toBe("NoMinutes");
    expect(result.rows).toHaveLength(0);
  });

  it("returns the existing active session even with zero minutes", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        const rpc = yield* client;
        const first = yield* rpc["session.start"]({ appId: 10 });
        yield* db.insert(tariffs).values({
          id: "t-limited",
          name: "Лимит",
          monthlyMinutes: 1,
          maxResolution: "1080p",
          maxBitrateMbps: 20,
        });
        yield* grantTariff("t-limited", new Date(Date.now() - 120_000));
        yield* db.insert(playSegments).values({
          sessionId: first.id,
          userId: alice.id,
          appId: 10,
          startedAt: new Date(Date.now() - 100_000),
          endedAt: new Date(Date.now() - 10_000),
          billable: true,
          open: false,
        });
        const second = yield* rpc["session.start"]({ appId: 10 });
        return { first, second };
      }),
    );
    expect(result.second.id).toBe(result.first.id);
  });

  it("stores queue_priority of the current tariff", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        yield* db.insert(tariffs).values({
          id: "t-plus",
          name: "Плюс",
          queuePriority: 42,
          maxResolution: "1080p",
          maxBitrateMbps: 20,
        });
        yield* grantTariff("t-plus", new Date(Date.now() - 60_000));
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        return yield* sessionRow(id);
      }),
    );
    expect(result.queuePriority).toBe(42);
  });
});

describe("session.heartbeat queueOnly", () => {
  it("updates clientSeenAt of a queued session without touching lastInputAt", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        const before = Date.now();
        yield* rpc["session.heartbeat"]({
          sessionId: id,
          inputAgeMs: 0,
          queueOnly: true,
        });
        return { before, row: yield* sessionRow(id) };
      }),
    );
    expect(result.row.clientSeenAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      result.before - 50,
    );
    expect(result.row.lastInputAt).toBeNull();
  });

  it("does not touch a playing session", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        yield* setSession(id, { state: "playing" });
        yield* rpc["session.heartbeat"]({ sessionId: id, inputAgeMs: 0 });
        const before = yield* sessionRow(id);
        yield* rpc["session.heartbeat"]({
          sessionId: id,
          inputAgeMs: 0,
          queueOnly: true,
        });
        const after = yield* sessionRow(id);
        return { before, after };
      }),
    );
    expect(result.after.clientSeenAt?.getTime()).toBe(
      result.before.clientSeenAt?.getTime(),
    );
  });
});

describe("SessionView.queue и SessionView.limit", () => {
  it("queue carries position/total/etaMinutes from columns only while queued", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        yield* setSession(id, {
          queuePosition: 2,
          queueTotal: 5,
          queueEtaMinutes: 10,
        });
        const queued = yield* rpc["session.active"]();
        yield* setSession(id, { state: "starting", stage: "computer" });
        const starting = yield* rpc["session.active"]();
        return { queued, starting };
      }),
    );
    expect(result.queued?.queue).toEqual({
      position: 2,
      total: 5,
      etaMinutes: 10,
    });
    expect(result.starting?.queue).toBeNull();
  });

  it("limit carries a deadline while playing/idle_warning with a limited tariff, null otherwise", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const db = yield* Db;
        yield* db.insert(tariffs).values({
          id: "t-limited",
          name: "Лимит",
          monthlyMinutes: 60,
          maxResolution: "1080p",
          maxBitrateMbps: 20,
        });
        yield* grantTariff("t-limited", new Date(Date.now() - 60_000));
        const rpc = yield* client;
        const { id } = yield* rpc["session.start"]({ appId: 10 });
        yield* setSession(id, { state: "playing" });
        const before = Date.now();
        const playing = yield* rpc["session.active"]();
        const after = Date.now();
        yield* setSession(id, { state: "idle_warning" });
        const idleWarning = yield* rpc["session.active"]();
        yield* setSession(id, { state: "starting" });
        const starting = yield* rpc["session.active"]();
        return { playing, idleWarning, starting, before, after };
      }),
    );
    expect(result.playing?.limit?.reason).toBe("minutes");
    const deadline = Date.parse(result.playing?.limit?.deadline ?? "");
    const hour = 60 * 60_000;
    expect(deadline).toBeGreaterThanOrEqual(result.before + hour - 2000);
    expect(deadline).toBeLessThanOrEqual(result.after + hour + 2000);
    expect(result.idleWarning?.limit?.reason).toBe("minutes");
    expect(result.starting?.limit).toBeNull();
  });
});
