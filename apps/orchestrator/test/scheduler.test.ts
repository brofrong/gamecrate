// Планировщик с классами воркеров и требованиями к железу (спека §2) и
// библиотекой игр у каждого сервера (спека 2026-11-09 §5).
import { describe, expect, it } from "bun:test";
import {
  Db,
  gameRequirements,
  games,
  installJobs,
  ownGames,
  sessions,
  tariffGrants,
  tariffs,
  user,
  userStreamSettings,
} from "@cg/db";
import type { WorkerHardware } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Redacted } from "effect";
import * as Scheduler from "../src/Scheduler";
import { SteamLoginSeeds } from "../src/SteamLoginSeeds";
import {
  at,
  connectWorker,
  insertSession,
  installOn,
  like,
  run,
  seedUsers,
} from "./support";

const GiB = 1024 ** 3;

/** Железо с одной картой и без дисков (не важны для `fitsRequirements`). */
const hardware = (opts: {
  readonly vramBytes: number;
  readonly ramBytes: number;
  readonly cpuThreads: number;
}): WorkerHardware => ({
  cpuModel: "Test CPU",
  cpuCores: Math.max(1, Math.floor(opts.cpuThreads / 2)),
  cpuThreads: opts.cpuThreads,
  memoryBytes: opts.ramBytes,
  gpus: [{ name: "Test GPU", memoryBytes: opts.vramBytes }],
  disks: [],
});

const sessionRow = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db.select().from(sessions).where(eq(sessions.id, id));
    if (row === undefined) return yield* Effect.die(`no session ${id}`);
    return row;
  });

/** Строка `games` Steam-игры `appId` (в библиотеки серверов её кладёт `installOn`). */
const seedGame = (appId: number, name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(games).values({ appId, name }).onConflictDoNothing();
  });

/** Все задачи установки (по времени создания не сортируем — в тестах их ≤ 1). */
const installJobRows = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.select().from(installJobs);
  });

/** Steam-игра, которой по умолчанию нет ни в одной библиотеке. */
const PORTAL = 400;

/** Требования к железу игры (минимумы на слот, спека §1.2). */
const setRequirements = (
  appId: number,
  req: { minVramBytes: number; minRamBytes: number; minCpuThreads: number },
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(gameRequirements)
      .values({ appId, updatedBy: null, ...req });
  });

/** appId своей игры вне диапазона Steam (SoH, Global Constraints). */
const OWN_APP_ID = 1_900_000_001;

/**
 * Строка `games`/`own_games` своей игры (слаг и версия SoH, Global
 * Constraints) + требования с нулями (не мешают проверке пакета/публикации).
 * `published` по умолчанию `false`, как в таблице.
 */
const seedOwnGame = (opts: { readonly published?: boolean } = {}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db
      .insert(games)
      .values({ appId: OWN_APP_ID, name: "SoH" })
      .onConflictDoNothing();
    yield* db.insert(ownGames).values({
      appId: OWN_APP_ID,
      slug: "soh",
      version: "9.3.1-1",
      published: opts.published ?? false,
    });
    yield* db.insert(gameRequirements).values({
      appId: OWN_APP_ID,
      minVramBytes: 0,
      minRamBytes: 0,
      minCpuThreads: 0,
      updatedBy: null,
    });
  });

