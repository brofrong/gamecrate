import { describe, expect, it } from "bun:test";
import { Db, sessionMetrics, workerClasses, workers } from "@cg/db";
import {
  type AgentReport,
  containerGoneReason,
  type WorkerHardware,
} from "@cg/rpc";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { AgentHubEvent } from "../src/AgentHub";
import * as MetricsRepo from "../src/MetricsRepo";
import { SessionRunner } from "../src/SessionRunner";
import { connectWorker, insertSession, like, run, seedUsers } from "./support";

const GiB = 1024 ** 3;

const hardware: WorkerHardware = {
  cpuModel: "AMD Ryzen 5 2600X Six-Core Processor",
  cpuCores: 6,
  cpuThreads: 12,
  memoryBytes: 32 * GiB,
  gpus: [{ name: "NVIDIA GeForce GTX 1650 SUPER", memoryBytes: 4 * GiB }],
  disks: [],
};

type MetricsReport = Extract<AgentReport, { _tag: "SessionMetrics" }>;

const metrics = (patch: Partial<MetricsReport> = {}): MetricsReport => ({
  _tag: "SessionMetrics",
  sessionId: "s1",
  gameSeconds: 60,
  peakVramBytes: 1900 * 2 ** 20,
  peakRamBytes: 2 * GiB,
  cpuCoresP95: 2.5,
  gpuUtilP95: 87,
  vramSource: "process",
  ...patch,
});

const report = (workerId: string, agentReport: AgentReport): AgentHubEvent => ({
  _tag: "Report",
  workerId,
  report: agentReport,
});

const metricsRows = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.select().from(sessionMetrics);
  });

/** Пользователь u1, воркер w1 (1 слот, GTX 1650 Super, «Стандарт»), сессия s1 на нём. */
const seed = (fake: Parameters<typeof connectWorker>[0]) =>
  Effect.gen(function* () {
    yield* seedUsers("u1");
    yield* connectWorker(fake, "w1", 1, { hardware });
    yield* insertSession({
      id: "s1",
      userId: "u1",
      state: "playing",
      workerId: "w1",
      slot: 0,
    });
  });

describe("session metrics", () => {
  it("first report inserts row with gpu and class", () =>
    run((fake) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const runner = yield* SessionRunner;
        yield* seed(fake);
        const [standard] = yield* db
          .select({ id: workerClasses.id })
          .from(workerClasses)
          .where(eq(workerClasses.rank, 1));
        const now = new Date("2026-10-29T12:00:00Z");
        yield* runner.handle(report("w1", metrics()), now);
        const rows = yield* metricsRows();
        expect(rows).toHaveLength(1);
        like(rows[0], {
          sessionId: "s1",
          appId: 570,
          workerId: "w1",
          gpuName: "NVIDIA GeForce GTX 1650 SUPER",
          workerClassId: standard!.id,
          slots: 1,
          gameSeconds: 60,
          peakVramBytes: 1900 * 2 ** 20,
          peakRamBytes: 2 * GiB,
          cpuCoresP95: 2.5,
          gpuUtilP95: 87,
          vramSource: "process",
          gameEnd: null,
          updatedAt: now,
        });

        // Следующий отчёт обновляет ресурсы; снимок воркера — на момент сессии.
        yield* db.update(workers).set({ slots: 2 }).where(eq(workers.id, "w1"));
        const later = new Date("2026-10-29T12:01:00Z");
        yield* runner.handle(
          report(
            "w1",
            metrics({
              gameSeconds: 120,
              peakVramBytes: null,
              cpuCoresP95: 3,
              vramSource: "gpu_total",
            }),
          ),
          later,
        );
        const [row] = yield* metricsRows();
        like(row, {
          slots: 1,
          gameSeconds: 120,
          peakVramBytes: null,
          cpuCoresP95: 3,
          vramSource: "gpu_total",
          updatedAt: later,
        });
      }),
    ));

  it("worker without hardware writes an empty gpu name", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        yield* seedUsers("u1");
        yield* connectWorker(fake, "w1", 1);
        yield* insertSession({
          id: "s1",
          userId: "u1",
          state: "playing",
          workerId: "w1",
          slot: 0,
        });
        yield* runner.handle(report("w1", metrics()), new Date());
        const [row] = yield* metricsRows();
        expect(row?.gpuName).toBe("");
      }),
    ));

  it("late metrics keep game_end", () =>
    run((fake) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const runner = yield* SessionRunner;
        yield* seed(fake);
        yield* runner.handle(report("w1", metrics()), new Date());
        yield* db
          .update(sessionMetrics)
          .set({ gameEnd: "quit" })
          .where(eq(sessionMetrics.sessionId, "s1"));
        yield* runner.handle(
          report("w1", metrics({ gameSeconds: 65 })),
          new Date(),
        );
        const [row] = yield* metricsRows();
        like(row, { gameSeconds: 65, gameEnd: "quit" });
      }),
    ));

  it("report from another worker is ignored", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        yield* seed(fake);
        yield* connectWorker(fake, "w2", 1, { hardware });
        yield* runner.handle(report("w2", metrics()), new Date());
        expect(yield* metricsRows()).toEqual([]);
        yield* runner.handle(report("w1", metrics()), new Date());
        yield* runner.handle(
          report("w2", metrics({ gameSeconds: 999 })),
          new Date(),
        );
        const rows = yield* metricsRows();
        expect(rows.map((row) => [row.workerId, row.gameSeconds])).toEqual([
          ["w1", 60],
        ]);
      }),
    ));
});

