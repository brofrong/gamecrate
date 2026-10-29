import { describe, expect, it } from "bun:test";
import type { WorkerHardware } from "@cg/rpc";
import { Effect } from "effect";
import {
  Db,
  games,
  gameRequirements,
  workerClasses,
  workers,
  type Database,
} from "../src/index";
import {
  allowedClasses,
  eligibleWorkers,
  fitsRequirements,
  gameAvailable,
  WORKER_RECENT_MS,
} from "../src/placement";
import { DbTest } from "./testDb";

const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.provide(DbTest))));

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

describe("fitsRequirements", () => {
  it("8 GiB VRAM card with 2 slots fails 6 GiB requirement", () => {
    const hw = hardware({
      vramBytes: 8 * GiB,
      ramBytes: 64 * GiB,
      cpuThreads: 32,
    });
    expect(
      fitsRequirements(hw, 2, {
        minVramBytes: 6 * GiB,
        minRamBytes: 0,
        minCpuThreads: 0,
      }),
    ).toBe(false);
  });

  it("zero requirements pass worker without hardware", () => {
    expect(
      fitsRequirements(null, 1, {
        minVramBytes: 0,
        minRamBytes: 0,
        minCpuThreads: 0,
      }),
    ).toBe(true);
  });

  it("worker without hardware fails non-zero requirement", () => {
    expect(
      fitsRequirements(null, 1, {
        minVramBytes: 1,
        minRamBytes: 0,
        minCpuThreads: 0,
      }),
    ).toBe(false);
  });

  it("RAM at the boundary passes (>=)", () => {
    const hw = hardware({
      vramBytes: 8 * GiB,
      ramBytes: 16 * GiB,
      cpuThreads: 8,
    });
    expect(
      fitsRequirements(hw, 1, {
        minVramBytes: 0,
        minRamBytes: 16 * GiB,
        minCpuThreads: 0,
      }),
    ).toBe(true);
  });

  it("CPU threads at the boundary passes (>=), slots < 1 treated as 1", () => {
    const hw = hardware({
      vramBytes: 8 * GiB,
      ramBytes: 16 * GiB,
      cpuThreads: 8,
    });
    expect(
      fitsRequirements(hw, 0, {
        minVramBytes: 0,
        minRamBytes: 0,
        minCpuThreads: 8,
      }),
    ).toBe(true);
  });
});

/** Заводит классы `rank 1` и `rank 2` (сидированный «Стандарт» удаляется). */
const setupClasses = (db: Database) =>
  Effect.gen(function* () {
    yield* db.delete(workerClasses);
    const [weak] = yield* db
      .insert(workerClasses)
      .values({ name: "Слабый", rank: 1 })
      .returning();
    const [strong] = yield* db
      .insert(workerClasses)
      .values({ name: "Сильный", rank: 2 })
      .returning();
    return { weak: weak!, strong: strong! };
  });