describe("scheduler: classes and hardware requirements", () => {
  it("worker without class gets no session", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w1", 1, { classRank: null });
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);

        expect((yield* sessionRow("s1")).state).toBe("queued");
        expect(fake.sent).toEqual([]);
      }),
    ));

  it("session goes to strongest allowed class first", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w-weak", 1, { classRank: 1 });
        yield* connectWorker(fake, "w-strong", 1, { classRank: 2 });
        // Требования с нулями — порядок проверяем через `fitsRequirements`,
        // а не через правило «только сильнейший класс» (§2.3).
        yield* setRequirements(570, {
          minVramBytes: 0,
          minRamBytes: 0,
          minCpuThreads: 0,
        });
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s1"), {
          state: "starting",
          workerId: "w-strong",
          slot: 0,
        });
      }),
    ));

  it("requirements above worker per-slot hardware keep session queued", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w1", 1, {
          hardware: hardware({
            vramBytes: 4 * GiB,
            ramBytes: 16 * GiB,
            cpuThreads: 8,
          }),
        });
        yield* setRequirements(570, {
          minVramBytes: 6 * GiB,
          minRamBytes: 0,
          minCpuThreads: 0,
        });
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);

        expect((yield* sessionRow("s1")).state).toBe("queued");
        expect(fake.sent).toEqual([]);
      }),
    ));

  it("game without requirements waits for strongest class", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u-busy", "u1");
        yield* connectWorker(fake, "w-weak", 1, { classRank: 1 });
        yield* connectWorker(fake, "w-strong", 1, { classRank: 2 });
        // w-strong занят — игра без данных о требованиях не уходит на w-weak.
        yield* insertSession({
          id: "s-busy",
          userId: "u-busy",
          state: "playing",
          workerId: "w-strong",
          slot: 0,
        });
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s1"), {
          state: "queued",
          workerId: null,
          slot: null,
        });
        expect(fake.sent).toEqual([]);
      }),
    ));

  it("old unplaceable session does not block a newer one", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u-old", "u-new");
        yield* seedGame(730, "Heavy Game");
        yield* connectWorker(fake, "w-weak", 1, {
          hardware: hardware({
            vramBytes: 4 * GiB,
            ramBytes: 16 * GiB,
            cpuThreads: 8,
          }),
          library: [570, 730],
        });
        yield* setRequirements(730, {
          minVramBytes: 8 * GiB,
          minRamBytes: 0,
          minCpuThreads: 0,
        });
        const db = yield* Db;
        yield* db.insert(sessions).values({
          id: "s-old",
          userId: "u-old",
          appId: 730,
          createdAt: at(t0, -10),
        });
        yield* insertSession({
          id: "s-new",
          userId: "u-new",
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s-new"), {
          state: "starting",
          workerId: "w-weak",
          slot: 0,
        });
        like(yield* sessionRow("s-old"), {
          state: "queued",
          workerId: null,
          slot: null,
        });
      }),
    ));
});

describe("scheduler: tariff queue priority (спека 2026-11-10 §5)", () => {
  it("higher queue_priority is placed first even if newer", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u-old", "u-vip");
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({
          id: "s-old",
          userId: "u-old",
          createdAt: at(t0, -60),
        });
        yield* insertSession({
          id: "s-vip",
          userId: "u-vip",
          createdAt: at(t0, -5),
          queuePriority: 10,
        });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s-vip"), {
          state: "starting",
          workerId: "w1",
          slot: 0,
        });
        like(yield* sessionRow("s-old"), { state: "queued", workerId: null });
      }),
    ));

  it("equal priority and created_at: tie broken by id, like rankQueue", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u-b", "u-a");
        yield* connectWorker(fake, "w1", 1);
        // «b» вставлена первой — без сортировки по id Postgres отдал бы её.
        yield* insertSession({ id: "s-b", userId: "u-b", createdAt: at(t0, -10) });
        yield* insertSession({ id: "s-a", userId: "u-a", createdAt: at(t0, -10) });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s-a"), { state: "starting", workerId: "w1" });
        like(yield* sessionRow("s-b"), { state: "queued", workerId: null });
      }),
    ));
});

