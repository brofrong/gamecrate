// Допуск игры на воркер: классы воркеров, подходит ли железо, какие воркеры
// годятся игре для пользователя (спека §2.1–§2.3).
import type { WorkerHardware } from "@cg/rpc";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "./Db";
import { gameRequirements, workerClasses, workers } from "./schema";

/** Минимумы железа игры на слот (спека §1.2); `0` — «не важно». */
export type Requirements = {
  readonly minVramBytes: number;
  readonly minRamBytes: number;
  readonly minCpuThreads: number;
};

/**
 * Покрывает ли железо воркера требования игры на слот (спека §2.1). Нулевые
 * требования (игра без данных о VRAM/RAM/CPU — не путать с «нет строки в
 * `game_requirements`», это проверяет вызывающий код) проходят всегда, даже
 * без `hardware` (старый агент); иначе `hardware = null` не подходит. `slots
 * < 1` считается как `1` (защита от некорректных данных, не ожидается на
 * практике).
 */
export const fitsRequirements = (
  hardware: WorkerHardware | null,
  slots: number,
  req: Requirements,
): boolean => {
  const zero =
    req.minVramBytes === 0 && req.minRamBytes === 0 && req.minCpuThreads === 0;
  if (zero) return true;
  if (hardware === null) return false;
  const perSlot = slots < 1 ? 1 : slots;
  const vramBytes = hardware.gpus[0]?.memoryBytes ?? 0;
  return (
    vramBytes / perSlot >= req.minVramBytes &&
    hardware.memoryBytes / perSlot >= req.minRamBytes &&
    hardware.cpuThreads / perSlot >= req.minCpuThreads
  );
};

/** Класс воркера в порядке силы (`rank desc`): сильнейший первым. */
export type WorkerClassRow = { readonly id: string; readonly name: string; readonly rank: number };

/**
 * Классы, доступные пользователю (спека §2.4) — задел под тарифы: сейчас у
 * пользователя нет тарифа, поэтому возвращаются все классы по `rank desc`.
 * Когда появятся тарифы, здесь будет фильтр по классам тарифа пользователя —
 * планировщик и api, которые вызывают эту функцию, не изменятся.
 */
export const allowedClasses = (
  _userId: string,
): Effect.Effect<ReadonlyArray<WorkerClassRow>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .select({
        id: workerClasses.id,
        name: workerClasses.name,
        rank: workerClasses.rank,
      })
      .from(workerClasses)
      .orderBy(desc(workerClasses.rank));
  }).pipe(Effect.orDie);

/** Воркер, годный игре: `rank` его класса, свободные слоты не проверяются. */
export type EligibleWorker = {
  readonly id: string;
  readonly rank: number;
  readonly slots: number;
};

/**
 * Воркеры из `opts.workerIds`, которые годятся игре `appId` для пользователя
 * `userId` (спека §2.1–§2.3): не на обслуживании, класс — в `allowedClasses`,
 * железо подходит. Если у игры нет строки в `game_requirements` — только
 * воркеры самого сильного класса среди допустимых, у которого среди
 * `opts.workerIds` есть хоть один такой воркер (не на обслуживании); это
 * намеренно считается только по `opts.workerIds` (воркеры, которые сейчас
 * подключены/на связи у вызывающего кода), а не по всей таблице `workers` —
 * иначе отключённый мощный воркер держал бы игру недоступной сильным классам,
 * у которых есть кому её запустить прямо сейчас. Свободные слоты не
 * проверяет — это отдельная забота планировщика. Порядок: `rank desc, id asc`.
 */
export const eligibleWorkers = (
  userId: string,
  appId: number,
  opts: { readonly workerIds: ReadonlyArray<string> },
): Effect.Effect<ReadonlyArray<EligibleWorker>, never, Db> =>
  Effect.gen(function* () {
    if (opts.workerIds.length === 0) return [];
    const db = yield* Db;
    const allowed = yield* allowedClasses(userId);
    const allowedIds = allowed.map((c) => c.id);
    if (allowedIds.length === 0) return [];

    const candidates = yield* db
      .select({
        id: workers.id,
        slots: workers.slots,
        hardware: workers.hardware,
        rank: workerClasses.rank,
      })
      .from(workers)
      .innerJoin(workerClasses, eq(workers.classId, workerClasses.id))
      .where(
        and(
          inArray(workers.id, opts.workerIds),
          eq(workers.draining, false),
          inArray(workers.classId, allowedIds),
        ),
      );

    const [req] = yield* db
      .select({
        minVramBytes: gameRequirements.minVramBytes,
        minRamBytes: gameRequirements.minRamBytes,
        minCpuThreads: gameRequirements.minCpuThreads,
      })
      .from(gameRequirements)
      .where(eq(gameRequirements.appId, appId));

    const fitting = req
      ? candidates.filter((w) => fitsRequirements(w.hardware, w.slots, req))
      : strongestClassOnly(candidates);

    return fitting
      .map((w) => ({ id: w.id, rank: w.rank, slots: w.slots }))
      .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }).pipe(Effect.orDie);

/**
 * Игра без данных о требованиях (спека §2.3): только воркеры самого сильного
 * класса (наибольший `rank`) среди переданных.
 */
const strongestClassOnly = <W extends { readonly rank: number }>(
  candidates: ReadonlyArray<W>,
): ReadonlyArray<W> => {
  if (candidates.length === 0) return [];
  const strongestRank = candidates.reduce(
    (max, w) => (w.rank > max ? w.rank : max),
    candidates[0]!.rank,
  );
  return candidates.filter((w) => w.rank === strongestRank);
};
