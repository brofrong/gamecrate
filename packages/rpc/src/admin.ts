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
import { HourPack, HourPackInput, Tariff, TariffInput } from "./tariffs";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Целое в диапазоне, инклюзивно с обеих сторон (как в `tariffs.ts`). */
const IntBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/** Воркер считается online, если снимок загрузки (`WorkerStats`) младше этого порога. */
export const WORKER_ONLINE_MS = 20_000;

/**
 * Сессия для админки (часть 1 — без биллинга/стримов, их есть `SessionView`).
 * `userName` — `user.name`; почту здесь не отдаём (спека, часть 1). `workerId`/
 * `slot` — `null`, пока не размещена на воркере. `endedAt`/`lastInputAt` —
 * `null`, пока не наступили. `queuePosition` — место в очереди
 * (`sessions.queue_position`, спека §5, Task 6+); `null` — сессия не в
 * очереди или оценка ещё не считалась.
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
  queuePosition: Schema.NullOr(Schema.Int),
});
export type AdminSession = typeof AdminSession.Type;

/**
 * Воркер для админки: снимок железа/версий/загрузки (`agent.connect`/`WorkerStats`)
 * и активные сессии на нём. `online` — пришёл свежий снимок загрузки
 * (`WORKER_ONLINE_MS`); `lastSeenAt` — `statsAt`, а если снимков не было —
 * `lastSeenAt` воркера (последнее подключение агента), иначе `null`.
 * `regionId` — регион сервера (спека §6), `null` — ещё не привязан.
 * `enrolled` — сервер уже обменял код на постоянный токен и токен не
 * отозван (`worker_credentials.token_hash is not null and revoked_at is
 * null`); `pendingCode` — у сервера есть не истёкший код подключения
 * (`enroll_code_hash is not null and enroll_expires_at > now`), `null` —
 * кода нет или он истёк. Сервер без строки `worker_credentials` (ещё не
 * заводили код) — `enrolled: false`, `pendingCode: null`.
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
  regionId: Schema.NullOr(Schema.String),
  enrolled: Schema.Boolean,
  pendingCode: Schema.NullOr(Schema.Struct({ expiresAt: Schema.String })),
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
 * Регион игровых серверов для админки (вкладка «Регионы», спека §6).
 * `position` — порядок в админке и запасной порядок выбора региона без
 * пинга; задаётся админом. `workers` — сколько серверов сейчас привязано к
 * региону (запрет удаления, если не ноль).
 */
export const AdminRegion = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  name: Schema.String,
  position: Schema.Int,
  workers: Schema.Int,
});
export type AdminRegion = typeof AdminRegion.Type;

/**
 * Игра в библиотеке одного сервера для админки (вкладка «Игры»): строка — пара
 * (сервер `workerId`, игра `appId`), библиотека своя у каждого сервера (спека
 * 2026-11-09 §5), та же игра на двух серверах — две строки. Всё ниже — по
 * этому серверу. `installedAt` — когда установилась
 * (`gamestore_apps.installed_at`); `lastLaunchAt`/`launches` — по сессиям этой
 * игры, размещённым на этом сервере; `activeSessions` — такие сессии не
 * `ended`/`failed` (ещё не размещённые — `queued`/`installing` — ни к одному
 * серверу не относятся и не считаются); `installing` — есть активная
 * (`queued`/`running`) задача установки этой игры на этот сервер;
 * `deleting` — админ попросил удалить её с сервера (`deleting_at`), кнопка
 * «Удалить» в этом состоянии уже неактивна. `deleteError` — причина
 * последнего неудачного удаления (русский текст агента, без секретов),
 * `null` — его не было или новый запрос уже её очистил.
 */
