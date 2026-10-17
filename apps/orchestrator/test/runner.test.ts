import { describe, expect, it } from "bun:test";
import {
  Db,
  games,
  playSegments,
  sessions,
  settings,
  user,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  type AgentCommand,
  type AgentReport,
  type RunningSession,
  defaultSessionSettings,
  sessionSettingsKey,
} from "@cg/rpc";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer, PubSub, References, type Scope, Stream } from "effect";
import {
  AgentHub,
  type AgentHubEvent,
  type AgentHubShape,
  type WorkerInfo,
} from "../src/AgentHub";
import { failReasons } from "../src/lifecycle";
import * as Scheduler from "../src/Scheduler";
import * as SessionRepo from "../src/SessionRepo";
import { SessionRunner, lostOnRestartReason } from "../src/SessionRunner";

/** Фейковый хаб: подключённые воркеры и отправленные команды — в памяти. */
const makeFakeHub = () => {
  const infos = new Map<string, WorkerInfo>();
  const sent: Array<{ workerId: string; command: AgentCommand }> = [];
  const state = { dropSends: false };
  const events = Effect.runSync(PubSub.unbounded<AgentHubEvent>());
  const hub: AgentHubShape = {
    send: (workerId, command) =>
      Effect.sync(() => {
        if (state.dropSends || !infos.has(workerId)) return false;
        sent.push({ workerId, command });
        return true;
      }),
    connected: () => new Set(infos.keys()),
    info: (workerId) => infos.get(workerId),
    events,
    subscribe: PubSub.subscribe(events),
    connect: () => Stream.die("fake hub"),
    report: () => Effect.die("fake hub"),
  };
  return { hub, infos, sent, state };
};
type FakeHub = ReturnType<typeof makeFakeHub>;

type Env = Db | AgentHub | SessionRunner | Scope.Scope;

const run = <A, E>(body: (fake: FakeHub) => Effect.Effect<A, E, Env>) => {
  const fake = makeFakeHub();
  return Effect.runPromise(
    Effect.scoped(body(fake)).pipe(
      Effect.provideService(References.MinimumLogLevel, "Error"),
      Effect.provide(
        SessionRunner.layerWithoutLoops.pipe(
          Layer.provideMerge(Layer.succeed(AgentHub, fake.hub)),
          Layer.provideMerge(DbTest),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
        ),
      ),
    ),
  );
};

const at = (base: Date, seconds: number) =>
  new Date(base.getTime() + seconds * 1000);

/**
 * `toMatchObject` в Bun не сравнивает значения `Date` (любые две даты «совпадают»),
 * поэтому сравниваем через JSON: даты становятся ISO-строками.
 */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const like = (actual: unknown, expected: unknown) =>
  expect(json(actual)).toMatchObject(json(expected) as object);

/** Агент воркера подключён: строка `workers` (как пишет хаб) + запись в фейке. */
const connectWorker = (fake: FakeHub, workerId: string, slots: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(workers)
      .values({ id: workerId, publicIp: "203.0.113.7", slots })
      .onConflictDoNothing();
    fake.infos.set(workerId, {
      workerId,
      publicIp: "203.0.113.7",
      slots,
      udpPortBase: 59000,
    });
  });

const seedUsers = (...ids: string[]) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(games)
      .values({ appId: 570, name: "Dota 2" })
      .onConflictDoNothing();
    for (const id of ids)
      yield* db.insert(user).values({
        id,
        name: id,
        email: `${id}@steam.invalid`,
        emailVerified: false,
      });
  });

const insertSession = (values: {
  id: string;
  userId: string;
  state?: (typeof sessions.$inferInsert)["state"];
  workerId?: string;
  slot?: number;
  createdAt?: Date;
  stateSince?: Date;
  clientSeenAt?: Date;
  lastInputAt?: Date;
  agentSeenAt?: Date;
  stopRequestedAt?: Date;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(sessions).values({ appId: 570, ...values });
  });

const sessionRow = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db.select().from(sessions).where(eq(sessions.id, id));
    if (row === undefined) return yield* Effect.die(`no session ${id}`);
    return row;
  });

