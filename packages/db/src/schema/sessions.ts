// Сессии облачного гейминга: воркеры, сессии, игровые отрезки (биллинг) и настройки.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { WorkerHardware, WorkerStats, WorkerVersions } from "@cg/rpc";
import { games } from "./library";
import { user } from "./auth";
import { installJobs } from "./gamestore";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Класс воркера («Стандарт», «Быстрое», …) — упорядочен по силе (`rank`,
 * больше — сильнее); основа будущих тарифов (спека §1.1, §2.4). Миграция
 * заводит класс «Стандарт» (`rank = 1`) и назначает его всем существующим
 * воркерам.
 */
export const workerClasses = pgTable("worker_classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  rank: integer("rank").notNull().unique(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/**
 * Регион игровых серверов («Питер», «Москва») с коротким кодом (`spb`,
 * `msk`) для выбора по пингу (спека §6). `position` — порядок в админке и
 * запасной порядок выбора, когда замер пинга не удался; задаётся админом,
 * БД сама не переставляет.
 */
export const regions = pgTable("regions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** Состояния сессии (точные строки по спеке). Активная сессия — не `ended`/`failed`. */
export const sessionStates = [
  "queued",
  "installing",
  "starting",
  "playing",
  "idle_warning",
  "disconnected",
  "stopping",
  "ended",
  "failed",
] as const;
export type SessionState = (typeof sessionStates)[number];

/**
 * Этапы запуска контейнера сессии до появления игрового окна (экран загрузки),
 * см. `SessionStage` в `@cg/rpc`.
 */
export const sessionStages = [
  "computer",
  "steam",
  "login",
  "prepare",
  "loading",
  "visible",
] as const;
export type SessionStage = (typeof sessionStages)[number];

/**
 * Воркер (GPU-хост). `id` — имя воркера из конфига агента, не генерируется БД.
 * `roles`/`hardware`/`versions` — снимок из `agent.connect` (хаб пишет при
 * каждом подключении; `hardware`/`versions` — `null`, если агент их не
 * прислал). `stats`/`statsAt` — последний отчёт `WorkerStats` (раз в ~5 с,
 * без истории); `statsAt is null` — отчёта ещё не было. `draining` — воркер
 * не берёт новые сессии/установки (`Scheduler.placeOne`, `InstallRepo.claimNext`),
 * уже идущие не трогает — админка (Task 4/часть 2). `classId` — класс воркера
 * (спека §1.1); `null` — воркер без класса сессий не берёт, как `draining`.
 * `regionId` — регион воркера (спека §6); `null` — воркер ещё не привязан к
 * региону. В первой части размещение регион не учитывает (сессии берёт и
 * сервер без региона); выбор региона и фильтр по нему — вторая часть.
 */
export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  publicIp: text("public_ip").notNull(),
  slots: integer("slots").notNull(),
  roles: text("roles").array().notNull().default([]),
  draining: boolean("draining").notNull().default(false),
  classId: uuid("class_id").references(() => workerClasses.id, {
    onDelete: "restrict",
  }),
  regionId: uuid("region_id").references(() => regions.id, {
    onDelete: "restrict",
  }),
  hardware: jsonb("hardware").$type<WorkerHardware | null>(),
  versions: jsonb("versions").$type<WorkerVersions | null>(),
  stats: jsonb("stats").$type<WorkerStats | null>(),
  statsAt: timestamptz("stats_at"),
  lastSeenAt: timestamptz("last_seen_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/**
 * Учётные данные сервера (спека §3): по одной строке на воркер, заводит
 * админка вместе с записью `workers` (Task 2 — RPC админки). Одноразовый код
 * подключения (`enrollCodeHash`, живёт 24 часа — `enrollExpiresAt`) скрипт
 * установки меняет на постоянный токен (`tokenHash`, `tokenIssuedAt`);
 * оркестратор сверяет `Authorization: Bearer` с хэшем токена и `workerId` —
 * с владельцем (Task 3 — аутентификация агента). `revokedAt` — админ отозвал
 * токен, оркестратор рвёт соединение этого воркера; новый код подключения
 * выпускается отдельно. Хэши — `sha256Hex` (`workerTokens.ts`), секрет в
 * базе не хранится в открытом виде.
 */
export const workerCredentials = pgTable("worker_credentials", {
  workerId: text("worker_id")
    .primaryKey()
    .references(() => workers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").unique(),
  enrollCodeHash: text("enroll_code_hash").unique(),
  enrollExpiresAt: timestamptz("enroll_expires_at"),
  tokenIssuedAt: timestamptz("token_issued_at"),
  revokedAt: timestamptz("revoked_at"),
});

/**
 * Игровая сессия. `id` — uuid, генерируется приложением. Частичные уникальные
 * индексы гарантируют: одна активная сессия на пользователя, один удерживаемый
 * слот на воркере (`slot_released_at is null` — слот ещё не выпущен, см.
 * `slotReleasedAt`; не то же самое, что активное состояние строки, — контейнер
 * может работать и после того, как сессия стала `ended`/`failed`). Триггеры на
 * `session_changed_notify` (ручные миграции) шлют `pg_notify('session_changed',
 * NEW.id)` при INSERT и при UPDATE, который меняет
 * state/state_since/stream_url/fail_reason/stop_requested_at/worker_id/
 * slot/ended_at/stage; heartbeat'ы (client_seen_at, last_input_at, agent_seen_at)
 * и slot_released_at — нет (выпуск слота сайту не виден).
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    appId: integer("app_id")
      .notNull()
      .references(() => games.appId),
    state: text("state", { enum: sessionStates }).notNull().default("queued"),
    workerId: text("worker_id").references(() => workers.id),
    slot: integer("slot"),
    // Активная задача установки игры в `installing` (Task 5); id не очищается
    // после установки — последняя задача сессии остаётся для истории.
    installJobId: text("install_job_id").references(() => installJobs.id),
    // Этап запуска до появления игрового окна (экран загрузки, Task 2); null —
    // агент о нём ещё не отчитался или сессия уже дальше stage'ей.
    stage: text("stage", { enum: sessionStages }),
    // Внутренний адрес Selkies в сети cg-sessions, напр. http://cg-session-<id>:8080.
    streamUrl: text("stream_url"),
    failReason: text("fail_reason"),
    clientSeenAt: timestamptz("client_seen_at"),
    lastInputAt: timestamptz("last_input_at"),
    agentSeenAt: timestamptz("agent_seen_at"),
    stopRequestedAt: timestamptz("stop_requested_at"),
    stateSince: timestamptz("state_since").notNull().defaultNow(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
    // Контейнер на воркере остановлен и слот свободен: `null` — слот
    // может быть занят, даже если `state` уже `ended`/`failed` (агент мог ещё
    // не отчитаться о выгрузке контейнера). Выставляется `SessionRepo.releaseSlot`
    // (отчёт `Stopped`/`Failed` владеющего воркера) и `releaseStaleSlots`
    // (сверка при переподключении агента).
    slotReleasedAt: timestamptz("slot_released_at"),
  },
  (t) => [
    uniqueIndex("sessions_active_user_idx")
      .on(t.userId)
      .where(sql`${t.state} not in ('ended', 'failed')`),
    uniqueIndex("sessions_held_worker_slot_idx")
      .on(t.workerId, t.slot)
      .where(sql`${t.slotReleasedAt} is null`),
  ],
);

/**
 * Отметка начала каждого этапа запуска сессии (`sessions.stage`,
 * `SessionRepo.setStage`) — для статистики «сколько обычно занимает этап» на
 * экране загрузки (Task 4). Одна отметка на сессию и этап (PK); пишется
 * оркестратором в той же транзакции, что и переход `stage`, и только когда
 * тот реально сменился (`forwardOnly` + `returning` в `setStage`). `at` —
 * момент оркестратора на момент отчёта (`DateTime.nowAsDate`), а не время
 * вставки строки.
 */
export const sessionStageMarks = pgTable(
  "session_stage_marks",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    stage: text("stage", { enum: sessionStages }).notNull(),
    at: timestamptz("at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.stage] }),
    index("session_stage_marks_stage_at_idx").on(t.stage, t.at.desc()),
  ],
);

/**
 * Отрезок игрового времени для биллинга. `endedAt` при открытии равен
 * `startedAt` и продлевается heartbeat'ом; `billable` — отрезок считается
 * игровым временем (не ожиданием/запуском/простоем без возврата). Не более
 * одного открытого (`open = true`) отрезка на сессию — частичный уникальный индекс.
 */
export const playSegments = pgTable(
  "play_segments",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    appId: integer("app_id")
      .notNull()
      .references(() => games.appId),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at").notNull().defaultNow(),
    billable: boolean("billable").notNull(),
    open: boolean("open").notNull().default(true),
  },
  (t) => [
    uniqueIndex("play_segments_open_session_idx")
      .on(t.sessionId)
      .where(sql`${t.open} = true`),
    // Когда игрок играл в последний раз (`SessionView.previousPlayedAt`, перечитывается
    // каждым `session.watch`) — без полного прохода по отрезкам всех игроков.
    index("play_segments_user_ended_idx").on(t.userId, t.endedAt),
  ],
);

/** Настройки приложения в виде JSON по ключу (сейчас — только `"session"`). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Настройки стрима каждого пользователя (качество, битрейт, разрешение, отладка,
 * «меню уже открывали» — `StreamSettings` в `@cg/rpc`, спека §4): следующая игра на
 * любом устройстве открывается с ними. Отдельная таблица, не колонки `user`.
 */
export const userStreamSettings = pgTable("user_stream_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  value: jsonb("value").notNull(),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Чем закончилась игра (спека §4.2); `null` — сессия ещё не закончилась. */
export const gameEnds = [
  "quit",
  "crash",
  "error",
  "stopped",
  "unknown",
] as const;
export type GameEnd = (typeof gameEnds)[number];

/**
 * Замеры сессии (спека §1.3, §4): одна строка на сессию, пишет оркестратор по
 * отчёту агента `SessionMetrics` (upsert). `appId`/`workerId`/`gpuName`/
 * `workerClassId`/`slots` — снимок на момент сессии (копии для выборок и для
 * истории, если воркер/класс/игра поменяются позже). `null` в пиковых
 * ресурсах — замер не удался.
 */
export const sessionMetrics = pgTable("session_metrics", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  appId: integer("app_id").notNull(),
  workerId: text("worker_id").notNull(),
  gpuName: text("gpu_name").notNull(),
  workerClassId: uuid("worker_class_id"),
  slots: integer("slots").notNull(),
  gameSeconds: integer("game_seconds").notNull(),
  peakVramBytes: bigint("peak_vram_bytes", { mode: "number" }),
  peakRamBytes: bigint("peak_ram_bytes", { mode: "number" }),
  cpuCoresP95: real("cpu_cores_p95"),
  gpuUtilP95: real("gpu_util_p95"),
  vramSource: text("vram_source").notNull(),
  gameEnd: text("game_end", { enum: gameEnds }),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
