// Общая библиотека установленных игр, очередь установок и профили пользователей
// в RustFS (план MVP-3).
import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { games } from "./library";
import { user } from "./auth";
import { workers } from "./sessions";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Установленная сборка игры в общей библиотеке (`LIBRARY_DIR/steamapps`).
 * Строка есть ⇔ игра в библиотеке. `buildId` — установленный Steam buildid,
 * `sizeBytes` — размер на диске (из манифеста после установки).
 * `deletingAt` — админ удаляет игру: строка живёт до итога агента
 * (`GameDeleted` удаляет её, `GameDeleteFailed` снимает пометку); пока пометка
 * есть, игра не запускается и не ставится — сессии ждут в очереди.
 */
export const gamestoreApps = pgTable("gamestore_apps", {
  appId: integer("app_id")
    .primaryKey()
    .references(() => games.appId),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  buildId: text("build_id").notNull(),
  installedAt: timestamptz("installed_at").notNull().defaultNow(),
  deletingAt: timestamptz("deleting_at"),
});

/** Состояния задачи установки. */
export const installJobStates = [
  "queued",
  "running",
  "done",
  "failed",
] as const;
export type InstallJobState = (typeof installJobStates)[number];

/** Этапы задачи установки, см. `InstallStage` в `@cg/rpc`. */
export const installStages = [
  "preparing",
  "login",
  "library",
  "downloading",
  "moving",
] as const;
export type InstallStage = (typeof installStages)[number];

/**
 * Задача установки игры в общую библиотеку. `userId` — чьим Steam-клиентом
 * качаем (нужен владеющий игрой аккаунт), `workerId` — агент с ролью
 * `gamestore`, который её выполняет. Частичный уникальный индекс гарантирует
 * не более одной активной (`queued`/`running`) задачи на `appId` — сессии,
 * ждущие ту же игру, присоединяются к уже идущей задаче (Task 5).
 */
export const installJobs = pgTable(
  "install_jobs",
  {
    id: text("id").primaryKey(),
    appId: integer("app_id")
      .notNull()
      .references(() => games.appId),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    state: text("state", { enum: installJobStates })
      .notNull()
      .default("queued"),
    workerId: text("worker_id").references(() => workers.id),
    // Этап установки (экран загрузки, Task 2); null — агент о нём не отчитался.
    stage: text("stage", { enum: installStages }),
    bytesDownloaded: bigint("bytes_downloaded", { mode: "number" }),
    bytesTotal: bigint("bytes_total", { mode: "number" }),
    error: text("error"),
    // Админ отменил задачу: `queued` проваливается сразу, `running` — по
    // итогу агента после CancelInstall (`InstallFinished` всё равно — `done`).
    cancelRequestedAt: timestamptz("cancel_requested_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("install_jobs_active_app_idx")
      .on(t.appId)
      .where(sql`${t.state} in ('queued', 'running')`),
  ],
);

/**
 * Облачный профиль пользователя (сохранения и настройки Steam) — ровно один
 * объект на пользователя в бакете `S3_BUCKET`; `version` растёт на каждую
 * принятую выгрузку (`agent.profileCommit`), выгрузка с устаревшей базовой
 * версией отклоняется (спека §6). `objectKey` — `profiles/<userId>/<uuid>.cgp`.
 */
export const profiles = pgTable("profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  objectKey: text("object_key").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Состояния попытки входа в Steam по QR на сайте (спека §4). */
export const steamLoginStates = [
  "pending",
  "waiting",
  "scanned",
  "done",
  "expired",
  "failed",
  "cancelled",
] as const;
export type SteamLoginState = (typeof steamLoginStates)[number];

/**
 * Попытка входа в Steam по QR на сайте (спека §4): API заводит строку
 * (`steamLogin.start`), оркестратор проводит QR-вход steam-session (пишет сюда
 * `qrUrl` и исход) и привязывает Steam к аккаунту, сайт опрашивает статус;
 * полученный вход вписывается в следующий контейнер пользователя. Частичный
 * уникальный индекс гарантирует не более одной активной попытки
 * (`pending`/`waiting`/`scanned`) на пользователя — новая попытка требует
 * сначала завершить (отменить) прежнюю, а не плодит параллельные строки. `done`/`expired`/`failed`/`cancelled` —
 * терминальные, не мешают следующей попытке.
 */
export const steamLogins = pgTable(
  "steam_logins",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    state: text("state", { enum: steamLoginStates })
      .notNull()
      .default("pending"),
    qrUrl: text("qr_url"),
    error: text("error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("steam_logins_active_user_idx")
      .on(t.userId)
      .where(sql`${t.state} in ('pending', 'waiting', 'scanned')`),
  ],
);
