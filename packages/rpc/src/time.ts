// Сводка игрового времени за месяц для главной /app: группа `time.*`.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AuthMiddleware } from "./auth";

/** Месяц в формате `YYYY-MM` (например, `2026-10`). */
export const TimeMonth = Schema.String.check(
  Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/),
);
export type TimeMonth = typeof TimeMonth.Type;

/**
 * Сводка времени за месяц. `byGame` — суммарные минуты по играм (по убыванию);
 * `sessions` — отдельные сессии месяца (по убыванию `startedAt`).
 */
export const TimeSummary = Schema.Struct({
  month: TimeMonth,
  totalMinutes: Schema.Int,
  sessionCount: Schema.Int,
  byGame: Schema.Array(
    Schema.Struct({
      appId: Schema.Int,
      name: Schema.String,
      minutes: Schema.Int,
    }),
  ),
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      appId: Schema.Int,
      name: Schema.String,
      startedAt: Schema.String,
      minutes: Schema.Int,
    }),
  ),
});
export type TimeSummary = typeof TimeSummary.Type;

/** `time.summary` — сводка времени пользователя за указанный месяц. */
export const TimeRpcs = RpcGroup.make(
  Rpc.make("time.summary", {
    payload: Schema.Struct({ month: TimeMonth }),
    success: TimeSummary,
  }),
).middleware(AuthMiddleware);
