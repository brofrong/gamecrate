// Группа `admin.*`: только для роли admin.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  AgentRoles,
  WorkerHardware,
  WorkerStats,
  WorkerVersions,
} from "./agent";
import { AdminMiddleware, AuthMiddleware } from "./auth";
import { InstallStage, SessionStage, SessionState } from "./session";
import { SessionSettings } from "./settings";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Воркер считается online, если снимок загрузки (`WorkerStats`) младше этого порога. */
export const WORKER_ONLINE_MS = 20_000;

/**
 * Сессия для админки (часть 1 — без биллинга/стримов, их есть `SessionView`).
 * `userName` — `user.name`; почту здесь не отдаём (спека, часть 1). `workerId`/
 * `slot` — `null`, пока не размещена на воркере. `endedAt`/`lastInputAt` —
 * `null`, пока не наступили.
 */
export const AdminSession = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  userName: Schema.String,
  appId: Schema.Int,
  gameName: Schema.String,
  workerId: Schema.NullOr(Schema.String),
  slot: Schema.NullOr(NonNegativeInt),
  state: SessionState,
  stage: Schema.NullOr(SessionStage),
  createdAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  lastInputAt: Schema.NullOr(Schema.String),
  failReason: Schema.NullOr(Schema.String),
});
export type AdminSession = typeof AdminSession.Type;

/**
 * Воркер для админки: снимок железа/версий/загрузки (`agent.connect`/`WorkerStats`)
 * и активные сессии на нём. `online` — пришёл свежий снимок загрузки
 * (`WORKER_ONLINE_MS`); `lastSeenAt` — `statsAt`, а если снимков не было —
 * `lastSeenAt` воркера (последнее подключение агента), иначе `null`.
 */
export const AdminWorker = Schema.Struct({
  id: Schema.String,
  publicIp: Schema.String,
  slots: Schema.Int,
  roles: AgentRoles,
  online: Schema.Boolean,
  lastSeenAt: Schema.NullOr(Schema.String),
  draining: Schema.Boolean,
  hardware: Schema.NullOr(WorkerHardware),
  versions: Schema.NullOr(WorkerVersions),
  stats: Schema.NullOr(WorkerStats),
  sessions: Schema.Array(AdminSession),
});
export type AdminWorker = typeof AdminWorker.Type;

/**
 * Игра общей библиотеки для админки (вкладка «Игры»). `installedAt` — когда
 * установилась (`gamestore_apps.installed_at`); `lastLaunchAt`/`launches` — по
 * сессиям этой игры, дошедшим до размещения на воркере (`worker_id is not
 * null`); `activeSessions` — сессии не `ended`/`failed` (включая ещё не
 * размещённые — `queued`/`installing`); `installing` — есть активная
 * (`queued`/`running`) задача установки; `deleting` — админ попросил удалить
 * (`deleting_at`), кнопка «Удалить» в этом состоянии уже неактивна.
 */
export const AdminGame = Schema.Struct({
  appId: Schema.Int,
  name: Schema.String,
  sizeBytes: Schema.Number,
  installedAt: Schema.String,
  lastLaunchAt: Schema.NullOr(Schema.String),
  launches: Schema.Int,
  activeSessions: Schema.Int,
  installing: Schema.Boolean,
  deleting: Schema.Boolean,
});
export type AdminGame = typeof AdminGame.Type;

/**
 * Игры общей библиотеки + служебные пакеты. `service` — часть библиотеки
 * воркера `gamestore`, которой нет в `gamestore_apps` (Proton, Steam Linux
 * Runtime и т. п.) — их показывают как «Служебные: …», но никогда не удаляют;
 * `null` — у воркера `gamestore` ещё нет снимка библиотеки (или такого
 * воркера нет вовсе).
 */
export const AdminGames = Schema.Struct({
  games: Schema.Array(AdminGame),
  service: Schema.NullOr(
    Schema.Struct({
      count: Schema.Int,
      sizeBytes: Schema.Number,
      names: Schema.Array(Schema.String),
    }),
  ),
});
export type AdminGames = typeof AdminGames.Type;

/** Состояние задачи установки, см. `installJobStates` в `@cg/db`. */
const InstallJobState = Schema.Literals([
  "queued",
  "running",
  "done",
  "failed",
]);

