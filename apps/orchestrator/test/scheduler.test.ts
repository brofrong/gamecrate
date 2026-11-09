// Планировщик с классами воркеров и требованиями к железу (спека §2).
import { describe, expect, it } from "bun:test";
import {
  Db,
  gameRequirements,
  games,
  gamestoreApps,
  installJobs,
  ownGames,
  sessions,
  user,
  workers,
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

/**
 * Служебный воркер для строк `gamestore_apps` этого файла: библиотека своя
 * у каждого сервера (спека §5), но проверки размещения не смотрят на
 * `workerId` до задачи 8 — конкретный владелец строки здесь не важен.
 */
const LIBRARY_FIXTURE_WORKER = "library-fixture";

/** Игра `appId` в библиотеке (своя строка `games`/`gamestore_apps`). */
const seedGame = (appId: number, name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(games).values({ appId, name }).onConflictDoNothing();
    yield* db
      .insert(workers)
      .values({
        id: LIBRARY_FIXTURE_WORKER,
        publicIp: "203.0.113.8",
        slots: 0,
        roles: ["gamestore"],
      })
      .onConflictDoNothing();
    yield* db
      .insert(gamestoreApps)
      .values({
        workerId: LIBRARY_FIXTURE_WORKER,
        appId,
        sizeBytes: 1,
        buildId: "1",
      })
      .onConflictDoNothing();
  });

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
