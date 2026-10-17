// Группа `admin.*`: только для роли admin.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AdminMiddleware, AuthMiddleware } from "./auth";

// Порядок важен: мидлвар, добавленный последним, выполняется первым —
// сначала AuthMiddleware кладёт CurrentUser, затем AdminMiddleware проверяет роль.
export const AdminRpcs = RpcGroup.make(
  Rpc.make("admin.ping", { success: Schema.Literal("pong") }),
)
  .middleware(AdminMiddleware)
  .middleware(AuthMiddleware);
