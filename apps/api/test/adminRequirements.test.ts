// RPC `admin.games.requirements`/`admin.games.setRequirements` (спека §5.2):
// короткие сессии (< `MIN_GAME_SECONDS`) не учитываются, группировка по GPU
// (p95, доли `crash`/other, `perSlotVramBytes`), сумма по всем GPU (`overall`),
// сохранение/очистка требований с `updated_by`. По образцу adminClasses.test.ts.
import { describe, expect, it } from "bun:test";
import {
  Db,
  games,
  gameRequirements,
  sessionMetrics,
  sessions,
  user,
  workerClasses,
  workers,
  type Database,
} from "@cg/db";
import { DbTest } from "@cg/db/test";
import { type CurrentUserShape, AdminRpcs } from "@cg/rpc";
import type { WorkerHardware } from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, type Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { AdminRpcHandlers } from "../src/admin/rpc";
import { BetterAuth } from "../src/auth/auth";
import { RpcMiddlewares } from "../src/auth/currentUser";
import { OwnGameCatalog } from "../src/library/OwnGameCatalog";

const admin: CurrentUserShape = {
  id: "u-admin",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};

const auth = { current: admin as CurrentUserShape | null };
const fakeAuth = Layer.succeed(BetterAuth, {
  handler: async () => new Response(""),
  currentUser: () => Effect.sync(() => Option.fromNullishOr(auth.current)),
});

const env = Layer.mergeAll(AdminRpcHandlers, RpcMiddlewares).pipe(
  Layer.provide(fakeAuth),
  Layer.provide(OwnGameCatalog.fromManifests([])),
  Layer.provideMerge(DbTest),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof env> | Scope.Scope>,
) => {
  auth.current = admin;
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(env)));
};

const client = RpcTest.makeClient(AdminRpcs);

const APP_ID = 100;

const hardware = (vramBytes: number, slots = 1): WorkerHardware => ({
  cpuModel: "Test CPU",
  cpuCores: 4,
  cpuThreads: 8,
  memoryBytes: 64,
  gpus: [{ name: "Test GPU", memoryBytes: vramBytes * slots }],
  disks: [],
});

const insertUser = (db: Db["Service"], id: string) =>
  db.insert(user).values({ id, name: id, email: `${id}@example.test` });

/**
 * Миграция сидирует класс «Стандарт» (`rank 1`) — тесты строят свой набор с
 * нуля, как `clearSeededClass` в `adminClasses.test.ts`.
 */
const clearSeededClass = (db: Db["Service"]) => db.delete(workerClasses);

const insertWorker = (
  db: Db["Service"],
  values: Partial<typeof workers.$inferInsert> & { id: string },
) =>
  db.insert(workers).values({ publicIp: "37.153.14.138", slots: 1, ...values });

/** Сессия + её строка `session_metrics` одним вызовом (FK на `sessions.id`). */
const insertSessionMetrics = (
  db: Db["Service"],
  values: {
    sessionId: string;
    userId: string;
    workerId: string;
    classId: string | null;
    slots: number;
    gpuName: string;
    gameSeconds: number;
    peakVramBytes: number | null;
    peakRamBytes: number | null;
    cpuCoresP95: number | null;
    gpuUtilP95: number | null;
    vramSource: "process" | "gpu_total";
    gameEnd: "quit" | "crash" | "error" | "stopped" | "unknown" | null;
  },
) =>
  Effect.gen(function* () {
    yield* insertUser(db, values.userId);
    yield* db.insert(sessions).values({
      id: values.sessionId,
      userId: values.userId,
      appId: APP_ID,
      state: "ended",
    });
    yield* db.insert(sessionMetrics).values({
      sessionId: values.sessionId,
      appId: APP_ID,
      workerId: values.workerId,
      gpuName: values.gpuName,
      workerClassId: values.classId,
      slots: values.slots,
      gameSeconds: values.gameSeconds,
      peakVramBytes: values.peakVramBytes,
      peakRamBytes: values.peakRamBytes,
      cpuCoresP95: values.cpuCoresP95,
      gpuUtilP95: values.gpuUtilP95,
      vramSource: values.vramSource,
      gameEnd: values.gameEnd,
    });
  });

