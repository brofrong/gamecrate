// Нормы этапов экрана загрузки («обычно ~N», спека 2026-10-29-launch-timers §2
// «Норма этапа»): медианы длительностей этапов по отметкам `session_stage_marks`
// и `install_stage_marks`, с кэшем в памяти — `session.watch` перечитывает
// сессию каждые ~5 с на игрока.
import {
  type Database,
  Db,
  type InstallStage,
  installStages,
  type SessionStage,
  sessionStages,
} from "@cg/db";
import { Clock, Effect } from "effect";

/** PgClient под drizzle: его шаблон `sql` — параметризованный запрос. */
type Sql = Database["$client"];

/**
 * Нормы этапов, мс. Этапа нет в записи — норму не набрать (меньше
 * `minSamples` замеров и у игры, и у всех игр): веб подставит свою
 * ориентировочную (`STAGE_MS`). `launchTotal` — норма всего запуска
 * (`computer` → `visible`); у `downloading` нормы нет никогда (там процент).
 */
export type StageNorms = {
  readonly launch: Partial<Record<SessionStage, number>>;
  readonly launchTotal: number | null;
  readonly install: Partial<Record<InstallStage, number>>;
};

/** Сколько последних замеров этапа берётся в медиану (норма следует за ускорениями). */
const window = 50;

/** Меньше замеров — медиана случайна: у игры — берём общую, у всех — нормы нет. */
const minSamples = 5;

/** Сколько живёт норма игры в кэше. */
const cacheMs = 60_000;

/** Псевдоэтап «весь запуск» в выборке запуска (`visible − computer`). */
const total = "total";

type Row = {
  readonly stage: string;
  readonly own_count: number;
  readonly own_ms: number | null;
  readonly all_count: number;
  readonly all_ms: number | null;
};

/**
 * Замеры запуска: длительность этапа = следующая отметка той же сессии −
 * отметка этапа (`lead`, только где следующая есть: упавший посреди этапа
 * запуск не замер, пропущенный агентом этап — тоже, а предыдущий длится до
 * следующей пришедшей отметки); плюс замеры всего запуска (`visible −
 * computer`) как этап `total`. По каждому этапу — медиана и число последних
 * `window` замеров этой игры (`own_*`) и всех игр (`all_*`); «последние» — по
 * моменту отметки начала этапа.
 */
const launchQuery = (sql: Sql, appId: number) => sql<Row>`
  with marks as (
    select m.stage, m.at, s.app_id,
      lead(m.at) over (partition by m.session_id order by m.at) as next_at
    from session_stage_marks m
    join sessions s on s.id = m.session_id
  ), samples as (
    select stage, at, app_id,
      extract(epoch from next_at - at)::float8 * 1000 as ms
    from marks
    where next_at is not null
    union all
    select ${total}, c.at, s.app_id,
      extract(epoch from v.at - c.at)::float8 * 1000
    from session_stage_marks c
    join session_stage_marks v
      on v.session_id = c.session_id and v.stage = 'visible'
    join sessions s on s.id = c.session_id
    where c.stage = 'computer'
  ), ranked as (
    select stage, ms, app_id = ${appId} as own,
      row_number() over (partition by stage order by at desc) as all_rn,
      row_number() over (
        partition by stage, app_id = ${appId} order by at desc
      ) as own_rn
    from samples
  )
  select stage,
    (count(*) filter (where own and own_rn <= ${window}))::int as own_count,
    round(percentile_cont(0.5) within group (order by ms)
      filter (where own and own_rn <= ${window}))::int as own_ms,
    (count(*) filter (where all_rn <= ${window}))::int as all_count,
    round(percentile_cont(0.5) within group (order by ms)
      filter (where all_rn <= ${window}))::int as all_ms
  from ranked
  where all_rn <= ${window} or (own and own_rn <= ${window})
  group by stage`;

/**
 * Замеры установки — как у запуска, но только по всем играм (своей нормы у
 * игры не набрать: ставится один раз) и без `downloading`.
 */
const installQuery = (sql: Sql) => sql<Row>`
  with marks as (
    select stage, at,
      lead(at) over (partition by job_id order by at) as next_at
    from install_stage_marks
  ), ranked as (
    select stage, extract(epoch from next_at - at)::float8 * 1000 as ms,
      row_number() over (partition by stage order by at desc) as all_rn
    from marks
    where next_at is not null and stage <> 'downloading'
  )
  select stage, 0 as own_count, null::int as own_ms,
    count(*)::int as all_count,
    round(percentile_cont(0.5) within group (order by ms))::int as all_ms
  from ranked
  where all_rn <= ${window}
  group by stage`;

/** Норма по правилу: своя от `minSamples` замеров, иначе общая от `minSamples`, иначе нет. */
const normOf = (row: Row): number | null => {
  if (row.own_count >= minSamples && row.own_ms !== null) return row.own_ms;
  if (row.all_count >= minSamples && row.all_ms !== null) return row.all_ms;
  return null;
};

const isSessionStage = (stage: string): stage is SessionStage =>
  (sessionStages as ReadonlyArray<string>).includes(stage);

const isInstallStage = (stage: string): stage is InstallStage =>
  (installStages as ReadonlyArray<string>).includes(stage);

/** Нормы игры из БД, без кэша. */
const compute = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Сырой SQL — через PgClient под drizzle (`execute` drizzle 1.0 rc
    // типизирован массивом строк, а возвращает `{ rows }`).
    const launchRows = yield* launchQuery(db.$client, appId);
    const installRows = yield* installQuery(db.$client);
    const launch: Partial<Record<SessionStage, number>> = {};
    let launchTotal: number | null = null;
    for (const row of launchRows) {
      const norm = normOf(row);
      if (norm === null) continue;
      if (row.stage === total) launchTotal = norm;
      else if (isSessionStage(row.stage)) launch[row.stage] = norm;
    }
    const install: Partial<Record<InstallStage, number>> = {};
    for (const row of installRows) {
      const norm = normOf(row);
      if (norm !== null && isInstallStage(row.stage)) install[row.stage] = norm;
    }
    return { launch, launchTotal, install } satisfies StageNorms;
  });

const cache = new Map<number, { readonly until: number; norms: StageNorms }>();

/** Сбросить кэш норм (тесты: новая БД — новые нормы). */
export const clearCache = (): void => cache.clear();

/**
 * Нормы этапов игры `appId` (правило — `normOf`), кэш в памяти на `cacheMs`
 * по `appId`: одновременные промахи посчитают дважды — не страшно.
 */
export const normsFor = (appId: number): Effect.Effect<StageNorms, never, Db> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const hit = cache.get(appId);
    if (hit !== undefined && hit.until > now) return hit.norms;
    const norms = yield* compute(appId);
    for (const [key, entry] of cache) {
      if (entry.until <= now) cache.delete(key);
    }
    cache.set(appId, { until: now + cacheMs, norms });
    return norms;
  }).pipe(Effect.orDie);
