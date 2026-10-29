import { describe, expect, it } from "bun:test";
import {
  Db,
  gamestoreApps,
  games,
  installJobs,
  profiles,
  sessions,
  settings,
  user,
  workerClasses,
  workers,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import {
  type AgentCommand,
  type AgentReport,
  type AgentRoles,
  type SteamLoginSeed,
  accessDeniedReason,
  sessionSettingsKey,
  steamLoginRequiredReason,
} from "@cg/rpc";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer, Redacted, References, type Scope } from "effect";
import { AgentHub, type AgentHubEvent } from "../src/AgentHub";
import {
  DISPATCH_CONFIRM_MS,
  InstallDispatcher,
  type InstallDispatcherOptions,
  installErrors,
} from "../src/InstallDispatcher";
import * as InstallRepo from "../src/InstallRepo";
import { AGENT_TIMEOUT_MS, failReasons } from "../src/lifecycle";
import * as Scheduler from "../src/Scheduler";
import { RECONCILE_GRACE_MS, SessionRunner } from "../src/SessionRunner";
import { SteamLoginSeeds } from "../src/SteamLoginSeeds";
import { at, type FakeHub, like, makeFakeHub } from "./support";

type Env =
  | Db
  | AgentHub
  | InstallDispatcher
  | SessionRunner
  | SteamLoginSeeds
  | Scope.Scope;

const run = <A, E>(
  body: (fake: FakeHub) => Effect.Effect<A, E, Env>,
  options: InstallDispatcherOptions = {},
) => {
  const fake = makeFakeHub();
  return Effect.runPromise(
    Effect.scoped(body(fake)).pipe(
      Effect.provideService(References.MinimumLogLevel, "Error"),
      Effect.provide(
        Layer.mergeAll(
          InstallDispatcher.layerWithoutLoops(options),
          SessionRunner.layerWithoutLoops(),
        ).pipe(
          Layer.provideMerge(Layer.succeed(AgentHub, fake.hub)),
          Layer.provideMerge(SteamLoginSeeds.layer),
          Layer.provideMerge(DbTest),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
        ),
      ),
    ),
  );
};

const DOTA = 570;
const PORTAL = 400;

/** Класс «Стандарт» (`rank 1`), заводится, если его ещё нет. */
const standardClassId = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [existing] = yield* db
      .select({ id: workerClasses.id })
      .from(workerClasses)
      .where(eq(workerClasses.rank, 1));
    if (existing !== undefined) return existing.id;
    const [created] = yield* db
      .insert(workerClasses)
      .values({ name: "Стандарт", rank: 1 })
      .returning({ id: workerClasses.id });
    return created!.id;
  });

/**
 * Агент подключён (как и раньше); воркеру всегда назначается класс
 * «Стандарт» — планировщик (§2.1) без класса сессий не размещает, а эти
 * тесты проверяют именно размещение/установку, а не классы.
 */
const connectAgent = (
  fake: FakeHub,
  workerId: string,
  roles: AgentRoles,
  slots = 1,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const classId = yield* standardClassId();
    yield* db
      .insert(workers)
      .values({ id: workerId, publicIp: "203.0.113.7", slots, classId })
      .onConflictDoNothing();
    fake.infos.set(workerId, {
      workerId,
      publicIp: "203.0.113.7",
      slots,
      udpPortBase: 59000,
      roles,
    });
  });

const seed = (...userIds: string[]) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(games).values([
      { appId: DOTA, name: "Dota 2" },
      { appId: PORTAL, name: "Portal" },
    ]);
    for (const id of userIds)
      yield* db.insert(user).values({
        id,
        name: id,
        email: `${id}@steam.invalid`,
        emailVerified: false,
      });
  });

const markInstalled = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(gamestoreApps)
      .values({ appId, sizeBytes: 1_000, buildId: "1" });
  });

const insertSession = (values: {
  id: string;
  userId: string;
  appId?: number;
  createdAt?: Date;
  stopRequestedAt?: Date;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(sessions).values({ appId: DOTA, ...values });
  });

const sessionRow = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db.select().from(sessions).where(eq(sessions.id, id));
    if (row === undefined) return yield* Effect.die(`no session ${id}`);
    return row;
  });

const jobs = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select()
      .from(installJobs)
      .orderBy(asc(installJobs.createdAt));
  });

const onlyJob = () =>
  Effect.gen(function* () {
    const all = yield* jobs();
    expect(all).toHaveLength(1);
    const [job] = all;
    if (job === undefined) return yield* Effect.die("no job");
    return job;
  });

const report = (workerId: string, agentReport: AgentReport): AgentHubEvent => ({
  _tag: "Report",
  workerId,
  report: agentReport,
});

const connected = (
  workerId: string,
  installs: ReadonlyArray<string>,
): AgentHubEvent => ({
  _tag: "Connected",
  workerId,
  publicIp: "203.0.113.7",
  slots: 0,
  udpPortBase: 59000,
  roles: ["gamestore"],
  running: [],
  installs,
});

/** Админ запросил отмену задачи (как пишет api). */
const requestCancel = (jobId: string, when: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .update(installJobs)
      .set({ cancelRequestedAt: when })
      .where(eq(installJobs.id, jobId));
  });

