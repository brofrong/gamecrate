// Замеры сессий в БД (спека 2026-10-29 «требования к железу», §1.3, §4): строка
// `session_metrics` по отчётам агента `SessionMetrics` и исход игры (§4.2).
import { Db, type GameEnd, sessionMetrics, sessions, workers } from "@cg/db";
import type { AgentReport } from "@cg/rpc";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { Effect } from "effect";

type SessionMetricsReport = Extract<AgentReport, { _tag: "SessionMetrics" }>;

/**
 * Снимок сессии и её воркера для новой строки замеров: `app_id` из
 * `sessions`, `gpu_name` — `workers.hardware.gpus[0].name` (пусто без
 * `hardware`), `worker_class_id`, `slots`. Сессии (на воркере) нет —
 * `undefined`.
 */
const snapshotOf = (where: SQL | undefined) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [owner] = yield* db
      .select({
        sessionId: sessions.id,
        appId: sessions.appId,
        workerId: workers.id,
        hardware: workers.hardware,
        classId: workers.classId,
        slots: workers.slots,
      })
      .from(sessions)
      .innerJoin(workers, eq(workers.id, sessions.workerId))
      .where(where);
    if (owner === undefined) return undefined;
    return {
      sessionId: owner.sessionId,
      appId: owner.appId,
      workerId: owner.workerId,
      gpuName: owner.hardware?.gpus[0]?.name ?? "",
      workerClassId: owner.classId,
      slots: owner.slots,
    };
  });

/**
 * Отчёт `SessionMetrics` воркера `workerId`: первый — вставка строки со снимком
 * сессии и воркера на этот момент (`snapshotOf`), следующие — замена ресурсных
 * полей (агент шлёт накопленное целиком). Снимок воркера и `game_end` (его
 * пишет исход игры) не трогает. Сессия не на этом воркере (или её нет) — отчёт
 * игнорируется.
 */
export const upsertMetrics = (
  workerId: string,
  report: SessionMetricsReport,
  now: Date,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const snapshot = yield* snapshotOf(
      and(eq(sessions.id, report.sessionId), eq(sessions.workerId, workerId)),
    );
    if (snapshot === undefined) return;
    const resources = {
      gameSeconds: report.gameSeconds,
      peakVramBytes: report.peakVramBytes,
      peakRamBytes: report.peakRamBytes,
      cpuCoresP95: report.cpuCoresP95,
      gpuUtilP95: report.gpuUtilP95,
      vramSource: report.vramSource,
      updatedAt: now,
    };
    yield* db
      .insert(sessionMetrics)
      .values({ ...snapshot, ...resources })
      .onConflictDoUpdate({ target: sessionMetrics.sessionId, set: resources });
  });

/**
 * Исход игры сессии (спека §4.2): пишется только первый (`game_end is null`).
 * Строки замеров ещё нет (контейнер пропал или сессию остановили до первого
 * отчёта) — вставка со снимком `snapshotOf`, без ресурсов (`null`),
 * `game_seconds` 0, `vram_source` `gpu_total`. Сессии без воркера (или её
 * нет) — ничего.
 */
export const setGameEnd = (sessionId: string, end: GameEnd) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const snapshot = yield* snapshotOf(eq(sessions.id, sessionId));
    if (snapshot === undefined) return;
    yield* db
      .insert(sessionMetrics)
      .values({
        ...snapshot,
        gameSeconds: 0,
        peakVramBytes: null,
        peakRamBytes: null,
        cpuCoresP95: null,
        gpuUtilP95: null,
        vramSource: "gpu_total",
        gameEnd: end,
      })
      .onConflictDoUpdate({
        target: sessionMetrics.sessionId,
        set: { gameEnd: end },
        setWhere: isNull(sessionMetrics.gameEnd),
      });
  });
