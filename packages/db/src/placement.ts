// Допуск игры на воркер: классы воркеров, подходит ли железо, какие воркеры
// годятся игре для пользователя (спека §2.1–§2.3), для Steam-игр — собран ли
// на воркере шаблон клиента Steam (спека 2026-11-09 §5), а для своих игр —
// есть ли на воркере активный пакет («Свои игры», спека 2026-11-03).
import {
  isOwnAppId,
  type OwnGamePackage,
  type WorkerHardware,
  type WorkerStats,
  type WorkerVersions,
} from "@cg/rpc";
import { and, arrayContains, desc, eq, gte, inArray, or } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "./Db";
import { gameRequirements, ownGames, workerClasses, workers } from "./schema";

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

/**
 * Раскатан ли на воркере активный пакет своей игры (`pkg.slug`/`pkg.version`
 * строки `own_games`): ищет точное совпадение в `WorkerStats.ownGames`
 * (`stats = null` или без поля — ничего не раскатано, не годится). Старая
 * версия пакета на воркере не подходит — игра не запустится другим пакетом.
 */
export const hasPackage = (
  stats: WorkerStats | null,
  pkg: OwnGamePackage,
): boolean =>
  (stats?.ownGames ?? []).some(
    (p) => p.slug === pkg.slug && p.version === pkg.version,
  );

/**
 * Собран ли на воркере шаблон клиента Steam (`steamClientBuiltAt` из
 * `agent.connect`, спека 2026-11-09 §5): `versions = null` (агент ещё не
 * подключался) или `steamClientBuiltAt = null` — не собран, Steam-игры там
 * не запустить и не поставить.
 */
export const hasSteamClient = (versions: WorkerVersions | null): boolean =>
  (versions?.steamClientBuiltAt ?? null) !== null;

/** Класс воркера в порядке силы (`rank desc`): сильнейший первым. */
export type WorkerClassRow = {
  readonly id: string;
  readonly name: string;
  readonly rank: number;
};

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
 *
 * Для своих игр (`isOwnAppId(appId)`, спека 2026-11-03 «Свои игры»): нет
 * строки `own_games` для этого `appId` — игра недопустима нигде (`[]`),
 * иначе кандидаты дополнительно фильтруются `hasPackage` — нужен именно
 * активный пакет (`own_games.slug`/`version`) в `WorkerStats.ownGames`
 * воркера, старая версия на диске не годится.
 *
 * Для Steam-игр кандидат должен иметь собранный шаблон клиента Steam
 * (`workers.versions.steamClientBuiltAt` не `null`, спека 2026-11-09 §5):
 * шаблон у каждого сервера свой, без него ни сессию, ни установку там не
 * запустить; `versions = null` (агент ещё не подключался) — тоже не годится.
 * Своим играм клиент Steam не нужен, для них это не проверяется.
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

    let ownGamePackage: { slug: string; version: string } | undefined;
    if (isOwnAppId(appId)) {
      const [row] = yield* db
        .select({ slug: ownGames.slug, version: ownGames.version })
        .from(ownGames)
        .where(eq(ownGames.appId, appId));
      if (!row) return [];
      ownGamePackage = row;
    }

    const candidates = yield* db
      .select({
        id: workers.id,
        slots: workers.slots,
        hardware: workers.hardware,
        stats: workers.stats,
        versions: workers.versions,
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

    const withPackage = ownGamePackage
      ? candidates.filter((w) => hasPackage(w.stats, ownGamePackage!))
      : candidates.filter((w) => hasSteamClient(w.versions));

    const [req] = yield* db
      .select({
        minVramBytes: gameRequirements.minVramBytes,
        minRamBytes: gameRequirements.minRamBytes,
        minCpuThreads: gameRequirements.minCpuThreads,
      })
      .from(gameRequirements)
      .where(eq(gameRequirements.appId, appId));

    const fitting = req
      ? withPackage.filter((w) => fitsRequirements(w.hardware, w.slots, req))
      : strongestClassOnly(withPackage);

    return fitting
      .map((w) => ({ id: w.id, rank: w.rank, slots: w.slots }))
      .sort(
        (a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }).pipe(Effect.orDie);

/**
 * «Недавно был на связи» — порог давности `last_seen_at`/`stats_at` воркера
 * для расчёта «недоступна» (спека §3): перезапуск агента при деплое не должен
 * на несколько секунд пометить игру недоступной.
 */
export const WORKER_RECENT_MS = 10 * 60 * 1000;

/**
 * Доступна ли игра пользователю прямо сейчас (спека §3): среди воркеров с
 * ролью `worker` (планировщик размещает сессии только на них; агент с одной
 * ролью `gamestore` игру не запустит), которые подключены или были на связи
 * за последние `WORKER_RECENT_MS`
 * (`last_seen_at` хаба или `stats_at` монитора — хватает любого из двух; по
 * этим полям, не зная о текущей сетевой подключённости), есть хотя бы один,
 * который годится игре для пользователя (`eligibleWorkers`, §2.1–§2.3, для
 * Steam-игры — с собранным клиентом Steam; без проверки свободного слота — «все подходящие заняты» не значит «недоступна»,
 * это забота планировщика).
 */
export const gameAvailable = (
  userId: string,
  appId: number,
  now: Date,
): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const threshold = new Date(now.getTime() - WORKER_RECENT_MS);
    const recent = yield* db
      .select({ id: workers.id })
      .from(workers)
      .where(
        and(
          arrayContains(workers.roles, ["worker"]),
          or(
            gte(workers.lastSeenAt, threshold),
            gte(workers.statsAt, threshold),
          ),
        ),
      );
    if (recent.length === 0) return false;
    const eligible = yield* eligibleWorkers(userId, appId, {
      workerIds: recent.map((w) => w.id),
    });
    return eligible.length > 0;
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
