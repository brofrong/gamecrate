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
import { OWN_APP_ID_MIN } from "@cg/rpc";
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

/**
 * Сколько дней истории берут запросы норм: без этой границы `lead` требует
 * сканировать все замеры всех сессий/установок целиком (растёт без предела
 * с базой) — индекс `(stage, at desc)` всё равно не годится (нужны все
 * отметки сессии подряд), но хотя бы само сканируемое окно не растёт.
 */
const historyDays = 30;

/** Сколько живёт успешно посчитанная норма в кэше. */
const cacheMs = 60_000;

/**
 * Сколько живёт в кэше пустой результат после сбоя запроса: норма — лишь
 * украшение экрана загрузки, но без паузы повторный промах (следующий тик
 * любого `session.watch`) снова бил бы по той же, возможно ещё больной, БД.
 */
const failureCacheMs = 5_000;

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
 * computer`) как этап `total`. Длительность не бывает отрицательной (клиентские
 * часы здесь не участвуют, но `greatest(0, …)` на случай отметки назад во
 * времени — обратный шаг часов между отметками, отметка из ручной правки БД).
 * По каждому этапу — медиана и число последних `window` замеров этой игры
 * (`own_*`) и всех игр (`all_*`) не старше `historyDays`; «последние» — по
 * моменту отметки начала этапа. Свои игры (`app_id >= OWN_APP_ID_MIN`) в
 * общий пул не входят: у них другие этапы и времена (нет Steam), они
 * исказили бы норму Steam-игр; своя норма у такой игры считается как обычно.
 */
const launchQuery = (sql: Sql, appId: number) => sql<Row>`
  with marks as (
    select m.stage, m.at, s.app_id,
      lead(m.at) over (partition by m.session_id order by m.at) as next_at
    from session_stage_marks m
    join sessions s on s.id = m.session_id
    where m.at > now() - ${historyDays} * interval '1 day'
  ), samples as (
    select stage, at, app_id,
      greatest(0, extract(epoch from next_at - at)::float8 * 1000) as ms
    from marks
    where next_at is not null
    union all
    select ${total}, c.at, s.app_id,
      greatest(0, extract(epoch from v.at - c.at)::float8 * 1000)
    from session_stage_marks c
    join session_stage_marks v
      on v.session_id = c.session_id and v.stage = 'visible'
    join sessions s on s.id = c.session_id
    where c.stage = 'computer'
      and c.at > now() - ${historyDays} * interval '1 day'
  ), ranked as (
    select stage, ms, app_id = ${appId} as own,
      app_id < ${OWN_APP_ID_MIN} as pooled,
      row_number() over (
        partition by stage, app_id < ${OWN_APP_ID_MIN} order by at desc
      ) as all_rn,
      row_number() over (
        partition by stage, app_id = ${appId} order by at desc
      ) as own_rn
    from samples
  )
  select stage,
    (count(*) filter (where own and own_rn <= ${window}))::int as own_count,
    round(percentile_cont(0.5) within group (order by ms)
      filter (where own and own_rn <= ${window}))::int as own_ms,
    (count(*) filter (where pooled and all_rn <= ${window}))::int as all_count,
    round(percentile_cont(0.5) within group (order by ms)
      filter (where pooled and all_rn <= ${window}))::int as all_ms
  from ranked
  where (pooled and all_rn <= ${window}) or (own and own_rn <= ${window})
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
    where at > now() - ${historyDays} * interval '1 day'
  ), ranked as (
    select stage,
      greatest(0, extract(epoch from next_at - at)::float8 * 1000) as ms,
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

/** Нормы запуска (без установки) по одной игре. */
type LaunchNorms = Pick<StageNorms, "launch" | "launchTotal">;

const emptyLaunch: LaunchNorms = { launch: {}, launchTotal: null };
const emptyInstall: Partial<Record<InstallStage, number>> = {};

/** Нормы запуска игры `appId` из БД, без кэша. */
const computeLaunch = (appId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Сырой SQL — через PgClient под drizzle (`execute` drizzle 1.0 rc
    // типизирован массивом строк, а возвращает `{ rows }`).
    const rows = yield* launchQuery(db.$client, appId);
    const launch: Partial<Record<SessionStage, number>> = {};
    let launchTotal: number | null = null;
    for (const row of rows) {
      const norm = normOf(row);
      if (norm === null) continue;
      if (row.stage === total) launchTotal = norm;
      else if (isSessionStage(row.stage)) launch[row.stage] = norm;
    }
    return { launch, launchTotal } satisfies LaunchNorms;
  });

/**
 * Нормы установки из БД, без кэша. Игра здесь не участвует — установка не
 * знает своей нормы, норма у неё одна общая на все игры — поэтому, в отличие
 * от `computeLaunch`, этот запрос не нужно повторять на каждый `appId`.
 */
const computeInstall = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* installQuery(db.$client);
    const install: Partial<Record<InstallStage, number>> = {};
    for (const row of rows) {
      const norm = normOf(row);
      if (norm !== null && isInstallStage(row.stage)) install[row.stage] = norm;
    }
    return install;
  });