/** Отправленные команды установки (без StartSession). */
const installCommands = (fake: FakeHub) =>
  fake.sent.filter(
    (s) =>
      s.command._tag === "InstallGame" || s.command._tag === "CancelInstall",
  );

describe("install jobs", () => {
  it("uninstalled game moves session to installing with a new job", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        yield* seed("u1", "u2");
        yield* markInstalled(PORTAL);
        yield* connectAgent(fake, "w1", ["worker"], 2);
        yield* db.insert(profiles).values({
          userId: "u2",
          version: 3,
          objectKey: "profiles/u2/p3.cgp",
          sizeBytes: 10,
        });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          createdAt: at(t0, -10),
        });
        yield* insertSession({
          id: "s2",
          userId: "u2",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        const job = yield* onlyJob();
        like(job, {
          appId: DOTA,
          userId: "u1",
          state: "queued",
          workerId: null,
        });
        like(yield* sessionRow("s1"), {
          state: "installing",
          stateSince: t0,
          installJobId: job.id,
          workerId: null,
          slot: null,
        });
        // Установленная игра размещается как раньше — с профилем пользователя.
        like(yield* sessionRow("s2"), { state: "starting", workerId: "w1" });
        expect(fake.sent).toEqual([
          {
            workerId: "w1",
            command: {
              _tag: "StartSession",
              sessionId: "s2",
              userId: "u2",
              appId: PORTAL,
              slot: 0,
              udpPort: 59000,
              profile: { version: 3, objectKey: "profiles/u2/p3.cgp" },
              steamLogin: null,
              display: { width: 1920, height: 1080 },
            },
          },
        ]);

        // Установке не нужен воркер: без агентов сессия тоже уходит в installing.
        fake.infos.clear();
        yield* db
          .update(sessions)
          .set({ state: "ended" })
          .where(eq(sessions.id, "s2"));
        yield* insertSession({ id: "s3", userId: "u2", appId: DOTA });
        yield* Scheduler.tick(at(t0, 2));
        like(yield* sessionRow("s3"), {
          state: "installing",
          installJobId: job.id,
        });
      }),
    ));

  it("second session joins running install job", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1", "u2");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* connectAgent(fake, "w1", ["worker"], 2);
        yield* insertSession({ id: "s1", userId: "u1" });

        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();
        like(job, { state: "running", workerId: "gs" });

        yield* insertSession({ id: "s2", userId: "u2" });
        yield* Scheduler.tick(at(t0, 2));
        yield* dispatcher.tick(at(t0, 2));

        // Одна задача на appid: s2 ждёт ту же, второй InstallGame нет.
        expect((yield* onlyJob()).id).toBe(job.id);
        like(yield* sessionRow("s2"), {
          state: "installing",
          installJobId: job.id,
        });
        expect(installCommands(fake)).toEqual([
          {
            workerId: "gs",
            command: {
              _tag: "InstallGame",
              jobId: job.id,
              appId: DOTA,
              userId: "u1",
              profile: null,
              steamLogin: null,
              steamLoginTimeoutSeconds: 90,
            },
          },
        ]);

        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallProgress",
            jobId: job.id,
            bytesDownloaded: 340,
            bytesTotal: 1000,
          }),
          at(t0, 10),
        );
        like(yield* onlyJob(), { bytesDownloaded: 340, bytesTotal: 1000 });
        // Прогресс от чужого агента не принимается.
        yield* dispatcher.handle(
          report("w1", {
            _tag: "InstallProgress",
            jobId: job.id,
            bytesDownloaded: 999,
            bytesTotal: 1000,
          }),
          at(t0, 11),
        );
        like(yield* onlyJob(), { bytesDownloaded: 340 });

        const finishedAt = at(t0, 60);
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFinished",
            jobId: job.id,
            sizeBytes: 50_000,
            buildId: "777",
          }),
          finishedAt,
        );
        like(yield* onlyJob(), { state: "done" });
        const db = yield* Db;
        const [app] = yield* db
          .select()
          .from(gamestoreApps)
          .where(eq(gamestoreApps.appId, DOTA));
        like(app, { sizeBytes: 50_000, buildId: "777" });
        for (const id of ["s1", "s2"])
          like(yield* sessionRow(id), {
            state: "queued",
            stateSince: finishedAt,
          });

        // Дальше — обычное размещение на воркер.
        yield* Scheduler.tick(at(t0, 62));
        like(yield* sessionRow("s1"), { state: "starting", workerId: "w1" });
        like(yield* sessionRow("s2"), { state: "starting", workerId: "w1" });
      }),
    ));

  it("InstallGame carries the user's pending Steam login and timeout", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const seeds = yield* SteamLoginSeeds;
        const dispatcher = yield* InstallDispatcher;
        const CS = 730;
        yield* seed("userA", "userB");
        yield* db.insert(games).values({ appId: CS, name: "Counter-Strike" });
        yield* db.insert(settings).values({
          key: sessionSettingsKey,
          value: { steamLoginTimeoutSeconds: 120 },
        });
        const steamLogin: SteamLoginSeed = {
          accountName: Redacted.make("steamuser"),
          steamId: "76561198000000001",
          refreshToken: Redacted.make("refresh-a"),
        };
        yield* seeds.put("userA", steamLogin);

        // Два разных appid — две отдельные задачи, можно дать их двум агентам
        // за один проход диспетчера (claimNext выбирает воркер по возрастанию id).
        yield* insertSession({ id: "sA", userId: "userA" });
        yield* Scheduler.tick(t0);
        yield* insertSession({ id: "sB", userId: "userB", appId: CS });
        yield* Scheduler.tick(at(t0, 2));

        yield* connectAgent(fake, "gs-a", ["gamestore"], 0);
        yield* connectAgent(fake, "gs-b", ["gamestore"], 0);
        yield* dispatcher.tick(at(t0, 4));

        const [jobA, jobB] = yield* jobs();
        if (jobA === undefined || jobB === undefined)
          return yield* Effect.die("expected two jobs");
        expect(installCommands(fake)).toEqual([
          {
            workerId: "gs-a",
            command: {
              _tag: "InstallGame",
              jobId: jobA.id,
              appId: DOTA,
              userId: "userA",
              profile: null,
              steamLogin,
              steamLoginTimeoutSeconds: 120,
            },
          },
          {
            workerId: "gs-b",
            command: {
              _tag: "InstallGame",
              jobId: jobB.id,
              appId: CS,
              userId: "userB",
              profile: null,
              steamLogin: null,
              steamLoginTimeoutSeconds: 120,
            },
          },
        ]);
      }),
    ));

  it("InstallGame carries the reset and drops older seed", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const seeds = yield* SteamLoginSeeds;
        const dispatcher = yield* InstallDispatcher;
        const CS = 730;
        yield* seed("u-old", "u-new", "u-none");
        yield* db.insert(games).values({ appId: CS, name: "Counter-Strike" });
        const makeLogin = (token: string): SteamLoginSeed => ({
          accountName: Redacted.make("steamuser"),
          steamId: "76561198000000001",
          refreshToken: Redacted.make(token),
        });
        // Входы положены сейчас; у u-old сброс позже (вход устарел), у u-new —
        // раньше (вход положен после сброса), у u-none пометки нет.
        yield* seeds.put("u-old", makeLogin("old"));
        const fresh = makeLogin("fresh");
        yield* seeds.put("u-new", fresh);
        const none = makeLogin("none");
        yield* seeds.put("u-none", none);
        const resetOld = new Date(Date.now() + 60_000);
        const resetNew = new Date(Date.now() - 60_000);
        yield* db
          .update(user)
          .set({ steamLoginResetAt: resetOld })
          .where(eq(user.id, "u-old"));
        yield* db
          .update(user)
          .set({ steamLoginResetAt: resetNew })
          .where(eq(user.id, "u-new"));

        // Три разных appid — три задачи, по одной на агента за проход.
        yield* insertSession({ id: "s-old", userId: "u-old" });
        yield* Scheduler.tick(t0);
        yield* insertSession({ id: "s-new", userId: "u-new", appId: PORTAL });
        yield* Scheduler.tick(at(t0, 2));
        yield* insertSession({ id: "s-none", userId: "u-none", appId: CS });
        yield* Scheduler.tick(at(t0, 4));

        yield* connectAgent(fake, "gs-a", ["gamestore"], 0);
        yield* connectAgent(fake, "gs-b", ["gamestore"], 0);
        yield* connectAgent(fake, "gs-c", ["gamestore"], 0);
        yield* dispatcher.tick(at(t0, 6));

        const [jobOld, jobNew, jobNone] = yield* jobs();
        if (
          jobOld === undefined ||
          jobNew === undefined ||
          jobNone === undefined
        )
          return yield* Effect.die("expected three jobs");
        const commands = installCommands(fake);
        expect(commands).toEqual([
          {
            workerId: "gs-a",
            command: {
              _tag: "InstallGame",
              jobId: jobOld.id,
              appId: DOTA,
              userId: "u-old",
              profile: null,
              steamLogin: null,
              steamLoginTimeoutSeconds: 90,
              steamLoginResetAt: resetOld.toISOString(),
            },
          },
          {
            workerId: "gs-b",
            command: {
              _tag: "InstallGame",
              jobId: jobNew.id,
              appId: PORTAL,
              userId: "u-new",
              profile: null,
              steamLogin: fresh,
              steamLoginTimeoutSeconds: 90,
              steamLoginResetAt: resetNew.toISOString(),
            },
          },
          {
            workerId: "gs-c",
            command: {
              _tag: "InstallGame",
              jobId: jobNone.id,
              appId: CS,
              userId: "u-none",
              profile: null,
              steamLogin: none,
              steamLoginTimeoutSeconds: 90,
            },
          },
        ]);
        // Без пометки ключа нет вовсе (а не `undefined`).
        expect("steamLoginResetAt" in (commands[2]?.command ?? {})).toBe(false);
        expect(yield* seeds.get("u-old")).toBeNull();
      }),
    ));

  it("queued job of a blocked owner requeues its other waiter, the next job is claimed in the same pass", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u-blocked", "u-joined", "u-other");
        // Задача DOTA владельца u-blocked, к ней присоединился u-joined;
        // за ней — задача PORTAL другого пользователя.
        yield* insertSession({ id: "s-owner", userId: "u-blocked" });
        yield* Scheduler.tick(t0);
        yield* insertSession({ id: "s-joined", userId: "u-joined" });
        yield* Scheduler.tick(at(t0, 1));
        yield* insertSession({
          id: "s-other",
          userId: "u-other",
          appId: PORTAL,
        });
        yield* Scheduler.tick(at(t0, 2));
        const [blockedJob, otherJob] = yield* jobs();
        if (blockedJob === undefined || otherJob === undefined)
          return yield* Effect.die("expected two jobs");
        like(blockedJob, { userId: "u-blocked", appId: DOTA, state: "queued" });
        like(yield* sessionRow("s-joined"), {
          state: "installing",
          installJobId: blockedJob.id,
        });

        // Админ заблокировал владельца уже после создания задачи.
        yield* db
          .update(user)
          .set({ blockedAt: at(t0, 3) })
          .where(eq(user.id, "u-blocked"));
        yield* connectAgent(fake, "gs-a", ["gamestore"], 0);
        yield* dispatcher.tick(at(t0, 4));

        like(yield* jobs(), [
          {
            id: blockedJob.id,
            state: "failed",
            error: accessDeniedReason,
            workerId: null,
          },
          { id: otherJob.id, state: "running", workerId: "gs-a" },
        ]);
        // M1: сам владелец не в счёт (его разберёт планировщик), но u-joined
        // ни при чём, и его сессия не падает вместе с задачей — она ждёт
        // новую попытку в очереди.
        like(yield* sessionRow("s-owner"), { state: "queued" });
        like(yield* sessionRow("s-joined"), { state: "queued" });
        like(yield* sessionRow("s-other"), {
          state: "installing",
          installJobId: otherJob.id,
        });
        expect(
          installCommands(fake).map((s) =>
            s.command._tag === "InstallGame" ? s.command.jobId : "",
          ),
        ).toEqual([otherJob.id]);

        // Следующий проход планировщика: владелец всё ещё заблокирован —
        // «Доступ закрыт» при размещении (`blockedFailure`); u-joined не
        // заблокирован — ему выписывается новая задача под своим профилем.
        yield* Scheduler.tick(at(t0, 5));
        like(yield* sessionRow("s-owner"), {
          state: "failed",
          failReason: accessDeniedReason,
          endedAt: at(t0, 5),
        });
        const joinedRow = yield* sessionRow("s-joined");
        expect(joinedRow.state).toBe("installing");
        expect(joinedRow.installJobId).not.toBe(blockedJob.id);
        const allJobs = yield* jobs();
        const newJob = allJobs.find(
          (j) => j.id !== blockedJob.id && j.id !== otherJob.id,
        );
        if (newJob === undefined) return yield* Effect.die("expected a new job");
        expect(newJob.userId).toBe("u-joined");
        expect(newJob.state).toBe("queued");
      }),
    ));

  it("dispatcher sends InstallGame only to a gamestore agent", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1", "u2");
        yield* db.insert(profiles).values({
          userId: "u1",
          version: 2,
          objectKey: "profiles/u1/p2.cgp",
          sizeBytes: 10,
        });
        yield* connectAgent(fake, "w1", ["worker"], 4);
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -9) });
        yield* insertSession({
          id: "s2",
          userId: "u2",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });
        yield* Scheduler.tick(t0);

        // Только агент сессий — задачи ждут в очереди.
        yield* dispatcher.tick(t0);
        expect(installCommands(fake)).toEqual([]);
        for (const job of yield* jobs())
          like(job, { state: "queued", workerId: null });

        // Агент gamestore есть, но команда не дошла — задача снова в очереди.
        yield* connectAgent(fake, "gs", ["worker", "gamestore"], 1);
        fake.state.refuse = (_workerId, command) =>
          command._tag === "InstallGame";
        yield* dispatcher.tick(at(t0, 2));
        expect(installCommands(fake)).toEqual([]);
        for (const job of yield* jobs())
          like(job, { state: "queued", workerId: null });

        // Дошла: самая старая задача, с профилем пользователя; одна на агента.
        fake.state.refuse = () => false;
        yield* dispatcher.tick(at(t0, 4));
        const [first, second] = yield* jobs();
        like(first, { appId: DOTA, state: "running", workerId: "gs" });
        like(second, { appId: PORTAL, state: "queued", workerId: null });
        expect(installCommands(fake)).toEqual([
          {
            workerId: "gs",
            command: {
              _tag: "InstallGame",
              jobId: first?.id ?? "",
              appId: DOTA,
              userId: "u1",
              profile: { version: 2, objectKey: "profiles/u1/p2.cgp" },
              steamLogin: null,
              steamLoginTimeoutSeconds: 90,
            },
          },
        ]);
        yield* dispatcher.tick(at(t0, 6));
        expect(installCommands(fake)).toHaveLength(1);
      }),
    ));

  it("draining gamestore worker gets no install jobs", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1");
        yield* connectAgent(fake, "gs", ["gamestore"], 1);
        yield* db
          .update(workers)
          .set({ draining: true })
          .where(eq(workers.id, "gs"));
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);
        const job = yield* onlyJob();
        like(job, { appId: DOTA, state: "queued", workerId: null });

        yield* dispatcher.tick(at(t0, 2));
        like(yield* onlyJob(), { state: "queued", workerId: null });
        expect(installCommands(fake)).toEqual([]);
      }),
    ));

  it("owner without a Steam login sees the login hint, other waiters the generic reason", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1", "u2");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -9) });
        yield* insertSession({ id: "s2", userId: "u2", createdAt: at(t0, -5) });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();
        like(job, { userId: "u1", state: "running" });

        const failedAt = at(t0, 30);
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFailed",
            jobId: job.id,
            reason: steamLoginRequiredReason,
          }),
          failedAt,
        );
        like(yield* onlyJob(), {
          state: "failed",
          error: steamLoginRequiredReason,
        });
        like(yield* sessionRow("s1"), {
          state: "failed",
          failReason: steamLoginRequiredReason,
        });
        // Чужой профиль u2 тут ни при чём: ему — общая причина.
        like(yield* sessionRow("s2"), {
          state: "failed",
          failReason: failReasons.installFailed,
        });
      }),
    ));

  it("failed job fails waiting sessions", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1", "u2", "u3");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -9) });
        yield* insertSession({ id: "s2", userId: "u2", createdAt: at(t0, -5) });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();

        // Итог от чужого агента не принимается.
        yield* dispatcher.handle(
          report("w-other", {
            _tag: "InstallFailed",
            jobId: job.id,
            reason: "x",
          }),
          at(t0, 5),
        );
        like(yield* onlyJob(), { state: "running" });

        const failedAt = at(t0, 30);
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFailed",
            jobId: job.id,
            reason: "Загрузка остановилась",
          }),
          failedAt,
        );
        like(yield* onlyJob(), {
          state: "failed",
          error: "Загрузка остановилась",
        });
        for (const id of ["s1", "s2"])
          like(yield* sessionRow(id), {
            state: "failed",
            failReason: failReasons.installFailed,
            endedAt: failedAt,
          });

        // Первый итог побеждает: поздний InstallFinished ничего не меняет.
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFinished",
            jobId: job.id,
            sizeBytes: 1,
            buildId: "1",
          }),
          at(t0, 31),
        );
        like(yield* onlyJob(), { state: "failed" });
        const db = yield* Db;
        expect(yield* db.select().from(gamestoreApps)).toEqual([]);

        // И наоборот: InstallFailed после InstallFinished (отмена неизвестной задачи).
        yield* insertSession({ id: "s3", userId: "u3" });
        yield* Scheduler.tick(at(t0, 40));
        yield* dispatcher.tick(at(t0, 40));
        const [, retry] = yield* jobs();
        if (retry === undefined) return yield* Effect.die("no retry job");
        like(retry, { state: "running", workerId: "gs" });
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFinished",
            jobId: retry.id,
            sizeBytes: 5,
            buildId: "2",
          }),
          at(t0, 50),
        );
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFailed",
            jobId: retry.id,
            reason: "Установка отменена",
          }),
          at(t0, 51),
        );
        like((yield* jobs())[1], { state: "done", error: null });
        like(yield* sessionRow("s3"), { state: "queued" });
      }),
    ));

  it("install missing from reconnect fails job", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1", "u2");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1" });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();
        like(job, { state: "running" });

        // Связь моргнула, установка жива — задача продолжается (и более новое
        // подключение отменяет подозрение прежнего).
        yield* dispatcher.handle(connected("gs", []), at(t0, 14));
        yield* dispatcher.handle(connected("gs", [job.id]), at(t0, 15));
        yield* dispatcher.tick(at(t0, 15 + RECONCILE_GRACE_MS / 1000));
        like(yield* onlyJob(), { state: "running" });
        expect(installCommands(fake)).toHaveLength(1);

        // Агент перезапустился: установки нет. Отчёты, перенесённые через
        // переподключение, ещё могут прийти — сразу не валим.
        const reconnectAt = at(t0, 30);
        yield* dispatcher.handle(connected("gs", []), reconnectAt);
        yield* dispatcher.tick(at(t0, 31));
        like(yield* onlyJob(), { state: "running" });

        const failAt = new Date(reconnectAt.getTime() + RECONCILE_GRACE_MS);
        yield* dispatcher.tick(failAt);
        like(yield* onlyJob(), {
          state: "failed",
          error: installErrors.interrupted,
        });
        like(yield* sessionRow("s1"), {
          state: "failed",
          failReason: failReasons.installFailed,
        });

        // Перенесённый InstallFinished пришёл после Connected с installs=[] —
        // задача завершена, а не провалена.
        yield* insertSession({ id: "s2", userId: "u2", appId: PORTAL });
        yield* Scheduler.tick(at(t0, 60));
        yield* dispatcher.tick(at(t0, 60));
        const [, portal] = yield* jobs();
        if (portal === undefined) return yield* Effect.die("no job");
        like(portal, { state: "running", workerId: "gs" });
        yield* dispatcher.handle(connected("gs", []), at(t0, 90));
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFinished",
            jobId: portal.id,
            sizeBytes: 9,
            buildId: "3",
          }),
          at(t0, 90),
        );
        yield* dispatcher.tick(at(t0, 120));
        like((yield* jobs())[1], { state: "done" });
        like(yield* sessionRow("s2"), { state: "queued" });

        // Агент продолжает установку, которой оркестратор не ждёт, — отменить.
        yield* dispatcher.handle(connected("gs", ["job-unknown"]), at(t0, 130));
        expect(installCommands(fake).at(-1)).toEqual({
          workerId: "gs",
          command: { _tag: "CancelInstall", jobId: "job-unknown" },
        });
      }),
    ));

  it("silent gamestore agent fails its job", () => {
    const t0 = new Date();
    return run(
      (fake) =>
        Effect.gen(function* () {
          const dispatcher = yield* InstallDispatcher;
          yield* seed("u1");
          yield* connectAgent(fake, "gs", ["gamestore"], 0);
          yield* insertSession({ id: "s1", userId: "u1" });
          yield* Scheduler.tick(t0);
          yield* dispatcher.tick(t0);

          // Heartbeat агента продлевает жизнь задачи.
          const seenAt = at(t0, 60);
          yield* dispatcher.handle(
            report("gs", { _tag: "Heartbeat", sessionIds: [] }),
            seenAt,
          );
          yield* dispatcher.tick(new Date(seenAt.getTime() + AGENT_TIMEOUT_MS));
          like(yield* onlyJob(), { state: "running" });

          yield* dispatcher.tick(
            new Date(seenAt.getTime() + AGENT_TIMEOUT_MS + 1000),
          );
          like(yield* onlyJob(), {
            state: "failed",
            error: installErrors.interrupted,
          });
          like(yield* sessionRow("s1"), {
            state: "failed",
            failReason: failReasons.installFailed,
          });
        }),
      { startedAt: t0 },
    );
  });

  it("stop requested while installing ends the session and cancels the last waiter's job", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const dispatcher = yield* InstallDispatcher;
        const runner = yield* SessionRunner;
        yield* seed("u1", "u2", "u3");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -9) });
        yield* insertSession({ id: "s2", userId: "u2", createdAt: at(t0, -5) });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();

        const stop = (id: string, when: Date) =>
          db
            .update(sessions)
            .set({ stopRequestedAt: when })
            .where(eq(sessions.id, id));

        // Первая из двух ждущих уходит — установка продолжается.
        yield* stop("s1", at(t0, 10));
        yield* runner.tick(at(t0, 10));
        like(yield* sessionRow("s1"), {
          state: "ended",
          endedAt: at(t0, 10),
        });
        yield* dispatcher.tick(at(t0, 10));
        expect(installCommands(fake)).toHaveLength(1);
        like(yield* onlyJob(), { state: "running" });

        // Ушла последняя — CancelInstall (один раз); итог решает отчёт агента.
        yield* stop("s2", at(t0, 20));
        yield* runner.tick(at(t0, 20));
        like(yield* sessionRow("s2"), { state: "ended" });
        yield* dispatcher.tick(at(t0, 20));
        yield* dispatcher.tick(at(t0, 22));
        expect(installCommands(fake).slice(1)).toEqual([
          {
            workerId: "gs",
            command: { _tag: "CancelInstall", jobId: job.id },
          },
        ]);
        like(yield* onlyJob(), { state: "running" });
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFailed",
            jobId: job.id,
            reason: "Установка отменена",
          }),
          at(t0, 23),
        );
        like(yield* onlyJob(), { state: "failed" });

        // Задача ещё в очереди (агенту не отправлена) — просто отменяется.
        fake.infos.delete("gs");
        yield* insertSession({ id: "s3", userId: "u3", appId: PORTAL });
        yield* Scheduler.tick(at(t0, 30));
        const [, queued] = yield* jobs();
        if (queued === undefined) return yield* Effect.die("no job");
        like(queued, { state: "queued" });
        yield* stop("s3", at(t0, 31));
        yield* runner.tick(at(t0, 31));
        yield* dispatcher.tick(at(t0, 31));
        like((yield* jobs())[1], {
          state: "failed",
          error: installErrors.cancelled,
        });
        expect(installCommands(fake)).toHaveLength(2);
      }),
    ));

  it("install dispatched just before a reconnect waits for confirmation", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1", "u2");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1" });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();
        const heartbeat = (when: Date) =>
          dispatcher.handle(
            report("gs", { _tag: "Heartbeat", sessionIds: [] }),
            when,
          );
        const ms = (offset: number) => new Date(t0.getTime() + offset);

        // InstallGame ушёл в полумёртвое соединение и потерялся; агент
        // переподключился через 5 с без установки, но исправно шлёт heartbeat.
        yield* dispatcher.handle(connected("gs", []), at(t0, 5));
        yield* dispatcher.tick(at(t0, 5 + RECONCILE_GRACE_MS / 1000));
        like(yield* onlyJob(), { state: "running" });
        for (let s = 60; s * 1000 < DISPATCH_CONFIRM_MS; s += 60) {
          yield* heartbeat(at(t0, s));
          yield* dispatcher.tick(at(t0, s));
        }
        yield* heartbeat(ms(DISPATCH_CONFIRM_MS - 1000));
        yield* dispatcher.tick(ms(DISPATCH_CONFIRM_MS - 1000));
        like(yield* onlyJob(), { state: "running" });

        // Подтверждения нет — задача провалена, агенту на всякий случай отмена,
        // и он свободен для следующей задачи.
        yield* dispatcher.tick(ms(DISPATCH_CONFIRM_MS));
        like(yield* onlyJob(), {
          state: "failed",
          error: installErrors.interrupted,
        });
        like(yield* sessionRow("s1"), { state: "failed" });
        expect(installCommands(fake).at(-1)).toEqual({
          workerId: "gs",
          command: { _tag: "CancelInstall", jobId: job.id },
        });

        // InstallGame дошёл в новое соединение: отчёт по задаче подтверждает её.
        const t1 = ms(DISPATCH_CONFIRM_MS + 10_000);
        yield* insertSession({ id: "s2", userId: "u2", appId: PORTAL });
        yield* Scheduler.tick(t1);
        yield* dispatcher.tick(t1);
        const [, portal] = yield* jobs();
        if (portal === undefined) return yield* Effect.die("no job");
        like(portal, { state: "running", workerId: "gs" });
        yield* dispatcher.handle(connected("gs", []), at(t1, 3));
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallProgress",
            jobId: portal.id,
            bytesDownloaded: 1,
            bytesTotal: 10,
          }),
          at(t1, 60),
        );
        const late = new Date(t1.getTime() + DISPATCH_CONFIRM_MS + 1000);
        yield* heartbeat(late);
        yield* dispatcher.tick(late);
        like((yield* jobs())[1], { state: "running" });
      }),
    ));

  it("install job owner's other session waits until the job ends", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const dispatcher = yield* InstallDispatcher;
        const runner = yield* SessionRunner;
        yield* seed("u1", "u2");
        yield* markInstalled(PORTAL);
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* connectAgent(fake, "w1", ["worker"], 2);
        // u1 начал установку Dota, u2 ждёт ту же задачу.
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -9) });
        yield* insertSession({ id: "s2", userId: "u2", createdAt: at(t0, -5) });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();
        like(job, { userId: "u1", state: "running" });

        // u1 ушёл и запустил установленную игру — профиль u1 у установщика,
        // поэтому сессия ждёт в очереди.
        yield* db
          .update(sessions)
          .set({ stopRequestedAt: at(t0, 10) })
          .where(eq(sessions.id, "s1"));
        yield* runner.tick(at(t0, 10));
        yield* insertSession({ id: "s3", userId: "u1", appId: PORTAL });
        yield* Scheduler.tick(at(t0, 12));
        yield* dispatcher.tick(at(t0, 12));
        like(yield* sessionRow("s3"), { state: "queued", workerId: null });
        expect(
          fake.sent.filter((s) => s.command._tag === "StartSession"),
        ).toEqual([]);

        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFinished",
            jobId: job.id,
            sizeBytes: 5,
            buildId: "9",
          }),
          at(t0, 60),
        );
        yield* Scheduler.tick(at(t0, 62));
        like(yield* sessionRow("s3"), { state: "starting", workerId: "w1" });
        like(yield* sessionRow("s2"), { state: "starting", workerId: "w1" });
      }),
    ));

  it("sessions that joined a cancelled job go back to the queue", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const dispatcher = yield* InstallDispatcher;
        const runner = yield* SessionRunner;
        yield* seed("u1", "u2");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1" });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();

        // Последняя ждущая ушла — CancelInstall; пока агент отменяет,
        // присоединилась новая сессия.
        yield* db
          .update(sessions)
          .set({ stopRequestedAt: at(t0, 10) })
          .where(eq(sessions.id, "s1"));
        yield* runner.tick(at(t0, 10));
        yield* dispatcher.tick(at(t0, 10));
        expect(installCommands(fake).at(-1)?.command).toEqual({
          _tag: "CancelInstall",
          jobId: job.id,
        });
        yield* insertSession({ id: "s2", userId: "u2" });
        yield* Scheduler.tick(at(t0, 11));
        like(yield* sessionRow("s2"), {
          state: "installing",
          installJobId: job.id,
        });

        const cancelledAt = at(t0, 12);
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFailed",
            jobId: job.id,
            reason: "Установка отменена",
          }),
          cancelledAt,
        );
        like(yield* onlyJob(), { state: "failed" });
        like(yield* sessionRow("s2"), {
          state: "queued",
          stateSince: cancelledAt,
          failReason: null,
        });

        // Новая задача — уже профилем u2.
        yield* Scheduler.tick(at(t0, 14));
        const [, fresh] = yield* jobs();
        like(fresh, { userId: "u2", state: "queued" });
        like(yield* sessionRow("s2"), {
          state: "installing",
          installJobId: fresh?.id ?? "",
        });
      }),
    ));
});