describe("scheduler: game library of each server (спека 2026-11-09 §5)", () => {
  it("places on the worker that has the game", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* seedGame(PORTAL, "Portal");
        yield* connectWorker(fake, "w1", 1, { roles: ["worker", "gamestore"] });
        yield* connectWorker(fake, "w2", 1, {
          roles: ["worker", "gamestore"],
          library: [PORTAL],
        });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s1"), {
          state: "starting",
          workerId: "w2",
          slot: 0,
        });
        expect(yield* installJobRows()).toEqual([]);
      }),
    ));

  it("installs on a worker with a free slot", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u-busy", "u1");
        yield* seedGame(PORTAL, "Portal");
        yield* connectWorker(fake, "w1", 1, { roles: ["worker", "gamestore"] });
        yield* connectWorker(fake, "w2", 1, { roles: ["worker", "gamestore"] });
        // Единственный слот w1 занят — Portal ставится на w2, где сессия
        // сможет запуститься сразу после установки.
        yield* insertSession({
          id: "s-busy",
          userId: "u-busy",
          state: "playing",
          workerId: "w1",
          slot: 0,
        });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        const [job, ...rest] = yield* installJobRows();
        expect(rest).toEqual([]);
        like(job, {
          appId: PORTAL,
          userId: "u1",
          workerId: "w2",
          state: "queued",
        });
        like(yield* sessionRow("s1"), {
          state: "installing",
          installJobId: job?.id ?? "",
          workerId: null,
          slot: null,
        });
      }),
    ));

  it("installs on the first gamestore worker when every slot is busy", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u-busy", "u1");
        yield* seedGame(PORTAL, "Portal");
        // w0 без роли gamestore ставить не может; w1 — первый из годных.
        yield* connectWorker(fake, "w0", 1);
        yield* connectWorker(fake, "w1", 0, { roles: ["worker", "gamestore"] });
        yield* connectWorker(fake, "w2", 0, { roles: ["worker", "gamestore"] });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        const [job] = yield* installJobRows();
        like(job, { appId: PORTAL, workerId: "w1", state: "queued" });
        like(yield* sessionRow("s1"), { state: "installing" });
      }),
    ));

  it("waits when the game is installed only on a busy worker", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u-busy", "u1");
        yield* seedGame(PORTAL, "Portal");
        yield* connectWorker(fake, "w1", 1, {
          roles: ["worker", "gamestore"],
          library: [570, PORTAL],
        });
        yield* connectWorker(fake, "w2", 1, { roles: ["worker", "gamestore"] });
        yield* insertSession({
          id: "s-busy",
          userId: "u-busy",
          state: "playing",
          workerId: "w1",
          slot: 0,
        });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        // Portal уже стоит на w1 — вторую копию на свободный w2 не ставим, ждём.
        like(yield* sessionRow("s1"), {
          state: "queued",
          workerId: null,
          installJobId: null,
        });
        expect(yield* installJobRows()).toEqual([]);
        expect(fake.sent).toEqual([]);
      }),
    ));

  it("installs on an eligible worker when the game is only on an offline server", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        // Dota 2 стоит на `LIBRARY_FIXTURE_WORKER` (`seedUsers`), но его нет
        // на связи — для этой сессии игра не стоит нигде.
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w1", 1, {
          roles: ["worker", "gamestore"],
          library: [],
        });
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);

        const [job] = yield* installJobRows();
        like(job, { appId: 570, workerId: "w1", state: "queued" });
        like(yield* sessionRow("s1"), {
          state: "installing",
          installJobId: job?.id ?? "",
        });
      }),
    ));

  it("joins the active install on another eligible worker", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        yield* seedUsers("u-first", "u1");
        yield* seedGame(PORTAL, "Portal");
        yield* connectWorker(fake, "w1", 1, { roles: ["worker", "gamestore"] });
        yield* connectWorker(fake, "w2", 1, { roles: ["worker", "gamestore"] });
        // Portal уже ставится на w2 (для другой сессии); w1 свободен, но
        // второй задачи не заводим — присоединяемся к идущей.
        yield* db.insert(installJobs).values({
          id: "job-w2",
          appId: PORTAL,
          userId: "u-first",
          workerId: "w2",
          state: "running",
        });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        expect((yield* installJobRows()).map((j) => j.id)).toEqual(["job-w2"]);
        like(yield* sessionRow("s1"), {
          state: "installing",
          installJobId: "job-w2",
        });
      }),
    ));

  it("does not install over a deletion on the same worker", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* seedGame(PORTAL, "Portal");
        yield* connectWorker(fake, "w1", 1, { roles: ["worker", "gamestore"] });
        yield* installOn("w1", PORTAL, { deletingAt: at(t0, -1) });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: PORTAL,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        // Portal на w1 удаляется: не запускаем и не ставим туда же — ждём.
        like(yield* sessionRow("s1"), { state: "queued", installJobId: null });
        expect(yield* installJobRows()).toEqual([]);

        // Появился второй сервер — ставим туда.
        yield* connectWorker(fake, "w2", 1, { roles: ["worker", "gamestore"] });
        yield* Scheduler.tick(at(t0, 2));
        const [job] = yield* installJobRows();
        like(job, { appId: PORTAL, workerId: "w2" });
      }),
    ));

  it("skips workers without a Steam client template", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1", "u2");
        // У w1 игра стоит, но шаблон клиента Steam не собран.
        yield* connectWorker(fake, "w1", 1, {
          roles: ["worker", "gamestore"],
          steamClient: false,
        });
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);
        like(yield* sessionRow("s1"), { state: "queued", installJobId: null });
        expect(yield* installJobRows()).toEqual([]);

        yield* connectWorker(fake, "w2", 1);
        yield* Scheduler.tick(at(t0, 2));
        like(yield* sessionRow("s1"), { state: "starting", workerId: "w2" });
      }),
    ));
});

