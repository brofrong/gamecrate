// Замеры сессий в БД (спека 2026-10-29 «требования к железу», §1.3, §4): строка
// `session_metrics` по отчётам агента `SessionMetrics`.
import { Db, sessionMetrics, sessions, workers } from "@cg/db";
import type { AgentReport } from "@cg/rpc";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

type SessionMetricsReport = Extract<AgentReport, { _tag: "SessionMetrics" }>;

/**
 * Отчёт `SessionMetrics` воркера `workerId`: первый — вставка строки со снимком
 * сессии и воркера на этот момент (`app_id` из `sessions`, `gpu_name` —
 * `workers.hardware.gpus[0].name`, пусто без `hardware`; `worker_class_id`,
 * `slots`), следующие — замена ресурсных полей (агент шлёт накопленное
 * целиком). Снимок воркера и `game_end` (его пишет исход игры) не трогает.
 * Сессия не на этом воркере (или её нет) — отчёт игнорируется.
 */
export const upsertMetrics = (
  workerId: string,
  report: SessionMetricsReport,
  now: Date,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [owner] = yield* db
      .select({
        appId: sessions.appId,
        hardware: workers.hardware,
        classId: workers.classId,
        slots: workers.slots,
      })
      .from(sessions)
      .innerJoin(workers, eq(workers.id, sessions.workerId))
      .where(
        and(eq(sessions.id, report.sessionId), eq(sessions.workerId, workerId)),
      );
    if (owner === undefined) return;
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
      .values({
        sessionId: report.sessionId,
        appId: owner.appId,
        workerId,
        gpuName: owner.hardware?.gpus[0]?.name ?? "",
        workerClassId: owner.classId,
        slots: owner.slots,
        ...resources,
      })
      .onConflictDoUpdate({ target: sessionMetrics.sessionId, set: resources });
  });