describe("admin cancel", () => {
  it("admin cancel of a queued job fails it with the admin reason and fails waiters", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1", "u2");
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -9) });
        yield* insertSession({ id: "s2", userId: "u2", createdAt: at(t0, -5) });
        // Агента gamestore нет — задача ждёт в очереди.
        yield* Scheduler.tick(t0);
        const job = yield* onlyJob();
        like(job, { state: "queued" });

        yield* requestCancel(job.id, at(t0, 1));
        // Агент появился, но отменённую задачу ему не выдают.
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        const cancelledAt = at(t0, 2);
        yield* dispatcher.tick(cancelledAt);

        like(yield* onlyJob(), {
          state: "failed",
          error: installErrors.cancelledByAdmin,
        });
        for (const id of ["s1", "s2"])
          like(yield* sessionRow(id), {
            state: "failed",
            failReason: installErrors.cancelledByAdmin,
            endedAt: cancelledAt,
          });
        expect(installCommands(fake)).toEqual([]);
      }),
    ));

  it("admin cancel of a running job sends CancelInstall, agent's InstallFailed → failed with the admin reason, waiters failed (not requeued)", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1", "u2");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -9) });
        yield* insertSession({ id: "s2", userId: "u2", createdAt: at(t0, -5) });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();
        like(job, { state: "running", workerId: "gs" });
        yield* requestCancel(job.id, at(t0, 5));
        const cancelInstall = {
          workerId: "gs",
          command: { _tag: "CancelInstall", jobId: job.id } as AgentCommand,
        };

        // Не доставлена — повтор на следующем проходе; доставлена — один раз.
        fake.state.refuse = (_workerId, command) =>
          command._tag === "CancelInstall";
        yield* dispatcher.tick(at(t0, 6));
        expect(installCommands(fake)).toHaveLength(1);
        fake.state.refuse = () => false;
        yield* dispatcher.tick(at(t0, 8));
        yield* dispatcher.tick(at(t0, 10));
        expect(installCommands(fake).slice(1)).toEqual([cancelInstall]);
        like(yield* onlyJob(), { state: "running" });

        // Агент переподключился — команда прежнего соединения могла потеряться.
        yield* dispatcher.handle(connected("gs", [job.id]), at(t0, 11));
        yield* dispatcher.tick(at(t0, 12));
        expect(installCommands(fake).slice(1)).toEqual([
          cancelInstall,
          cancelInstall,
        ]);

        const failedAt = at(t0, 13);
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFailed",
            jobId: job.id,
            reason: "Установка отменена",
          }),
          failedAt,
        );
        like(yield* onlyJob(), {
          state: "failed",
          error: installErrors.cancelledByAdmin,
        });
        for (const id of ["s1", "s2"])
          like(yield* sessionRow(id), {
            state: "failed",
            failReason: installErrors.cancelledByAdmin,
            endedAt: failedAt,
          });
      }),
    ));

  it("admin cancel then InstallFinished → done, game installed", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1" });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();
        yield* requestCancel(job.id, at(t0, 5));
        yield* dispatcher.tick(at(t0, 6));
        expect(installCommands(fake).at(-1)?.command).toEqual({
          _tag: "CancelInstall",
          jobId: job.id,
        });

        // Агент уже переносил игру — отмена опоздала, игра установлена.
        const finishedAt = at(t0, 7);
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFinished",
            jobId: job.id,
            sizeBytes: 42,
            buildId: "5",
          }),
          finishedAt,
        );
        like(yield* onlyJob(), { state: "done", error: null });
        const [app] = yield* db
          .select()
          .from(gamestoreApps)
          .where(eq(gamestoreApps.appId, DOTA));
        like(app, { sizeBytes: 42, buildId: "5" });
        like(yield* sessionRow("s1"), {
          state: "queued",
          stateSince: finishedAt,
        });
      }),
    ));

  it("claimNext skips a cancel-requested job", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seed("u1", "u2");
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -9) });
        yield* insertSession({
          id: "s2",
          userId: "u2",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });
        yield* Scheduler.tick(t0);
        const [dota, portal] = yield* jobs();
        if (dota === undefined || portal === undefined)
          return yield* Effect.die("expected two jobs");
        like(dota, { appId: DOTA, state: "queued" });
        yield* requestCancel(dota.id, at(t0, 1));

        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        const claim = yield* InstallRepo.claimNext(["gs"], at(t0, 2));
        expect(claim?.job.id).toBe(portal.id);
        like((yield* jobs())[0], { state: "queued", workerId: null });
      }),
    ));
});

