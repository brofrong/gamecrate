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
 */
export const gamestoreApps = pgTable("gamestore_apps", {
  appId: integer("app_id")
    .primaryKey()
    .references(() => games.appId),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  buildId: text("build_id").notNull(),
  installedAt: timestamptz("installed_at").notNull().defaultNow(),
});

/** Состояния задачи установки. */
export const installJobStates = [
  "queued",
  "running",
  "done",
  "failed",
] as const;
export type InstallJobState = (typeof installJobStates)[number];

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
    bytesDownloaded: bigint("bytes_downloaded", { mode: "number" }),
    bytesTotal: bigint("bytes_total", { mode: "number" }),
    error: text("error"),
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
