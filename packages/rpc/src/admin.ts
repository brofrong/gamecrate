// Группа `admin.*`: только для роли admin.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AdminMiddleware, AuthMiddleware } from "./auth";
import { SessionSettings } from "./settings";

// Порядок важен: мидлвар, добавленный последним, выполняется первым —
// сначала AuthMiddleware кладёт CurrentUser, затем AdminMiddleware проверяет роль.
//
// `admin.settings.get` — настройки сессий (нет записи — значения по умолчанию);
// `admin.settings.update` — сохранить и вернуть сохранённое. Значения вне
// диапазонов `SessionSettings` отклоняются схемой.
export const AdminRpcs = RpcGroup.make(
  Rpc.make("admin.ping", { success: Schema.Literal("pong") }),
  Rpc.make("admin.settings.get", { success: SessionSettings }),
  Rpc.make("admin.settings.update", {
    payload: SessionSettings,
    success: SessionSettings,
  }),
)
  .middleware(AdminMiddleware)
  .middleware(AuthMiddleware);