describe("install stage", () => {
  it("InstallStage report stores the stage of a running job", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const dispatcher = yield* InstallDispatcher;
        yield* seed("u1");
        yield* connectAgent(fake, "gs", ["gamestore"], 0);
        yield* connectAgent(fake, "gs2", ["gamestore"], 0);
        yield* insertSession({ id: "s1", userId: "u1" });
        yield* Scheduler.tick(t0);
        yield* dispatcher.tick(t0);
        const job = yield* onlyJob();
        like(job, { state: "running", workerId: "gs" });

        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallStage",
            jobId: job.id,
            stage: "downloading",
          }),
          at(t0, 1),
        );
        expect((yield* onlyJob()).stage).toBe("downloading");

        // Этап раньше уже записанного (индекс в InstallStage меньше) игнорируется.
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallStage",
            jobId: job.id,
            stage: "login",
          }),
          at(t0, 2),
        );
        expect((yield* onlyJob()).stage).toBe("downloading");

        // Чужой агент не пишет этап этой задачи.
        yield* dispatcher.handle(
          report("gs2", {
            _tag: "InstallStage",
            jobId: job.id,
            stage: "moving",
          }),
          at(t0, 3),
        );
        expect((yield* onlyJob()).stage).toBe("downloading");

        // Задача больше не running — отчёт игнорируется.
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallFinished",
            jobId: job.id,
            sizeBytes: 1,
            buildId: "1",
          }),
          at(t0, 4),
        );
        yield* dispatcher.handle(
          report("gs", {
            _tag: "InstallStage",
            jobId: job.id,
            stage: "moving",
          }),
          at(t0, 5),
        );
        expect((yield* onlyJob()).stage).toBe("downloading");
      }),
    ));
});
