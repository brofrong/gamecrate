// Библиотека: тиры ProtonDB, ошибка Steam Web API, записи библиотеки и группа `library.*`.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AuthMiddleware } from "./auth";

/**
 * Тир совместимости ProtonDB. `"pending"` — ProtonDB не знает игру (404),
 * вернул неизвестное значение, недоступен или ответил не вовремя.
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

/** Русская подпись плашки ProtonDB для каждого тира. */
export const tierLabel: Record<ProtonTier, string> = {
  platinum: "Работает идеально",
  gold: "Работает после мелких настроек",
  silver: "Работает с недочётами",
  bronze: "Запускается, но играть тяжело",
  borked: "Скорее всего не запустится",
  pending: "Нет данных",
};

/**
 * Игра в библиотеке пользователя. `coverUrl` — вертикальная обложка Steam
 * (`library_600x900_2x.jpg`); если она не загрузилась, фронт берёт `header.jpg`.
 */
export const LibraryEntry = Schema.Struct({
  appId: Schema.Int,
  name: Schema.String,
  playtimeMinutes: Schema.Int,
  protonTier: ProtonTier,
  coverUrl: Schema.String,
});
export type LibraryEntry = typeof LibraryEntry.Type;

/**
 * Библиотека для экрана `/library`. `Private` — профиль Steam скрывает
 * «Сведения об играх»; `Ready` — игры (по убыванию времени в игре, затем по
 * имени) и время последней синхронизации (ISO 8601, null — ещё не было).
 */
export const LibraryView = Schema.Union([
  Schema.TaggedStruct("Private", {}),
  Schema.TaggedStruct("Ready", {
    entries: Schema.Array(LibraryEntry),
    syncedAt: Schema.NullOr(Schema.String),
  }),
]);
export type LibraryView = typeof LibraryView.Type;

/**
 * `library.list` — библиотека из БД (при первом обращении сначала синхронизируется
 * со Steam); `library.refresh` — синхронизировать со Steam сейчас, при недоступности
 * Steam — `SteamUnavailable` (сохранённая библиотека не меняется).
 */
export const LibraryRpcs = RpcGroup.make(
  Rpc.make("library.list", { success: LibraryView }),
  Rpc.make("library.refresh", {
    success: LibraryView,
    error: SteamUnavailable,
  }),
).middleware(AuthMiddleware);