export const AdminGame = Schema.Struct({
  workerId: Schema.String,
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
 * Своя сборка вне Steam для админки (раздел «Свои сборки», спека 2026-11-03
 * «Свои игры»). `slug`/`version` — текущий пакет из `own_games`;
 * `published` — открыта ли игра игрокам («Открыта игрокам»). `workers` — id
 * воркеров с ролью `worker`, у которых раскатан именно этот пакет (точное
 * совпадение `slug`/`version` в `WorkerStats.ownGames`, устаревшая версия на
 * диске не считается); пустой список — «Нет ни на одном воркере».
 * `launches`/`lastLaunchAt`/`activeSessions` — как у `AdminGame`, по сессиям
 * этого `appId`. Своя сборка не ставится и не удаляется через эту вкладку
 * (её раскатка — отдельный процесс на воркере), поэтому здесь нет
 * `sizeBytes`/`installedAt`/`installing`/`deleting`.
 */
export const AdminOwnGame = Schema.Struct({
  appId: Schema.Int,
  name: Schema.String,
  slug: Schema.String,
  version: Schema.String,
  published: Schema.Boolean,
  workers: Schema.Array(Schema.String),
  launches: Schema.Int,
  lastLaunchAt: Schema.NullOr(Schema.String),
  activeSessions: Schema.Int,
});
export type AdminOwnGame = typeof AdminOwnGame.Type;

/**
 * Игры библиотек серверов (строка — пара сервер–игра) + служебные пакеты +
 * свои сборки. `service` — часть библиотеки первого по id воркера
 * `gamestore`, которой нет в его строках `gamestore_apps` (Proton,
 * Steam Linux Runtime и т. п.) — их показывают как «Служебные: …», но
 * никогда не удаляют; `null` — у воркера `gamestore` ещё нет снимка
 * библиотеки (или такого воркера нет вовсе). `own` — свои сборки
 * («Свои сборки», по имени), отдельный раздел вкладки «Игры», без удаления
 * и установки.
 */
export const AdminGames = Schema.Struct({
  games: Schema.Array(AdminGame),
  own: Schema.Array(AdminOwnGame),
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
 * `isActive`. `tariffName` — имя действующего тарифа (спека §2): последняя
 * действующая выдача, иначе тариф по умолчанию, иначе «Базовый» — подзапрос
 * SQL в `userColumns` (`apps/api/src/admin/users.ts`), без N+1.
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
  tariffName: Schema.String,
});
export type AdminUser = typeof AdminUser.Type;

/**
 * Тариф, остаток минут и история выдач/начислений пользователя (карточка
 * пользователя, спека §2, §3, §8). `tariff` — полная форма действующего
 * тарифа (как `admin.tariffs.list`), в том числе когда это встроенный
 * `FALLBACK_TARIFF` (нет строки по умолчанию) — тогда `isDefault: true,
 * archived: false, priceRub: null`. `grantEndsAt`/`periodEndsAt`/
 * `remainingMinutes` — как `Balance` (`@cg/db`, Task 3):
 * `remainingMinutes = floor(remainingMs / 60000)`, `null` — безлимит,
 * отрицательный остаток (долг между тиками) показывается нулём. `grants`/
 * `credits` — вся история, новые сверху; `grantedBy` — имя админа,
 * выдавшего/начислившего вручную, `null` — покупка/системная выдача или
 * админ уже удалён.
 */
export const AdminUserPlan = Schema.Struct({
  tariff: Tariff,
  grantEndsAt: Schema.NullOr(Schema.String),
  periodEndsAt: Schema.String,
  remainingMinutes: Schema.NullOr(Schema.Int),
  grants: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      tariffName: Schema.String,
      startsAt: Schema.String,
      endsAt: Schema.NullOr(Schema.String),
      grantedBy: Schema.NullOr(Schema.String),
    }),
  ),
  credits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      minutes: Schema.Int,
      comment: Schema.String,
      createdAt: Schema.String,
      grantedBy: Schema.NullOr(Schema.String),
    }),
  ),
});
export type AdminUserPlan = typeof AdminUserPlan.Type;

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
// `admin.games.setPublished` — открыть/закрыть свою сборку игрокам
// («Открыта игрокам», раздел «Свои сборки»): `"ok"`, нет такой строки
// `own_games` — `"notFound"`.
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
// `admin.users.plan` — тариф, остаток минут и история выдач/начислений
// пользователя (карточка пользователя, спека §2, §3); нет пользователя —
// `null`. `admin.users.grantTariff` — выдать тариф: закрывает действующую
// выдачу текущим моментом и открывает новую с этого же момента (спека §2,
// «новая выдача заменяет предыдущую»); `endsAt <= now` — `"badEnd"`,
// архивный тариф — `"archived"`, нет пользователя/тарифа — `"notFound"`.
// `admin.users.revokeTariff` — «Снять тариф»: закрыть действующую выдачу
// текущим моментом (пользователь падает на тариф по умолчанию); нет
// действующей выдачи — `"none"`. `admin.users.addMinutes` — ручное
// начисление минут с комментарием (докупка/компенсация, спека §3); нет
// пользователя — `"notFound"`.
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
//
// `admin.regions.list` — регионы, `position asc, name asc`.
// `admin.regions.create` — новый регион; занятый код — `"codeTaken"`, код не
// по `REGION_CODE_PATTERN` — `"invalid"`. `admin.regions.update` —
// переименовать/переставить порядок — `"ok" | "notFound"`.
// `admin.regions.delete` — у региона есть серверы — `"notEmpty"`, нет
// региона — `"notFound"`, иначе `"ok"`.
// `admin.workers.create` — завести сервер (`workers(id, publicIp: "",
// slots: 0, regionId)`) и одноразовый код подключения на 24 часа; занятый
// id — `"idTaken"`, id не по `WORKER_ID_PATTERN` — `"invalid"`, региона нет
// (или `regionId` не uuid) — `"regionNotFound"`.
// `admin.workers.issueCode` — новый код подключения для существующего
// сервера (текущий токен, если он уже есть, продолжает действовать, пока
// код не обменяли) — нет сервера — `"notFound"`.
// `admin.workers.revoke` — отозвать токен и код подключения сервера
// (`token_hash`/`enroll_code_hash = null`, `revoked_at = now`) — есть
// учётные данные сервера — `true`, нет — `false`.
// `admin.workers.setRegion` — привязать сервер к региону (`null` — без
// региона) — нет сервера или региона — `false`.
//
// `admin.tariffs.list` — тарифы, `queue_priority asc, name asc`.
// `admin.tariffs.create` — новый тариф (не по умолчанию, не архивный);
// занятое имя — `"duplicate"`.
// `admin.tariffs.update` — изменить поля тарифа (кроме `isDefault`/
// `archived`, их не трогает) — `"ok" | "duplicate" | "notFound"`.
// `admin.tariffs.setDefault` — сделать тариф тарифом по умолчанию: снять
// флаг со старого и поставить на новый одной транзакцией; архивный тариф —
// `"archived"` (тарифом по умолчанию не становится), нет тарифа —
// `"notFound"`.
// `admin.tariffs.setArchived` — заархивировать/разархивировать
// (`archived_at = now`/`null`); тариф по умолчанию нельзя архивировать —
// `"isDefault"`, нет тарифа — `"notFound"`.
// `admin.hourPacks.list` — пакеты часов (докупка сверх тарифа).
// `admin.hourPacks.create` — новый пакет; имя не уникально — всегда `"ok"`.
// `admin.hourPacks.update` — изменить поля — `"ok" | "notFound"`.
// `admin.hourPacks.setArchived` — заархивировать/разархивировать —
// `"ok" | "notFound"`.
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
  // Удалить игру с одного сервера (строка `gamestore_apps` пары сервер–игра).
  Rpc.make("admin.games.delete", {
    payload: Schema.Struct({ workerId: Schema.String, appId: Schema.Int }),
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
  Rpc.make("admin.games.setPublished", {
    payload: Schema.Struct({ appId: Schema.Int, published: Schema.Boolean }),
    success: Schema.Literals(["ok", "notFound"]),
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
  Rpc.make("admin.users.plan", {
    payload: Schema.Struct({ userId: Schema.String }),
    success: Schema.NullOr(AdminUserPlan),
  }),
  Rpc.make("admin.users.grantTariff", {
    payload: Schema.Struct({
      userId: Schema.String,
      tariffId: Schema.String,
      endsAt: Schema.NullOr(Schema.String),
    }),
    success: Schema.Literals(["ok", "notFound", "archived", "badEnd"]),
  }),
  Rpc.make("admin.users.revokeTariff", {
    payload: Schema.Struct({ userId: Schema.String }),
    success: Schema.Literals(["ok", "none"]),
  }),
  Rpc.make("admin.users.addMinutes", {
    payload: Schema.Struct({
      userId: Schema.String,
      minutes: IntBetween(1, 100_000),
      comment: Schema.String.check(Schema.isMaxLength(200)),
    }),
    success: Schema.Literals(["ok", "notFound"]),
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
  Rpc.make("admin.regions.list", { success: Schema.Array(AdminRegion) }),
  Rpc.make("admin.regions.create", {
    payload: Schema.Struct({ code: Schema.String, name: Schema.String }),
    success: Schema.Union([
      AdminRegion,
      Schema.Literals(["codeTaken", "invalid"]),
    ]),
  }),
  Rpc.make("admin.regions.update", {
    payload: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      position: Schema.Int,
    }),
    success: Schema.Literals(["ok", "notFound"]),
  }),
  Rpc.make("admin.regions.delete", {
    payload: Schema.Struct({ id: Schema.String }),
    success: Schema.Literals(["ok", "notEmpty", "notFound"]),
  }),
  Rpc.make("admin.workers.create", {
    payload: Schema.Struct({ id: Schema.String, regionId: Schema.String }),
    success: Schema.Union([
      Schema.Struct({ code: Schema.String, expiresAt: Schema.String }),
      Schema.Literals(["idTaken", "invalid", "regionNotFound"]),
    ]),
  }),
  Rpc.make("admin.workers.issueCode", {
    payload: Schema.Struct({ workerId: Schema.String }),
    success: Schema.Union([
      Schema.Struct({ code: Schema.String, expiresAt: Schema.String }),
      Schema.Literal("notFound"),
    ]),
  }),
  Rpc.make("admin.workers.revoke", {
    payload: Schema.Struct({ workerId: Schema.String }),
    success: Schema.Boolean,
  }),
  Rpc.make("admin.workers.setRegion", {
    payload: Schema.Struct({
      workerId: Schema.String,
      regionId: Schema.NullOr(Schema.String),
    }),
    success: Schema.Boolean,
  }),
  Rpc.make("admin.tariffs.list", { success: Schema.Array(Tariff) }),
  Rpc.make("admin.tariffs.create", {
    payload: Schema.Struct({ input: TariffInput }),
    success: Schema.Literals(["ok", "duplicate"]),
  }),
  Rpc.make("admin.tariffs.update", {
    payload: Schema.Struct({ id: Schema.String, input: TariffInput }),
    success: Schema.Literals(["ok", "duplicate", "notFound"]),
  }),
  Rpc.make("admin.tariffs.setDefault", {
    payload: Schema.Struct({ id: Schema.String }),
    success: Schema.Literals(["ok", "archived", "notFound"]),
  }),
  Rpc.make("admin.tariffs.setArchived", {
    payload: Schema.Struct({ id: Schema.String, archived: Schema.Boolean }),
    success: Schema.Literals(["ok", "isDefault", "notFound"]),
  }),
  Rpc.make("admin.hourPacks.list", { success: Schema.Array(HourPack) }),
  Rpc.make("admin.hourPacks.create", {
    payload: Schema.Struct({ input: HourPackInput }),
    success: Schema.Literal("ok"),
  }),
  Rpc.make("admin.hourPacks.update", {
    payload: Schema.Struct({ id: Schema.String, input: HourPackInput }),
    success: Schema.Literals(["ok", "notFound"]),
  }),
  Rpc.make("admin.hourPacks.setArchived", {
    payload: Schema.Struct({ id: Schema.String, archived: Schema.Boolean }),
    success: Schema.Literals(["ok", "notFound"]),
  }),
)
  .middleware(AdminMiddleware)
  .middleware(AuthMiddleware);
