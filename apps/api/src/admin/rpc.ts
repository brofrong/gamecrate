// Хендлеры группы `admin.*` (доступ проверяет AdminMiddleware).
import { AdminRpcs } from "@cg/rpc";
import { Effect } from "effect";
import { loadSessionSettings, saveSessionSettings } from "./settings";

export const AdminRpcHandlers = AdminRpcs.toLayer({
  "admin.ping": () => Effect.succeed("pong" as const),
  "admin.settings.get": () => loadSessionSettings,
  "admin.settings.update": (value) => saveSessionSettings(value),
});
