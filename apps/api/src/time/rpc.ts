// Хендлер группы `time.*`: сводка игрового времени для главной /app.
import { TimeRpcs } from "@cg/rpc";
import { Effect } from "effect";

// TODO: реальная сводка (запрос по play_segments) подключается в задаче главной /app.
export const TimeRpcHandlers = TimeRpcs.toLayer({
  "time.summary": ({ month }) =>
    Effect.succeed({
      month,
      totalMinutes: 0,
      sessionCount: 0,
      byGame: [],
      sessions: [],
    }),
});