describe("scheduler: own games (спека 2026-11-03 «Свои игры»)", () => {
  it("own game session is placed on worker with the package with ownGame and no Steam login", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* seedOwnGame({ published: true });
        yield* connectWorker(fake, "w1", 1, {
          ownGames: [{ slug: "soh", version: "9.3.1-1" }],
        });
        // Посеянный вход Steam и пометка его сброса не должны понадобиться
        // своей игре — ни прочитаны, ни стёрты.
        const db = yield* Db;
        yield* db
          .update(user)
          .set({ steamLoginResetAt: at(t0, -60) })
          .where(eq(user.id, "u1"));
        const seeds = yield* SteamLoginSeeds;
        yield* seeds.put("u1", {
          accountName: Redacted.make("acc"),
          steamId: "76561198000000000",
          refreshToken: Redacted.make("rt"),
        });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: OWN_APP_ID,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s1"), {
          state: "starting",
          workerId: "w1",
          slot: 0,
        });
        expect(fake.sent).toHaveLength(1);
        const sent = fake.sent[0]!;
        expect(sent.workerId).toBe("w1");
        like(sent.command, {
          _tag: "StartSession",
          sessionId: "s1",
          userId: "u1",
          appId: OWN_APP_ID,
          slot: 0,
          ownGame: { slug: "soh", version: "9.3.1-1" },
          steamLogin: null,
        });
        expect("steamLoginResetAt" in sent.command).toBe(false);
        // Посеянный вход остался — своя игра его не трогала (не читала, не чистила).
        expect(yield* seeds.get("u1")).not.toBeNull();
      }),
    ));

  it("own game without a package waits, never installs", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* seedOwnGame({ published: true });
        yield* connectWorker(fake, "w1", 1); // без ownGames — пакета нет
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: OWN_APP_ID,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s1"), {
          state: "queued",
          workerId: null,
          slot: null,
        });
        expect(fake.sent).toEqual([]);
        const db = yield* Db;
        expect(yield* db.select().from(installJobs)).toEqual([]);
      }),
    ));

  it("own game hidden while queued stays queued, never installs", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        yield* seedUsers("u1");
        yield* seedOwnGame({ published: false });
        yield* connectWorker(fake, "w1", 1, {
          ownGames: [{ slug: "soh", version: "9.3.1-1" }],
        });
        yield* insertSession({
          id: "s1",
          userId: "u1",
          appId: OWN_APP_ID,
          createdAt: at(t0, -5),
        });

        yield* Scheduler.tick(t0);

        like(yield* sessionRow("s1"), {
          state: "queued",
          workerId: null,
          slot: null,
        });
        expect(fake.sent).toEqual([]);
        const db = yield* Db;
        expect(yield* db.select().from(installJobs)).toEqual([]);
      }),
    ));
});

/** Выдаёт тариф `tariffId` пользователю `userId` бессрочно, с `startsAt` в прошлом. */
const grantTariff = (userId: string, tariffId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(tariffGrants).values({
      id: `g-${userId}-${tariffId}`,
      userId,
      tariffId,
      startsAt: new Date("2026-01-01T00:00:00Z"),
      endsAt: null,
    });
  });

describe("scheduler: tariff limits (Task 8)", () => {
  it("StartSession carries maxBitrateMbps of the tariff", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        yield* seedUsers("u1");
        yield* db
          .insert(tariffs)
          .values({ id: "t-20mbps", name: "20 Мбит/с", maxBitrateMbps: 20 });
        yield* grantTariff("u1", "t-20mbps");
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);

        const sent = fake.sent[0]!;
        expect(sent.command._tag).toBe("StartSession");
        expect(
          sent.command._tag === "StartSession"
            ? sent.command.maxBitrateMbps
            : undefined,
        ).toBe(20);
      }),
    ));

  it("display is capped by tariff", () =>
    run((fake) =>
      Effect.gen(function* () {
        const t0 = new Date();
        const db = yield* Db;
        yield* seedUsers("u1");
        yield* db
          .insert(tariffs)
          .values({ id: "t-720p", name: "720p", maxResolution: "720p" });
        yield* grantTariff("u1", "t-720p");
        // Ручной режим, 1440p — тариф позволяет только 720p.
        yield* db.insert(userStreamSettings).values({
          userId: "u1",
          value: {
            quality: "manual",
            bitrateMbps: 10,
            resolution: "1440p",
            debug: "off",
            menuTourSeen: true,
          },
        });
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({ id: "s1", userId: "u1", createdAt: at(t0, -5) });

        yield* Scheduler.tick(t0);

        const sent = fake.sent[0]!;
        expect(
          sent.command._tag === "StartSession" ? sent.command.display : null,
        ).toEqual({ width: 1280, height: 720 });
      }),
    ));
});