describe("admin.games.requirements", () => {
  it("groups by GPU, excludes short sessions, computes shares/p95/perSlotVramBytes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db: Database = yield* Db;
        yield* clearSeededClass(db);
        yield* db.insert(games).values({ appId: APP_ID, name: "Test Game" });
        const classId = yield* db
          .insert(workerClasses)
          .values({ name: "Стандарт", rank: 1 })
          .returning({ id: workerClasses.id })
          .pipe(Effect.map(([row]) => row!.id));

        // Группа "Test GPU X": 3 долгих сессии + 1 короткая (исключается).
        // w1 (24 VRAM, slots 2 → 12/slot), w2 (40 VRAM, slots 4 → 10/slot) — максимум 12.
        yield* insertWorker(db, { id: "w1", classId, hardware: hardware(24) });
        yield* insertWorker(db, { id: "w2", classId, hardware: hardware(40) });

        yield* insertSessionMetrics(db, {
          sessionId: "s1",
          userId: "u1",
          workerId: "w1",
          classId,
          slots: 2,
          gpuName: "Test GPU X",
          gameSeconds: 600,
          peakVramBytes: 1,
          peakRamBytes: 2,
          cpuCoresP95: 1,
          gpuUtilP95: 10,
          vramSource: "process",
          gameEnd: "quit",
        });
        yield* insertSessionMetrics(db, {
          sessionId: "s2",
          userId: "u2",
          workerId: "w1",
          classId,
          slots: 2,
          gpuName: "Test GPU X",
          gameSeconds: 600,
          peakVramBytes: 10,
          peakRamBytes: 20,
          cpuCoresP95: 2,
          gpuUtilP95: 50,
          vramSource: "process",
          gameEnd: "crash",
        });
        yield* insertSessionMetrics(db, {
          sessionId: "s3",
          userId: "u3",
          workerId: "w2",
          classId,
          slots: 4,
          gpuName: "Test GPU X",
          gameSeconds: 600,
          peakVramBytes: 20,
          peakRamBytes: 40,
          cpuCoresP95: 4,
          gpuUtilP95: 90,
          vramSource: "gpu_total",
          gameEnd: "error",
        });
        // Короткая сессия, та же GPU-группа: экстремальные значения не должны влиять на p95.
        yield* insertSessionMetrics(db, {
          sessionId: "s-short",
          userId: "u-short",
          workerId: "w1",
          classId,
          slots: 2,
          gpuName: "Test GPU X",
          gameSeconds: 100,
          peakVramBytes: 99_999,
          peakRamBytes: 99_999,
          cpuCoresP95: 99,
          gpuUtilP95: 99,
          vramSource: "process",
          gameEnd: "crash",
        });

        // Вторая группа "Test GPU Y": без класса, без железа воркера (perSlotVramBytes неизвестен).
        yield* insertWorker(db, { id: "w3", classId: null, hardware: null });
        yield* insertSessionMetrics(db, {
          sessionId: "s4",
          userId: "u4",
          workerId: "w3",
          classId: null,
          slots: 1,
          gpuName: "Test GPU Y",
          gameSeconds: 400,
          peakVramBytes: 100,
          peakRamBytes: 200,
          cpuCoresP95: 8,
          gpuUtilP95: 99,
          vramSource: "gpu_total",
          gameEnd: "unknown",
        });

        const rpc = yield* client;
        return yield* rpc["admin.games.requirements"]({ appId: APP_ID });
      }),
    );

    expect(result.requirements).toBeNull();

    const gpuX = result.rows.find((r) => r.gpuName === "Test GPU X");
    const gpuY = result.rows.find((r) => r.gpuName === "Test GPU Y");
    expect(result.rows).toHaveLength(2);
    expect(gpuX).toBeDefined();
    expect(gpuY).toBeDefined();

    // Короткая сессия исключена из счёта и из p95.
    expect(gpuX!.sessions).toBe(3);
    expect(gpuX!.className).toBe("Стандарт");
    expect(gpuX!.vramP95).toBeCloseTo(19, 5);
    expect(gpuX!.ramP95).toBeCloseTo(38, 5);
    expect(gpuX!.cpuP95).toBeCloseTo(3.8, 5);
    expect(gpuX!.gpuUtilP95).toBeCloseTo(86, 5);
    expect(gpuX!.crashShare).toBeCloseTo(1 / 3, 5);
    expect(gpuX!.otherShare).toBeCloseTo(1 / 3, 5);
    expect(gpuX!.vramSources).toEqual(["gpu_total", "process"]);
    expect(gpuX!.perSlotVramBytes).toBeCloseTo(12, 5);

    expect(gpuY!.sessions).toBe(1);
    expect(gpuY!.className).toBeNull();
    expect(gpuY!.vramP95).toBeCloseTo(100, 5);
    expect(gpuY!.crashShare).toBe(0);
    expect(gpuY!.otherShare).toBe(1);
    expect(gpuY!.vramSources).toEqual(["gpu_total"]);
    expect(gpuY!.perSlotVramBytes).toBeNull();

    // `overall` — те же p95, но по всем 4 (не 5 — короткая исключена) сессиям вместе.
    expect(result.overall.sessions).toBe(4);
    expect(result.overall.vramP95).toBeCloseTo(88, 5);
    expect(result.overall.ramP95).toBeCloseTo(176, 5);
    expect(result.overall.cpuP95).toBeCloseTo(7.4, 5);
  });

  it("returns stored requirements and overall sessions 0 for a game without metrics", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(games).values({ appId: 200, name: "No Data Game" });
        const rpc = yield* client;
        return yield* rpc["admin.games.requirements"]({ appId: 200 });
      }),
    );
    expect(result.requirements).toBeNull();
    expect(result.rows).toEqual([]);
    expect(result.overall).toEqual({
      sessions: 0,
      vramP95: null,
      ramP95: null,
      cpuP95: null,
    });
  });
});

