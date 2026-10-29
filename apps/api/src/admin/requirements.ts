// Требования игры к железу и замеры по моделям GPU для админки (страница игры,
// спека §5.2): три поля требований + таблица замеров, сгруппированная по
// `gpu_name` (p95 — `percentile_cont(0.95)` в SQL). Предложение требований и
// подсказки о падениях считаются на фронте из этих данных (`requirementsSuggest.ts`),
// здесь только числа.
import {
  Db,
  gameRequirements,
  sessionMetrics,
  workerClasses,
  workers,
} from "@cg/db";
import type {
  AdminGameMetricsRow,
  AdminGameRequirements,
  Requirements,
} from "@cg/rpc";
import { and, eq, gte, sql } from "drizzle-orm";
import { Effect } from "effect";

/** Сессия считается в замерах, только если игра шла не меньше этого (спека §5.2). */
export const MIN_GAME_SECONDS = 300;

/** Сколько сессий этой игры прошло и сколько p95 по всем GPU вместе (без группировки). */
const sessionsSql = sql<number>`count(*)::int`;
const vramP95Sql = sql<
  number | null
>`percentile_cont(0.95) within group (order by ${sessionMetrics.peakVramBytes})`;
const ramP95Sql = sql<
  number | null
>`percentile_cont(0.95) within group (order by ${sessionMetrics.peakRamBytes})`;
const cpuP95Sql = sql<
  number | null
>`percentile_cont(0.95) within group (order by ${sessionMetrics.cpuCoresP95})`;
const gpuUtilP95Sql = sql<
  number | null
>`percentile_cont(0.95) within group (order by ${sessionMetrics.gpuUtilP95})`;
/**
 * Доля сессий группы с нужным `game_end`: `count(*) filter`, а не `avg` по
 * булеву — `game_end is null` (ещё не известен) не должен выпадать из
 * знаменателя, а `avg` проигнорировал бы такие строки целиком.
 */
const crashShareSql = sql<number>`(count(*) filter (where ${sessionMetrics.gameEnd} = 'crash'))::float / count(*)`;
const otherShareSql = sql<number>`(count(*) filter (where ${sessionMetrics.gameEnd} in ('error', 'unknown')))::float / count(*)`;
/** Самый частый класс воркеров этой модели GPU среди сессий группы; нет класса у всех — `null`. */
const classNameSql = sql<
  string | null
>`mode() within group (order by ${workerClasses.name})`;

const qualifyingSessions = (appId: number) =>
  and(
    eq(sessionMetrics.appId, appId),
    gte(sessionMetrics.gameSeconds, MIN_GAME_SECONDS),
  );

/** Текущие требования игры (`null` — нет строки, «данных нет», спека §2.3). */
export const getRequirements = (
  appId: number,
): Effect.Effect<Requirements | null, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({
        minVramBytes: gameRequirements.minVramBytes,
        minRamBytes: gameRequirements.minRamBytes,
        minCpuThreads: gameRequirements.minCpuThreads,
      })
      .from(gameRequirements)
      .where(eq(gameRequirements.appId, appId));
    return row ?? null;
  }).pipe(Effect.orDie);

/**
 * Сохранить (`requirements` не `null`, upsert) или удалить (`requirements:
 * null`) строку `game_requirements`; `updatedBy` — текущий админ.
 */
export const setRequirements = (
  appId: number,
  updatedBy: string,
  requirements: Requirements | null,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    if (requirements === null) {
      yield* db
        .delete(gameRequirements)
        .where(eq(gameRequirements.appId, appId));
      return true;
    }
    yield* db
      .insert(gameRequirements)
      .values({ appId, ...requirements, updatedBy })
      .onConflictDoUpdate({
        target: gameRequirements.appId,
        set: { ...requirements, updatedBy, updatedAt: new Date() },
      });
    return true;
  }).pipe(Effect.orDie);

/**
 * Видеопамять на слот по модели GPU (спека §5.2): `workers.hardware.gpus[0].memoryBytes
 * / session_metrics.slots` для каждой сессии группы, максимум по группе (воркеры могли
 * заменить карту); нет ни одного известного железа в группе — `null`.
 */
const perSlotVramByGpu = (
  appId: number,
): Effect.Effect<ReadonlyMap<string, number | null>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select({
        gpuName: sessionMetrics.gpuName,
        slots: sessionMetrics.slots,
        hardware: workers.hardware,
      })
      .from(sessionMetrics)
      .innerJoin(workers, eq(workers.id, sessionMetrics.workerId))
      .where(qualifyingSessions(appId));

    const result = new Map<string, number | null>();
    for (const row of rows) {
      if (!result.has(row.gpuName)) result.set(row.gpuName, null);
      const vramBytes = row.hardware?.gpus[0]?.memoryBytes;
      if (vramBytes === undefined) continue;
      const perSlot = vramBytes / Math.max(1, row.slots);
      const current = result.get(row.gpuName) ?? null;
      if (current === null || perSlot > current)
        result.set(row.gpuName, perSlot);
    }
    return result;
  }).pipe(Effect.orDie);

/**
 * Требования и замеры игры (вкладка «Игры» → игра, спека §5.2): `rows` —
 * сгруппированные по `gpu_name` (только сессии дольше `MIN_GAME_SECONDS`),
 * `overall` — те же p95 по всем сессиям вместе, для предложения требований.
 */
export const adminGameRequirements = (
  appId: number,
): Effect.Effect<AdminGameRequirements, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const requirements = yield* getRequirements(appId);

    const groupedRows = yield* db
      .select({
        gpuName: sessionMetrics.gpuName,
        className: classNameSql,
        sessions: sessionsSql,
        vramP95: vramP95Sql,
        ramP95: ramP95Sql,
        cpuP95: cpuP95Sql,
        gpuUtilP95: gpuUtilP95Sql,
        crashShare: crashShareSql,
        otherShare: otherShareSql,
        vramSources: sql<
          Array<"process" | "gpu_total">
        >`array_agg(distinct ${sessionMetrics.vramSource})`,
      })
      .from(sessionMetrics)
      .leftJoin(
        workerClasses,
        eq(workerClasses.id, sessionMetrics.workerClassId),
      )
      .where(qualifyingSessions(appId))
      .groupBy(sessionMetrics.gpuName);

    const perSlot = yield* perSlotVramByGpu(appId);

    const rows: Array<AdminGameMetricsRow> = groupedRows.map((row) => ({
      gpuName: row.gpuName,
      className: row.className,
      sessions: row.sessions,
      vramP95: row.vramP95,
      ramP95: row.ramP95,
      cpuP95: row.cpuP95,
      gpuUtilP95: row.gpuUtilP95,
      crashShare: row.crashShare,
      otherShare: row.otherShare,
      vramSources: [...row.vramSources].sort(),
      perSlotVramBytes: perSlot.get(row.gpuName) ?? null,
    }));

    const [overallRow] = yield* db
      .select({
        sessions: sessionsSql,
        vramP95: vramP95Sql,
        ramP95: ramP95Sql,
        cpuP95: cpuP95Sql,
      })
      .from(sessionMetrics)
      .where(qualifyingSessions(appId));

    return {
      requirements,
      rows,
      overall: {
        sessions: overallRow?.sessions ?? 0,
        vramP95: overallRow?.vramP95 ?? null,
        ramP95: overallRow?.ramP95 ?? null,
        cpuP95: overallRow?.cpuP95 ?? null,
      },
    };
  }).pipe(Effect.orDie);
