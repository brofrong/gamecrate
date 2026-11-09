// Библиотека установленных игр каждого сервера, очередь установок и профили
// пользователей в RustFS (план MVP-3; своя библиотека на сервер — спека §5).
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { games } from "./library";
import { user } from "./auth";
import { workers } from "./sessions";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Установленная сборка игры в библиотеке сервера (`LIBRARY_DIR/steamapps`
 * воркера `workerId`) — у каждого игрового сервера своя библиотека, общей
 * ФС между городами не будет (спека §5). Строка есть ⇔ игра стоит на этом
 * сервере; PK `(workerId, appId)` — та же игра может стоять на нескольких
 * серверах отдельными строками. `buildId` — установленный Steam buildid,
 * `sizeBytes` — размер на диске (из манифеста после установки).
 * `deletingAt` — админ удаляет игру с этого сервера: строка живёт до итога
 * агента (`GameDeleted` удаляет её, `GameDeleteFailed` снимает пометку);
 * пока пометка есть, игра на этом сервере не запускается и не ставится —
 * сессии ждут в очереди. `deleteError` — причина последнего
 * `GameDeleteFailed` (русский текст агента, см. `deleteReasons` в
 * `apps/agent/src/Installer.ts`), которую видит админ; новый запрос удаления
 * (`deleting_at`) сразу очищает его в том же `update`, итог `GameDeleted`
 * убирает строку целиком.
 */
export const gamestoreApps = pgTable(
  "gamestore_apps",
  {
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id),
    appId: integer("app_id")
      .notNull()
      .references(() => games.appId),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    buildId: text("build_id").notNull(),
    installedAt: timestamptz("installed_at").notNull().defaultNow(),
    deletingAt: timestamptz("deleting_at"),
    deleteError: text("delete_error"),
  },
  (t) => [
    primaryKey({ name: "gamestore_apps_pkey", columns: [t.workerId, t.appId] }),
  ],
);

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
 * Задача установки игры в библиотеку сервера. `userId` — чьим Steam-клиентом
 * качаем (нужен владеющий игрой аккаунт), `workerId` — агент с ролью
 * `gamestore`, который её выполняет (`null` — задача ещё не выдана агенту,
 * `claimNext` выбирает воркер и выставляет его). Частичный уникальный индекс
 * гарантирует не более одной активной (`queued`/`running`) задачи на пару
 * `(workerId, appId)` — сессии, ждущие ту же игру на том же сервере,
 * присоединяются к уже идущей задаче (Task 5).
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
    uniqueIndex("install_jobs_active_worker_app_idx")
      .on(t.workerId, t.appId)
      .where(sql`${t.state} in ('queued', 'running')`),
  ],
);

/**
 * Отметка начала каждого этапа установки (`install_jobs.stage`,
 * `InstallRepo.recordStage`) — для статистики «сколько обычно занимает этап»
 * на экране загрузки (Task 4), как `sessionStageMarks`. Одна отметка на
 * задачу и этап (PK); пишется в той же транзакции, что и переход `stage`, и
 * только когда тот реально сменился.
 */
export const installStageMarks = pgTable(
  "install_stage_marks",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => installJobs.id, { onDelete: "cascade" }),
    stage: text("stage", { enum: installStages }).notNull(),
    at: timestamptz("at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.stage] }),
    index("install_stage_marks_stage_at_idx").on(t.stage, t.at.desc()),
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

/**
 * Требования игры к железу на слот (спека §1.2): одна строка на игру, нет
 * строки — «данных нет» (§2.3). Все три минимума обязательны, «не важно» —
 * ноль. `updatedBy` — админ, который задал/правил значения; `null`, если его
 * аккаунт удалён.
 */
export const gameRequirements = pgTable("game_requirements", {
  appId: integer("app_id")
    .primaryKey()
    .references(() => games.appId),
  minVramBytes: bigint("min_vram_bytes", { mode: "number" }).notNull(),
  minRamBytes: bigint("min_ram_bytes", { mode: "number" }).notNull(),
  minCpuThreads: integer("min_cpu_threads").notNull(),
  updatedBy: text("updated_by").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Посеянный вход Steam пользователя (`SteamLoginSeeds` оркестратора): ждёт
 * следующего запуска сессии или установки, переживает перезапуск оркестратора.
 * Одна строка на пользователя. Имя аккаунта и refresh-токен — только в
 * `sealed`: base64 `iv(12) ‖ tag(16) ‖ AES-256-GCM(JSON {accountName,
 * refreshToken})` ключом `SEED_KEY`; в открытом виде — `steamId` (не секрет,
 * он же в `user.steam_id`) и время. `putAt` — момент посева (сравнивается со
 * сбросом входа админом), `expiresAt` — `putAt + SEED_TTL`.
 */
export const steamLoginSeeds = pgTable("steam_login_seeds", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  steamId: text("steam_id").notNull(),
  sealed: text("sealed").notNull(),
  putAt: timestamptz("put_at").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
});
