// Хендлер группы `time.*`: сводка игрового времени для главной /app.
import { CurrentUser, TimeRpcs } from "@cg/rpc";
import { Effect } from "effect";
import { monthSummary } from "./TimeRepo";

export const TimeRpcHandlers = TimeRpcs.toLayer({
  "time.summary": ({ month }) =>
    Effect.gen(function* () {
      const current = yield* CurrentUser;
      return yield* monthSummary(current.id, month);
    }),
});