interface CacheEntry<A> {
  readonly until: number;
  readonly value: A;
}

/** Кэш норм запуска, по `appId` (своя норма игры зависит от игры). */
const launchCache = new Map<number, CacheEntry<LaunchNorms>>();

/** Кэш норм установки — одна запись на все игры. */
let installCache: CacheEntry<Partial<Record<InstallStage, number>>> | undefined;

/** Сбросить кэш норм (тесты: новая БД — новые нормы). */
export const clearCache = (): void => {
  launchCache.clear();
  installCache = undefined;
};

/**
 * Нормы запуска игры `appId` (правило — `normOf`), кэш в памяти на `cacheMs`:
 * одновременные промахи посчитают дважды — не страшно. Запрос к БД
 * (`computeLaunch`) не падает наружу: сбой — предупреждение в лог (без
 * секретов — таблицы замеров их не несут) и пустые нормы, закэшированные на
 * короткое `failureCacheMs`, чтобы не долбить упавшую БД на каждый следующий
 * тик `session.watch`. Норма — лишь украшение экрана загрузки (веб подставит
 * `STAGE_MS`), поэтому она никогда не должна валить `session.start`/`.watch`.
 */
const launchNormsFor = (
  appId: number,
  now: number,
): Effect.Effect<LaunchNorms, never, Db> =>
  Effect.gen(function* () {
    const hit = launchCache.get(appId);
    if (hit !== undefined && hit.until > now) return hit.value;
    const { value, ttl } = yield* computeLaunch(appId).pipe(
      Effect.map((value) => ({ value, ttl: cacheMs })),
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning("Launch stage norms query failed, using none", {
            appId,
            error: String(error),
          }),
          { value: emptyLaunch, ttl: failureCacheMs },
        ),
      ),
    );
    for (const [key, entry] of launchCache) {
      if (entry.until <= now) launchCache.delete(key);
    }
    launchCache.set(appId, { until: now + ttl, value });
    return value;
  });

/** Нормы установки (см. `launchNormsFor` — тот же кэш/сбой-фоллбэк, но без `appId`). */
const installNorms = (
  now: number,
): Effect.Effect<Partial<Record<InstallStage, number>>, never, Db> =>
  Effect.gen(function* () {
    if (installCache !== undefined && installCache.until > now)
      return installCache.value;
    const { value, ttl } = yield* computeInstall().pipe(
      Effect.map((value) => ({ value, ttl: cacheMs })),
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning("Install stage norms query failed, using none", {
            error: String(error),
          }),
          { value: emptyInstall, ttl: failureCacheMs },
        ),
      ),
    );
    installCache = { until: now + ttl, value };
    return value;
  });

/** Нормы этапов игры `appId` — запуска (по игре) и установки (общие для всех). */
export const normsFor = (appId: number): Effect.Effect<StageNorms, never, Db> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const launch = yield* launchNormsFor(appId, now);
    const install = yield* installNorms(now);
    return { ...launch, install } satisfies StageNorms;
  });
