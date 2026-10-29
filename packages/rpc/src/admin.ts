// Группа `admin.*`: только для роли admin.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  AgentRoles,
  WorkerHardware,
  WorkerStats,
  WorkerVersions,
} from "./agent";
import { AdminMiddleware, AuthMiddleware, Role } from "./auth";
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
  classId: Schema.NullOr(Schema.String),
  hardware: Schema.NullOr(WorkerHardware),
  versions: Schema.NullOr(WorkerVersions),
  stats: Schema.NullOr(WorkerStats),
  sessions: Schema.Array(AdminSession),
});
export type AdminWorker = typeof AdminWorker.Type;

/**
 * Класс воркера для админки (блок «Классы», спека §5.1). `rank` — сила
 * (больше — сильнее), список сортируется по нему; `workers` — сколько
 * воркеров сейчас у этого класса (запрет удаления, если не ноль).
 */
export const AdminWorkerClass = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rank: Schema.Int,
  workers: Schema.Int,
});
export type AdminWorkerClass = typeof AdminWorkerClass.Type;

/**
 * Игра общей библиотеки для админки (вкладка «Игры»). `installedAt` — когда
 * установилась (`gamestore_apps.installed_at`); `lastLaunchAt`/`launches` — по
 * сессиям этой игры, дошедшим до размещения на воркере (`worker_id is not
 * null`); `activeSessions` — сессии не `ended`/`failed` (включая ещё не
 * размещённые — `queued`/`installing`); `installing` — есть активная
 * (`queued`/`running`) задача установки; `deleting` — админ попросил удалить
 * (`deleting_at`), кнопка «Удалить» в этом состоянии уже неактивна.
 * `deleteError` — причина последнего неудачного удаления (русский текст
 * агента, без секретов), `null` — его не было или новый запрос уже её
 * очистил.
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
  deleteError: Schema.NullOr(Schema.String),
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

/**
 * Пользователь для админки (вкладка «Пользователи»). `email` — настоящий
 * (синтетический Steam/Telegram — `null`, см. `isSyntheticEmail`). `providers`
 * — алфавитный список `account.provider_id` (способы входа, без секретов —
 * ни refresh token, ни имя аккаунта здесь не отдаются). `steamId` — SteamID64,
 * у пользователей без Steam — `null`. `lastSessionAt` — `max(sessions.created_at)`.
 * `playedSeconds` — игровое время за всё время (billable и закрытые отрезки,
 * как в `TimeRepo`). `profileSizeBytes`/`profileVersion` — облачный профиль
 * (`profiles`), нет снимка — `null`. `blockedAt` — заблокирован
 * (`admin.users.setBlocked`); блокировка не запрещает вход на сайт, только
 * игровую сессию (`session.start` → `AccessDenied`). `steamLoginResetPending`
 * — админ попросил сбросить вход Steam в контейнере (`steam_login_reset_at`),
 * оркестратор это обработает (Task 3). `activeSession` — есть сессия под
 * `isActive`.
 */
export const AdminUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
  role: Role,
  providers: Schema.Array(Schema.String),
  steamId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastSessionAt: Schema.NullOr(Schema.String),
  playedSeconds: NonNegativeInt,
  profileSizeBytes: Schema.NullOr(Schema.Number),
  profileVersion: Schema.NullOr(Schema.Int),
  blockedAt: Schema.NullOr(Schema.String),
  steamLoginResetPending: Schema.Boolean,
  activeSession: Schema.Boolean,
});
export type AdminUser = typeof AdminUser.Type;

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

/**
 * Минимумы железа игры на слот (спека §1.2); `0` — «не важно». Зеркало
 * `Requirements` из `@cg/db` (тот же состав полей) — `rpc` не зависит от
 * `db`, поэтому схема заводится здесь отдельно, а не импортируется.
 */
export const Requirements = Schema.Struct({
  minVramBytes: Schema.Number,
  minRamBytes: Schema.Number,
  minCpuThreads: Schema.Int,
});
export type Requirements = typeof Requirements.Type;

/**
 * Замеры игры на одной модели GPU (вкладка «Игры» → игра, спека §5.2):
 * сессии дольше `MIN_GAME_SECONDS`, сгруппированные по `gpu_name`.
 * `className` — класс воркеров с этой картой (`mode()` по сессиям группы);
 * `*P95` — `percentile_cont(0.95)`, `null` — нет ни одного замера
 * (ресурс не снялся на всех сессиях группы). `crashShare`/`otherShare` —
 * доли `game_end = 'crash'` и `game_end in ('error', 'unknown')` от всех
 * сессий группы (0..1). `vramSources` — какие источники VRAM встретились
 * (`process`/`gpu_total`, см. §4.1). `perSlotVramBytes` — видеопамять этой
 * карты на слот (`workers.hardware.gpus[0].memoryBytes / slots`, максимум
 * по группе, если воркеров несколько); `null` — железо воркера неизвестно.
 */
export const AdminGameMetricsRow = Schema.Struct({
  gpuName: Schema.String,
  className: Schema.NullOr(Schema.String),
  sessions: Schema.Int,
  vramP95: Schema.NullOr(Schema.Number),
  ramP95: Schema.NullOr(Schema.Number),
  cpuP95: Schema.NullOr(Schema.Number),
  gpuUtilP95: Schema.NullOr(Schema.Number),
  crashShare: Schema.Number,
  otherShare: Schema.Number,
  vramSources: Schema.Array(Schema.Literals(["process", "gpu_total"])),
  perSlotVramBytes: Schema.NullOr(Schema.Number),
});
export type AdminGameMetricsRow = typeof AdminGameMetricsRow.Type;

