// Библиотека: тир совместимости ProtonDB и ошибка недоступности Steam Web API.
import { Schema } from "effect";

/**
 * Тир совместимости ProtonDB. `"pending"` — ProtonDB не знает игру (404),
 * вернул неизвестное значение, недоступен или ответил не вовремя (Task 4);
 * `tierLabel` (русские подписи тиров) добавляется в Task 5.
 */
export const ProtonTier = Schema.Literals([
  "platinum",
  "gold",
  "silver",
  "bronze",
  "borked",
  "pending",
]);
export type ProtonTier = typeof ProtonTier.Type;

/** Steam Web API недоступен: ключ неверный (403), превышен лимит (429) или сеть/5xx. */
export class SteamUnavailable extends Schema.TaggedError<SteamUnavailable>()(
  "SteamUnavailable",
  {
    reason: Schema.Literals(["unauthorized", "rate_limited", "unavailable"]),
  },
) {}
