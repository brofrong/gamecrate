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
import { SessionStage, SessionState } from "./session";
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
)
  .middleware(AdminMiddleware)
  .middleware(AuthMiddleware);
