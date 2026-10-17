// Хендлеры группы `admin.*` (доступ проверяет AdminMiddleware).
import { AdminRpcs } from "@cg/rpc";
import { Effect } from "effect";

export const AdminRpcHandlers = AdminRpcs.toLayer({
  "admin.ping": () => Effect.succeed("pong" as const),
});