/**
 * Требования и замеры игры целиком (панель на вкладке «Игры», спека §5.2).
 * `requirements` — текущая строка `game_requirements`, `null` — нет данных.
 * `rows` — замеры по моделям GPU. `overall` — те же p95, но по всем
 * сессиям игры вместе (основа предложения требований, см.
 * `requirementsSuggest.ts` на фронте).
 */
export const AdminGameRequirements = Schema.Struct({
  requirements: Schema.NullOr(Requirements),
  rows: Schema.Array(AdminGameMetricsRow),
  overall: Schema.Struct({
    sessions: Schema.Int,
    vramP95: Schema.NullOr(Schema.Number),
    ramP95: Schema.NullOr(Schema.Number),
    cpuP95: Schema.NullOr(Schema.Number),
  }),
});
export type AdminGameRequirements = typeof AdminGameRequirements.Type;

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
// `admin.games.requirements` — требования (`null` — нет строки) и замеры по
// моделям GPU + их сумма `overall` (сессии игры дольше `MIN_GAME_SECONDS`,
// спека §5.2). `admin.games.setRequirements` — сохранить или удалить
// (`requirements: null`) строку `game_requirements`; `updated_by` —
// текущий админ; всегда `true` (не проверяет, что игра существует).
// `admin.installs.list` — активные и недавние (7 дней, не больше 50) задачи
// установки. `admin.installs.cancel` — попросить отменить активную задачу
// (`"Установка отменена администратором"` — причина ждущим сессиям, ставит
// оркестратор); активная — `true`, иначе `false`.
// `admin.users.list` — все пользователи, новые сверху (`created_at desc`).
// `admin.users.setRole` — сменить роль; себе — `"self"` (роль не меняется),
// нет такого пользователя — `"notFound"`, иначе `"ok"`. `admin.users.setBlocked`
// — заблокировать/разблокировать; блокировка ещё и запрашивает остановку всех
// активных сессий пользователя (`stop_requested_at`, как `admin.sessions.stop`);
// себе — `"self"`, нет пользователя — `"notFound"`, иначе `"ok"`.
// `admin.users.resetSteamLogin` — попросить сбросить вход Steam в контейнере
// (не трогает `steam_id`/`account`, только отметку для оркестратора) — `true`,
// нет пользователя — `false`.
//
// `admin.classes.list` — классы воркеров по силе (`rank desc`, сильнейший
// сверху). `admin.classes.create` — новый класс самым слабым (`rank = min −
// 1`, пустой список классов → `1`); занятое имя — `"duplicate"`.
// `admin.classes.rename` — `"ok" | "duplicate" | "notFound"`.
// `admin.classes.move` — обменять `rank` с соседом в эту сторону (`"up"` —
// сильнее, `"down"` — слабее) одной транзакцией; крайний класс (нет соседа в
// эту сторону) — `"edge"`, нет класса — `"notFound"`, иначе `"ok"`.
// `admin.classes.delete` — у класса есть воркеры — `"inUse"`, нет класса —
// `"notFound"`, иначе `"ok"`. `admin.workers.setClass` — назначить класс
// воркеру (`null` — без класса, сессий не берёт); нет воркера — `false`.
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
  Rpc.make("admin.games.requirements", {
    payload: Schema.Struct({ appId: Schema.Int }),
    success: AdminGameRequirements,
  }),
  Rpc.make("admin.games.setRequirements", {
    payload: Schema.Struct({
      appId: Schema.Int,
      requirements: Schema.NullOr(Requirements),
    }),
    success: Schema.Boolean,
  }),
  Rpc.make("admin.installs.list", { success: AdminInstalls }),
  Rpc.make("admin.installs.cancel", {
    payload: Schema.Struct({ jobId: Schema.String }),
    success: Schema.Boolean,
  }),
  Rpc.make("admin.users.list", { success: Schema.Array(AdminUser) }),
  Rpc.make("admin.users.setRole", {
    payload: Schema.Struct({ userId: Schema.String, role: Role }),
    success: Schema.Literals(["ok", "self", "notFound"]),
  }),
  Rpc.make("admin.users.setBlocked", {
    payload: Schema.Struct({
      userId: Schema.String,
      blocked: Schema.Boolean,
    }),
    success: Schema.Literals(["ok", "self", "notFound"]),
  }),
  Rpc.make("admin.users.resetSteamLogin", {
    payload: Schema.Struct({ userId: Schema.String }),
    success: Schema.Boolean,
  }),
  Rpc.make("admin.classes.list", { success: Schema.Array(AdminWorkerClass) }),
  Rpc.make("admin.classes.create", {
    payload: Schema.Struct({ name: Schema.String }),
    success: Schema.Literals(["ok", "duplicate"]),
  }),
  Rpc.make("admin.classes.rename", {
    payload: Schema.Struct({ id: Schema.String, name: Schema.String }),
    success: Schema.Literals(["ok", "duplicate", "notFound"]),
  }),
  Rpc.make("admin.classes.move", {
    payload: Schema.Struct({
      id: Schema.String,
      direction: Schema.Literals(["up", "down"]),
    }),
    success: Schema.Literals(["ok", "edge", "notFound"]),
  }),
  Rpc.make("admin.classes.delete", {
    payload: Schema.Struct({ id: Schema.String }),
    success: Schema.Literals(["ok", "inUse", "notFound"]),
  }),
  Rpc.make("admin.workers.setClass", {
    payload: Schema.Struct({
      workerId: Schema.String,
      classId: Schema.NullOr(Schema.String),
    }),
    success: Schema.Boolean,
  }),
)
  .middleware(AdminMiddleware)
  .middleware(AuthMiddleware);