const segmentsOf = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select()
      .from(playSegments)
      .where(eq(playSegments.sessionId, id))
      .orderBy(asc(playSegments.id));
  });

const report = (workerId: string, agentReport: AgentReport): AgentHubEvent => ({
  _tag: "Report",
  workerId,
  report: agentReport,
});

const connected = (
  workerId: string,
  running: ReadonlyArray<RunningSession>,
): AgentHubEvent => ({
  _tag: "Connected",
  workerId,
  publicIp: "203.0.113.7",
  slots: 2,
  udpPortBase: 59000,
  running,
});

describe("scheduler", () => {
  it("queued session gets lowest free slot and StartSession with udpPort 59000+slot", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u-busy", "u1", "u2");
        // Первый по id воркер — w-a: слот 0 занят, свободен 1.
        yield* connectWorker(fake, "w-b", 1);
        yield* connectWorker(fake, "w-a", 2);
        yield* insertSession({
          id: "s-busy",
          userId: "u-busy",
          state: "playing",
          workerId: "w-a",
          slot: 0,
        });
        yield* insertSession({
          id: "s2",
          userId: "u2",
          createdAt: at(t0, -5),
        });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          createdAt: at(t0, -10),
        });

        yield* Scheduler.tick(t0);

        const s1 = yield* sessionRow("s1");
        like(s1, {
          state: "starting",
          workerId: "w-a",
          slot: 1,
          stateSince: t0,
          agentSeenAt: t0,
        });
        // w-a заполнен — следующая по очереди сессия уходит на w-b.
        const s2 = yield* sessionRow("s2");
        like(s2, {
          state: "starting",
          workerId: "w-b",
          slot: 0,
        });

        expect(fake.sent).toEqual([
          {
            workerId: "w-a",
            command: {
              _tag: "StartSession",
              sessionId: "s1",
              userId: "u1",
              appId: 570,
              slot: 1,
              udpPort: 59001,
            },
          },
          {
            workerId: "w-b",
            command: {
              _tag: "StartSession",
              sessionId: "s2",
              userId: "u2",
              appId: 570,
              slot: 0,
              udpPort: 59000,
            },
          },
        ]);
      }),
    ));

  it("no connected worker keeps session queued", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        yield* seedUsers("u1");
        // Строка воркера есть, агент не подключён.
        yield* db
          .insert(workers)
          .values({ id: "w-offline", publicIp: "203.0.113.7", slots: 1 });
        // Агент в хабе, но строки `workers` ещё нет (upsert в пути).
        fake.infos.set("w-unannounced", {
          workerId: "w-unannounced",
          publicIp: "203.0.113.7",
          slots: 1,
          udpPortBase: 59000,
        });
        yield* insertSession({ id: "s1", userId: "u1" });

        yield* Scheduler.tick(t0);
        expect((yield* sessionRow("s1")).state).toBe("queued");
        expect(fake.sent).toEqual([]);

        // Подключён, но команда не ушла (соединение оборвалось) — тоже в очереди.
        yield* connectWorker(fake, "w-flaky", 1);
        fake.state.dropSends = true;
        yield* Scheduler.tick(at(t0, 2));
        const row = yield* sessionRow("s1");
        like(row, {
          state: "queued",
          workerId: null,
          slot: null,
        });

        fake.state.dropSends = false;
        yield* Scheduler.tick(at(t0, 4));
        like(yield* sessionRow("s1"), {
          state: "starting",
          workerId: "w-flaky",
          slot: 0,
        });
      }),
    ));

  it("full worker keeps session queued until a slot frees", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        yield* seedUsers("u-busy", "u1");
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({
          id: "s-busy",
          userId: "u-busy",
          state: "playing",
          workerId: "w1",
          slot: 0,
        });
        yield* insertSession({ id: "s1", userId: "u1" });

        yield* Scheduler.tick(t0);
        expect((yield* sessionRow("s1")).state).toBe("queued");
        expect(fake.sent).toEqual([]);

        yield* db
          .update(sessions)
          .set({ state: "ended" })
          .where(eq(sessions.id, "s-busy"));
        yield* Scheduler.tick(at(t0, 2));
        like(yield* sessionRow("s1"), {
          state: "starting",
          workerId: "w1",
          slot: 0,
        });
        expect(fake.sent.map((s) => s.command._tag)).toEqual(["StartSession"]);
      }),
    ));
});

