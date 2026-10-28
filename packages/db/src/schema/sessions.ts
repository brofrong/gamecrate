// Сессии облачного гейминга: воркеры, сессии, игровые отрезки (биллинг) и настройки.
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { WorkerHardware, WorkerStats, WorkerVersions } from "@cg/rpc";
import { games } from "./library";
import { user } from "./auth";
import { installJobs } from "./gamestore";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

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
 * уже идущие не трогает — админка (Task 4/часть 2).
 */
export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  publicIp: text("public_ip").notNull(),
  slots: integer("slots").notNull(),
  roles: text("roles").array().notNull().default([]),
  draining: boolean("draining").notNull().default(false),
  hardware: jsonb("hardware").$type<WorkerHardware | null>(),
  versions: jsonb("versions").$type<WorkerVersions | null>(),
  stats: jsonb("stats").$type<WorkerStats | null>(),
  statsAt: timestamptz("stats_at"),
  lastSeenAt: timestamptz("last_seen_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
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