describe("eligibleWorkers", () => {
  it("worker without class is excluded", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values({
          id: "w1",
          publicIp: "203.0.113.1",
          slots: 1,
          classId: null,
        });
        const eligible = yield* eligibleWorkers("u1", 1, {
          workerIds: ["w1"],
        });
        expect(eligible).toHaveLength(0);
      }),
    ));

  it("draining excluded", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values({
          id: "w1",
          publicIp: "203.0.113.1",
          slots: 1,
          classId: weak.id,
          draining: true,
        });
        const eligible = yield* eligibleWorkers("u1", 1, {
          workerIds: ["w1"],
        });
        expect(eligible).toHaveLength(0);
      }),
    ));

  it("order by rank desc then id", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak, strong } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values([
          { id: "wb", publicIp: "203.0.113.1", slots: 1, classId: weak.id },
          { id: "wa", publicIp: "203.0.113.2", slots: 1, classId: strong.id },
          { id: "wc", publicIp: "203.0.113.3", slots: 1, classId: strong.id },
        ]);
        // Требования с нулями — проверка порядка через `fitsRequirements`,
        // а не через правило «только сильнейший класс» (§2.3, своя группа тестов).
        yield* db.insert(gameRequirements).values({
          appId: 1,
          minVramBytes: 0,
          minRamBytes: 0,
          minCpuThreads: 0,
          updatedBy: null,
        });
        const eligible = yield* eligibleWorkers("u1", 1, {
          workerIds: ["wb", "wa", "wc"],
        });
        expect(eligible.map((w) => w.id)).toEqual(["wa", "wc", "wb"]);
      }),
    ));

  it("game without requirements only on strongest class with workers", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak, strong } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values([
          { id: "w-weak", publicIp: "203.0.113.1", slots: 1, classId: weak.id },
          {
            id: "w-strong",
            publicIp: "203.0.113.2",
            slots: 1,
            classId: strong.id,
            draining: true,
          },
        ]);
        const eligible = yield* eligibleWorkers("u1", 1, {
          workerIds: ["w-weak", "w-strong"],
        });
        expect(eligible.map((w) => w.id)).toEqual(["w-weak"]);
      }),
    ));

  it("strongest class's only worker not in workerIds falls through to next class", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak, strong } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values([
          { id: "w-weak", publicIp: "203.0.113.1", slots: 1, classId: weak.id },
          {
            id: "w-strong",
            publicIp: "203.0.113.2",
            slots: 1,
            classId: strong.id,
          },
        ]);
        // w-strong существует и не на обслуживании, но не передан планировщиком
        // (не подключён сейчас) — при расчёте "сильнейшего класса" не считается.
        const eligible = yield* eligibleWorkers("u1", 1, {
          workerIds: ["w-weak"],
        });
        expect(eligible.map((w) => w.id)).toEqual(["w-weak"]);
      }),
    ));

  it("too small worker excluded by requirements", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { strong } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values({
          id: "w1",
          publicIp: "203.0.113.1",
          slots: 1,
          classId: strong.id,
          hardware: hardware({
            vramBytes: 4 * GiB,
            ramBytes: 16 * GiB,
            cpuThreads: 8,
          }),
        });
        yield* db.insert(gameRequirements).values({
          appId: 1,
          minVramBytes: 6 * GiB,
          minRamBytes: 0,
          minCpuThreads: 0,
          updatedBy: null,
        });
        const eligible = yield* eligibleWorkers("u1", 1, {
          workerIds: ["w1"],
        });
        expect(eligible).toHaveLength(0);
      }),
    ));
});

describe("allowedClasses", () => {
  it("returns all classes by rank desc", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak, strong } = yield* setupClasses(db);
        const classes = yield* allowedClasses("u1");
        expect(classes.map((c) => c.id)).toEqual([strong.id, weak.id]);
      }),
    ));
});

describe("gameAvailable", () => {
  const now = new Date("2026-10-29T12:00:00.000Z");
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60 * 1000);

  it("worker seen 11 minutes ago does not make game available", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values({
          id: "w1",
          publicIp: "203.0.113.1",
          slots: 1,
          roles: ["worker"],
          classId: weak.id,
          lastSeenAt: minutesAgo(11),
        });
        expect(yield* gameAvailable("u1", 1, now)).toBe(false);
      }),
    ));

  it("stats_at 1 minute ago does", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values({
          id: "w1",
          publicIp: "203.0.113.1",
          slots: 1,
          roles: ["worker"],
          classId: weak.id,
          lastSeenAt: minutesAgo(11),
          statsAt: minutesAgo(1),
        });
        expect(yield* gameAvailable("u1", 1, now)).toBe(true);
      }),
    ));

  it("recent gamestore-only worker with a class does not make game available", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values({
          id: "w1",
          publicIp: "203.0.113.1",
          slots: 1,
          roles: ["gamestore"],
          classId: weak.id,
          lastSeenAt: minutesAgo(1),
        });
        expect(yield* gameAvailable("u1", 1, now)).toBe(false);
      }),
    ));

  it("no workers at all: unavailable", () =>
    run(
      Effect.gen(function* () {
        yield* setupClasses(yield* Db);
        yield* (yield* Db).insert(games).values({ appId: 1, name: "G1" });
        expect(yield* gameAvailable("u1", 1, now)).toBe(false);
      }),
    ));

  it("recent worker right at the WORKER_RECENT_MS boundary counts as available", () =>
    run(
      Effect.gen(function* () {
        const db = yield* Db;
        const { weak } = yield* setupClasses(db);
        yield* db.insert(games).values({ appId: 1, name: "G1" });
        yield* db.insert(workers).values({
          id: "w1",
          publicIp: "203.0.113.1",
          slots: 1,
          roles: ["worker"],
          classId: weak.id,
          lastSeenAt: new Date(now.getTime() - WORKER_RECENT_MS),
        });
        expect(yield* gameAvailable("u1", 1, now)).toBe(true);
      }),
    ));
});