describe("session runner", () => {
  it("GameState running opens billable segment, heartbeat extends it", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({
          id: "s1",
          userId: "u1",
          state: "starting",
          workerId: "w1",
          slot: 0,
          stateSince: t0,
          agentSeenAt: t0,
        });

        yield* runner.handle(
          report("w1", {
            _tag: "StreamReady",
            sessionId: "s1",
            streamUrl: "http://cg-session-s1:8080",
          }),
          at(t0, 5),
        );
        // Игра ещё не запущена: running=false в starting ничего не меняет.
        yield* runner.handle(
          report("w1", { _tag: "GameState", sessionId: "s1", running: false }),
          at(t0, 6),
        );
        like(yield* sessionRow("s1"), {
          state: "starting",
          streamUrl: "http://cg-session-s1:8080",
        });
        expect(yield* segmentsOf("s1")).toEqual([]);

        // Отчёт чужого воркера о сессии игнорируется.
        yield* runner.handle(
          report("w-other", {
            _tag: "GameState",
            sessionId: "s1",
            running: true,
          }),
          at(t0, 8),
        );
        expect((yield* sessionRow("s1")).state).toBe("starting");

        yield* runner.handle(
          report("w1", { _tag: "GameState", sessionId: "s1", running: true }),
          at(t0, 10),
        );
        like(yield* sessionRow("s1"), {
          state: "playing",
          stateSince: at(t0, 10),
        });
        like(yield* segmentsOf("s1"), [
          {
            startedAt: at(t0, 10),
            endedAt: at(t0, 10),
            billable: true,
            open: true,
            userId: "u1",
            appId: 570,
          },
        ]);

        // Повторный running=true — без изменений.
        yield* runner.handle(
          report("w1", { _tag: "GameState", sessionId: "s1", running: true }),
          at(t0, 12),
        );
        expect(yield* segmentsOf("s1")).toHaveLength(1);
        expect((yield* sessionRow("s1")).stateSince).toEqual(at(t0, 10));

        yield* runner.handle(
          report("w1", { _tag: "Heartbeat", sessionIds: ["s1"] }),
          at(t0, 40),
        );
        expect((yield* sessionRow("s1")).agentSeenAt).toEqual(at(t0, 40));
        like(yield* segmentsOf("s1"), [
          { startedAt: at(t0, 10), endedAt: at(t0, 40), open: true },
        ]);

        // Игра закрылась: stopping, отрезок закрыт на моменте выхода.
        yield* runner.handle(
          report("w1", { _tag: "GameState", sessionId: "s1", running: false }),
          at(t0, 50),
        );
        expect((yield* sessionRow("s1")).state).toBe("stopping");
        like(yield* segmentsOf("s1"), [
          { startedAt: at(t0, 10), endedAt: at(t0, 50), open: false },
        ]);

        yield* runner.handle(
          report("w1", { _tag: "Stopped", sessionId: "s1", cloudSynced: true }),
          at(t0, 70),
        );
        like(yield* sessionRow("s1"), {
          state: "ended",
          endedAt: at(t0, 70),
        });
      }),
    ));

  it("lost agent fails session and closes segment at last heartbeat", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        const db = yield* Db;
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({
          id: "s1",
          userId: "u1",
          state: "starting",
          workerId: "w1",
          slot: 0,
          stateSince: t0,
          agentSeenAt: t0,
        });
        yield* runner.handle(
          report("w1", { _tag: "GameState", sessionId: "s1", running: true }),
          t0,
        );
        yield* runner.handle(
          report("w1", { _tag: "Heartbeat", sessionIds: ["s1"] }),
          at(t0, 10),
        );

        // Сокет оборвался: одно `Disconnected` сессию не валит.
        fake.infos.delete("w1");
        yield* runner.handle(
          { _tag: "Disconnected", workerId: "w1" },
          at(t0, 11),
        );
        // Браузер всё время на месте.
        const client = (seconds: number) =>
          db
            .update(sessions)
            .set({
              clientSeenAt: at(t0, seconds),
              lastInputAt: at(t0, seconds),
            })
            .where(eq(sessions.id, "s1"));

        yield* client(60);
        yield* runner.tick(at(t0, 65));
        expect((yield* sessionRow("s1")).state).toBe("playing");

        yield* client(100);
        yield* runner.tick(at(t0, 101));
        like(yield* sessionRow("s1"), {
          state: "failed",
          failReason: failReasons.agentLost,
          endedAt: at(t0, 101),
        });
        like(yield* segmentsOf("s1"), [
          { startedAt: t0, endedAt: at(t0, 10), billable: true, open: false },
        ]);
        // Агента нет — команд не было.
        expect(fake.sent).toEqual([]);
      }),
    ));

  it("tick applies settings changed in db", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        const db = yield* Db;
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w1", 1);

        expect(yield* SessionRepo.loadSettings()).toEqual(
          defaultSessionSettings,
        );
        yield* db.insert(settings).values({
          key: sessionSettingsKey,
          value: { idleWarningMinutes: 0 },
        });
        expect(yield* SessionRepo.loadSettings()).toEqual(
          defaultSessionSettings,
        );

        yield* insertSession({
          id: "s1",
          userId: "u1",
          state: "playing",
          workerId: "w1",
          slot: 0,
          stateSince: t0,
          lastInputAt: t0,
        });
        const live = (seconds: number) =>
          db
            .update(sessions)
            .set({
              clientSeenAt: at(t0, seconds),
              agentSeenAt: at(t0, seconds),
            })
            .where(eq(sessions.id, "s1"));

        // 3 минуты простоя при N = 15 — ещё играем.
        yield* live(180);
        yield* runner.tick(at(t0, 180));
        expect((yield* sessionRow("s1")).state).toBe("playing");

        const changed = { ...defaultSessionSettings, idleWarningMinutes: 2 };
        yield* db
          .update(settings)
          .set({ value: changed })
          .where(eq(settings.key, sessionSettingsKey));
        expect(yield* SessionRepo.loadSettings()).toEqual(changed);

        yield* live(185);
        yield* runner.tick(at(t0, 185));
        like(yield* sessionRow("s1"), {
          state: "idle_warning",
          stateSince: at(t0, 185),
        });
      }),
    ));

  it("agent reconnect without a known session fails it", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        const t0 = new Date();
        yield* seedUsers("u1", "u2", "u3", "u4");
        yield* connectWorker(fake, "w1", 3);
        yield* connectWorker(fake, "w2", 1);
        const playing = (
          id: string,
          userId: string,
          workerId: string,
          slot: number,
        ) =>
          insertSession({
            id,
            userId,
            state: "starting",
            workerId,
            slot,
            stateSince: at(t0, -60),
            agentSeenAt: at(t0, -60),
          }).pipe(
            Effect.andThen(
              runner.handle(
                report(workerId, {
                  _tag: "GameState",
                  sessionId: id,
                  running: true,
                }),
                at(t0, -30),
              ),
            ),
          );
        yield* playing("s-known", "u1", "w1", 0);
        yield* playing("s-lost", "u2", "w1", 1);
        yield* playing("s-other", "u3", "w2", 0);
        // Назначена только что: StartSession мог уйти уже в новое соединение.
        yield* insertSession({
          id: "s-new",
          userId: "u4",
          state: "starting",
          workerId: "w1",
          slot: 2,
          stateSince: at(t0, -2),
          agentSeenAt: at(t0, -2),
        });

        yield* runner.handle(
          connected("w1", [
            {
              sessionId: "s-known",
              slot: 0,
              streamUrl: "http://cg-session-s-known:8080",
              gameRunning: true,
            },
            {
              sessionId: "s-ghost",
              slot: 1,
              streamUrl: "http://cg-session-s-ghost:8080",
              gameRunning: true,
            },
          ]),
          t0,
        );

        like(yield* sessionRow("s-lost"), {
          state: "failed",
          failReason: lostOnRestartReason,
          endedAt: t0,
        });
        like(yield* segmentsOf("s-lost"), [{ open: false }]);
        like(yield* sessionRow("s-known"), {
          state: "playing",
          agentSeenAt: t0,
        });
        expect((yield* sessionRow("s-other")).state).toBe("playing");
        expect((yield* sessionRow("s-new")).state).toBe("starting");
        // Контейнер неизвестной сессии гасим, чтобы освободить слот.
        expect(fake.sent).toEqual([
          {
            workerId: "w1",
            command: { _tag: "StopSession", sessionId: "s-ghost" },
          },
        ]);
      }),
    ));

  it("stop request sends StopSession, retried while the agent is away", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({
          id: "s1",
          userId: "u1",
          state: "starting",
          workerId: "w1",
          slot: 0,
          stateSince: t0,
          agentSeenAt: t0,
          clientSeenAt: t0,
        });
        yield* runner.handle(
          report("w1", { _tag: "GameState", sessionId: "s1", running: true }),
          t0,
        );
        const db = yield* Db;
        yield* db
          .update(sessions)
          .set({ stopRequestedAt: at(t0, 5), clientSeenAt: at(t0, 5) })
          .where(eq(sessions.id, "s1"));

        fake.infos.delete("w1");
        yield* runner.tick(at(t0, 6));
        expect((yield* sessionRow("s1")).state).toBe("stopping");
        like(yield* segmentsOf("s1"), [{ endedAt: at(t0, 6), open: false }]);
        expect(fake.sent).toEqual([]);

        yield* runner.tick(at(t0, 11));
        expect(fake.sent).toEqual([]);

        yield* connectWorker(fake, "w1", 1);
        yield* runner.tick(at(t0, 16));
        yield* runner.tick(at(t0, 21));
        expect(fake.sent).toEqual([
          { workerId: "w1", command: { _tag: "StopSession", sessionId: "s1" } },
        ]);
        expect((yield* sessionRow("s1")).state).toBe("stopping");

        yield* runner.handle(
          report("w1", { _tag: "Stopped", sessionId: "s1", cloudSynced: true }),
          at(t0, 25),
        );
        expect((yield* sessionRow("s1")).state).toBe("ended");
      }),
    ));
});