describe("admin.games.setRequirements", () => {
  it("sets requirements with updated_by, then clears the row with null", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u-admin");
        yield* db.insert(games).values({ appId: 300, name: "Set Game" });
        const rpc = yield* client;

        const setOk = yield* rpc["admin.games.setRequirements"]({
          appId: 300,
          requirements: {
            minVramBytes: 4 * 1024 ** 3,
            minRamBytes: 8 * 1024 ** 3,
            minCpuThreads: 4,
          },
        });
        const [row] = yield* db
          .select()
          .from(gameRequirements)
          .where(eq(gameRequirements.appId, 300));
        const after = yield* rpc["admin.games.requirements"]({ appId: 300 });

        const clearOk = yield* rpc["admin.games.setRequirements"]({
          appId: 300,
          requirements: null,
        });
        const afterClear = yield* rpc["admin.games.requirements"]({
          appId: 300,
        });

        return { setOk, row, after, clearOk, afterClear };
      }),
    );
    expect(result.setOk).toBe(true);
    expect(result.row?.updatedBy).toBe("u-admin");
    expect(result.row?.minVramBytes).toBe(4 * 1024 ** 3);
    expect(result.after.requirements).toEqual({
      minVramBytes: 4 * 1024 ** 3,
      minRamBytes: 8 * 1024 ** 3,
      minCpuThreads: 4,
    });
    expect(result.clearOk).toBe(true);
    expect(result.afterClear.requirements).toBeNull();
  });

  it("saving again overwrites the previous row (upsert)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* insertUser(db, "u-admin");
        yield* db.insert(games).values({ appId: 400, name: "Upsert Game" });
        const rpc = yield* client;
        yield* rpc["admin.games.setRequirements"]({
          appId: 400,
          requirements: { minVramBytes: 1, minRamBytes: 1, minCpuThreads: 1 },
        });
        yield* rpc["admin.games.setRequirements"]({
          appId: 400,
          requirements: { minVramBytes: 2, minRamBytes: 2, minCpuThreads: 2 },
        });
        const rows = yield* db
          .select()
          .from(gameRequirements)
          .where(eq(gameRequirements.appId, 400));
        return rows;
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.minVramBytes).toBe(2);
  });
});