/**
 * Задача установки игры для админки (вкладка «Установки»). `workerId` — агент
 * `gamestore`, который её выполняет, `null` — ещё не выдана. `cancelRequested`
 * — админ попросил отменить (`cancel_requested_at`); `waitingSessions` —
 * сколько сессий её ждут (`installing` с этим `installJobId`).
 */
export const AdminInstall = Schema.Struct({
  id: Schema.String,
  appId: Schema.Int,
  gameName: Schema.String,
  userName: Schema.String,
  workerId: Schema.NullOr(Schema.String),
  state: InstallJobState,
  stage: Schema.NullOr(InstallStage),
  bytesDownloaded: Schema.NullOr(Schema.Number),
  bytesTotal: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  cancelRequested: Schema.Boolean,
  waitingSessions: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AdminInstall = typeof AdminInstall.Type;

/**
 * Активные и недавние задачи установки. `recent` — `done`/`failed` за 7 дней
 * по `updatedAt`, новые сверху, не больше 50 (как `AdminSession`/`recent`).
 */
export const AdminInstalls = Schema.Struct({
  active: Schema.Array(AdminInstall),
  recent: Schema.Array(AdminInstall),
});
export type AdminInstalls = typeof AdminInstalls.Type;

// Порядок важен: мидлвар, добавленный последним, выполняется первым —
// сначала AuthMiddleware кладёт CurrentUser, затем AdminMiddleware проверяет роль.
//
// `admin.settings.get` — настройки сессий (нет записи — значения по умолчанию);
// `admin.settings.update` — сохранить и вернуть сохранённое. Значения вне
// диапазонов `SessionSettings` отклоняются схемой.
//
// `admin.workers.list` — все воркеры по `id`, с активными сессиями на каждом.
// `admin.workers.setDraining` — включить/выключить обслуживание воркера (уже
// идущие сессии/установки не трогает); нет воркера — `false`.
// `admin.sessions.list` — активные и недавние (завершённые за 7 дней, новые
// сверху, не больше 50) сессии; `failedOnly` — показать только `failed`.
// `admin.sessions.stop` — попросить остановить любую сессию (без проверки
// владельца, как `session.stop`); существующая сессия (хоть активная, хоть уже
// завершённая) — `true`, неверный/неизвестный id — `false`.
// `admin.games.list` — игры общей библиотеки (по размеру убыв.) + служебные
// пакеты. `admin.games.delete` — пометить игру к удалению (её удалит
// оркестратор по `deleting_at`): `"started"`, занята активной сессией или
// установкой — `"inUse"`, нет такой игры в `gamestore_apps` — `"notFound"`.
// `admin.installs.list` — активные и недавние (7 дней, не больше 50) задачи
// установки. `admin.installs.cancel` — попросить отменить активную задачу
// (`"Установка отменена администратором"` — причина ждущим сессиям, ставит
// оркестратор); активная — `true`, иначе `false`.
export const AdminRpcs = RpcGroup.make(
  Rpc.make("admin.ping", { success: Schema.Literal("pong") }),
  Rpc.make("admin.settings.get", { success: SessionSettings }),
  Rpc.make("admin.settings.update", {
    payload: SessionSettings,
    success: SessionSettings,
  }),
  Rpc.make("admin.workers.list", { success: Schema.Array(AdminWorker) }),
  Rpc.make("admin.workers.setDraining", {
    payload: Schema.Struct({
      workerId: Schema.String,
      draining: Schema.Boolean,
    }),
    success: Schema.Boolean,
  }),
  Rpc.make("admin.sessions.list", {
    payload: Schema.Struct({ failedOnly: Schema.Boolean }),
    success: Schema.Struct({
      active: Schema.Array(AdminSession),
      recent: Schema.Array(AdminSession),
    }),
  }),
  Rpc.make("admin.sessions.stop", {
    payload: Schema.Struct({ sessionId: Schema.String }),
    success: Schema.Boolean,
  }),
  Rpc.make("admin.games.list", { success: AdminGames }),
  Rpc.make("admin.games.delete", {
    payload: Schema.Struct({ appId: Schema.Int }),
    success: Schema.Literals(["started", "inUse", "notFound"]),
  }),
  Rpc.make("admin.installs.list", { success: AdminInstalls }),
  Rpc.make("admin.installs.cancel", {
    payload: Schema.Struct({ jobId: Schema.String }),
    success: Schema.Boolean,
  }),
)
  .middleware(AdminMiddleware)
  .middleware(AuthMiddleware);