const gameExited = (
  end?: "quit" | "crash" | "error" | "unknown",
): AgentReport => ({
  _tag: "GameState",
  sessionId: "s1",
  running: false,
  ...(end !== undefined ? { end } : {}),
});

const stopped: AgentReport = {
  _tag: "Stopped",
  sessionId: "s1",
  cloudSynced: true,
  profileSaved: true,
};

const failed = (reason: string): AgentReport => ({
  _tag: "Failed",
  sessionId: "s1",
  reason,
});

const gameEnd = () =>
  metricsRows().pipe(Effect.map((rows) => rows.map((row) => row.gameEnd)));

describe("game end", () => {
  it("stop after quit keeps quit", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        yield* seed(fake);
        yield* runner.handle(report("w1", metrics()), new Date());
        yield* runner.handle(report("w1", gameExited("quit")), new Date());
        expect(yield* gameEnd()).toEqual(["quit"]);
        yield* runner.handle(report("w1", stopped), new Date());
        expect(yield* gameEnd()).toEqual(["quit"]);
      }),
    ));

  it("containerGone gives crash", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        yield* seed(fake);
        yield* runner.handle(report("w1", metrics()), new Date());
        yield* runner.handle(
          report("w1", failed(containerGoneReason)),
          new Date(),
        );
        expect(yield* gameEnd()).toEqual(["crash"]);
      }),
    ));

  it("stop before exit gives stopped", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        yield* seed(fake);
        yield* runner.handle(report("w1", metrics()), new Date());
        yield* runner.handle(report("w1", stopped), new Date());
        const [row] = yield* metricsRows();
        like(row, { gameSeconds: 60, gameEnd: "stopped" });
      }),
    ));

  it("other failures give stopped", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        yield* seed(fake);
        yield* runner.handle(report("w1", metrics()), new Date());
        yield* runner.handle(
          report("w1", failed("Стрим не запустился за 2 минуты")),
          new Date(),
        );
        expect(yield* gameEnd()).toEqual(["stopped"]);
      }),
    ));

  it("exit from an old agent without end gives unknown", () =>
    run((fake) =>
      Effect.gen(function* () {
        const runner = yield* SessionRunner;
        yield* seed(fake);
        yield* runner.handle(report("w1", metrics()), new Date());
        yield* runner.handle(report("w1", gameExited()), new Date());
        expect(yield* gameEnd()).toEqual(["unknown"]);
      }),
    ));

  it("game end without a metrics row inserts the row with the session snapshot", () =>
    run((fake) =>
      Effect.gen(function* () {
        const db = yield* Db;
        const runner = yield* SessionRunner;
        yield* seed(fake);
        const [standard] = yield* db
          .select({ id: workerClasses.id })
          .from(workerClasses)
          .where(eq(workerClasses.rank, 1));
        // Контейнер пропал раньше первого отчёта замеров.
        yield* runner.handle(
          report("w1", failed(containerGoneReason)),
          new Date(),
        );
        const rows = yield* metricsRows();
        expect(rows).toHaveLength(1);
        like(rows[0], {
          sessionId: "s1",
          appId: 570,
          workerId: "w1",
          gpuName: "NVIDIA GeForce GTX 1650 SUPER",
          workerClassId: standard!.id,
          slots: 1,
          gameSeconds: 0,
          peakVramBytes: null,
          peakRamBytes: null,
          cpuCoresP95: null,
          gpuUtilP95: null,
          vramSource: "gpu_total",
          gameEnd: "crash",
        });
        // Поздний итог замеров — ресурсы пишутся, исход остаётся.
        yield* runner.handle(
          report("w1", metrics({ gameSeconds: 5 })),
          new Date(),
        );
        const [row] = yield* metricsRows();
        like(row, { gameSeconds: 5, peakRamBytes: 2 * GiB, gameEnd: "crash" });
      }),
    ));

  it("setGameEnd writes only the first end", () =>
    run((fake) =>
      Effect.gen(function* () {
        yield* seed(fake);
        yield* MetricsRepo.setGameEnd("s1", "error");
        yield* MetricsRepo.setGameEnd("s1", "stopped");
        expect(yield* gameEnd()).toEqual(["error"]);
      }),
    ));

  it("session without a worker gets no row", () =>
    run(() =>
      Effect.gen(function* () {
        yield* seedUsers("u1");
        yield* insertSession({ id: "s1", userId: "u1", state: "queued" });
        yield* MetricsRepo.setGameEnd("s1", "stopped");
        yield* MetricsRepo.setGameEnd("missing", "stopped");
        expect(yield* metricsRows()).toEqual([]);
      }),
    ));
});
