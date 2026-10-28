// Хендлеры группы `admin.*` (доступ проверяет AdminMiddleware).
import { AdminRpcs } from "@cg/rpc";
import { DateTime, Effect } from "effect";
import { loadSessionSettings, saveSessionSettings } from "./settings";
import { adminStop, listSessions } from "./sessions";
import { listWorkers, setDraining } from "./workers";

export const AdminRpcHandlers = AdminRpcs.toLayer({
  "admin.ping": () => Effect.succeed("pong" as const),
  "admin.settings.get": () => loadSessionSettings,
  "admin.settings.update": (value) => saveSessionSettings(value),
  "admin.workers.list": () =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* listWorkers(now);
    }),
  "admin.workers.setDraining": ({ workerId, draining }) =>
    setDraining(workerId, draining),
  "admin.sessions.list": ({ failedOnly }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate;
      return yield* listSessions(failedOnly, now);
    }),
  "admin.sessions.stop": ({ sessionId }) => adminStop(sessionId),
});