describe("session repo", () => {
  it("apply keeps stateSince on an unchanged state and runs ops in order", () =>
    run(() =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* insertSession({
          id: "s1",
          userId: "u1",
          state: "disconnected",
          stateSince: t0,
        });

        yield* SessionRepo.apply(
          "s1",
          {
            state: "disconnected",
            ops: [{ _tag: "Open", at: at(t0, 1), billable: false }],
            command: null,
            failReason: null,
          },
          at(t0, 2),
        );
        expect((yield* sessionRow("s1")).stateSince).toEqual(t0);

        // MarkOpenBillable → Close → Open: помечен и закрыт старый, открыт новый.
        yield* SessionRepo.apply(
          "s1",
          {
            state: "playing",
            ops: [
              { _tag: "MarkOpenBillable" },
              { _tag: "Close", at: at(t0, 30) },
              { _tag: "Open", at: at(t0, 30), billable: true },
            ],
            command: null,
            failReason: null,
          },
          at(t0, 30),
        );
        like(yield* sessionRow("s1"), {
          state: "playing",
          stateSince: at(t0, 30),
          endedAt: null,
        });
        like(yield* segmentsOf("s1"), [
          {
            startedAt: at(t0, 1),
            endedAt: at(t0, 30),
            billable: true,
            open: false,
          },
          {
            startedAt: at(t0, 30),
            endedAt: at(t0, 30),
            billable: true,
            open: true,
          },
        ]);

        yield* SessionRepo.apply(
          "s1",
          {
            state: "failed",
            ops: [{ _tag: "Close", at: at(t0, 31) }],
            command: null,
            failReason: "boom",
          },
          at(t0, 40),
        );
        like(yield* sessionRow("s1"), {
          state: "failed",
          stateSince: at(t0, 40),
          endedAt: at(t0, 40),
          failReason: "boom",
        });
        like((yield* segmentsOf("s1"))[1], {
          endedAt: at(t0, 31),
          open: false,
        });
      }),
    ));
});
