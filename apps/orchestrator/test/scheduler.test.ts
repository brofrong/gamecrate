// Планировщик с классами воркеров и требованиями к железу (спека §2).
import { describe, expect, it } from "bun:test";
import { Db, gameRequirements, games, gamestoreApps, sessions } from "@cg/db";
import type { WorkerHardware } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import * as Scheduler from "../src/Scheduler";
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

/** Игра `appId` в общей библиотеке (своя строка `games`/`gamestore_apps`). */
const seedGame = (appId: number, name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(games).values({ appId, name }).onConflictDoNothing();
    yield* db
      .insert(gamestoreApps)
      .values({ appId, sizeBytes: 1, buildId: "1" })
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
