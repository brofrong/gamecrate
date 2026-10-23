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
 * Статус облачной версии игры (установлена ли она на сервере стриминга).
 * `Ready` — установлена; `Installing` — идёт установка (`percent` — доля,
 * null — пока неизвестна); `Missing` — не установлена.
 */
export const CloudStatus = Schema.Union([
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Installing", {
    percent: Schema.NullOr(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    ),
  }),
  Schema.TaggedStruct("Missing", {}),
]);
export type CloudStatus = typeof CloudStatus.Type;

/**
 * Игра в библиотеке пользователя. `coverUrl` — вертикальная обложка Steam
 * (`library_600x900_2x.jpg`); если она не загрузилась, фронт берёт `header.jpg`.
 * `lastPlayedAt` — ISO 8601 последней не-failed сессии пользователя в этой
 * игре, null — ещё не играл.
 */
export const LibraryEntry = Schema.Struct({
  appId: Schema.Int,
  name: Schema.String,
  playtimeMinutes: Schema.Int,
  protonTier: ProtonTier,
  coverUrl: Schema.String,
  cloud: CloudStatus,
  lastPlayedAt: Schema.NullOr(Schema.String),
});
export type LibraryEntry = typeof LibraryEntry.Type;

/**
 * Библиотека для экрана `/library`. `Private` — профиль Steam скрывает
 * «Сведения об играх»; `Ready` — игры (по убыванию времени в игре, затем по
 * имени), время последней синхронизации (ISO 8601, null — ещё не было) и
 * `steamProfile` — у пользователя привязан Steam (иначе библиотека своя,
 * не из Steam).
 */
export const LibraryView = Schema.Union([
  Schema.TaggedStruct("Private", {}),
  Schema.TaggedStruct("Ready", {
    entries: Schema.Array(LibraryEntry),
    syncedAt: Schema.NullOr(Schema.String),
    steamProfile: Schema.Boolean,
  }),
]);
export type LibraryView = typeof LibraryView.Type;

/**
 * Игра в блоке «Недавние» на главной `/app`: последняя сессия и её
 * продолжительность. `lastPlayedAt` — ISO 8601 начала той сессии.
 */
export const RecentEntry = Schema.Struct({
  appId: Schema.Int,
  name: Schema.String,
  coverUrl: Schema.String,
  cloud: CloudStatus,
  lastPlayedAt: Schema.String,
  lastDurationMinutes: Schema.Int,
});
export type RecentEntry = typeof RecentEntry.Type;

/**
 * Игра в блоке «В тренде». `players` — текущие или недельные онлайн-игроки
 * (зависит от списка — `now`/`week`); `inLibrary` — уже есть у пользователя.
 */
export const TrendingEntry = Schema.Struct({
  appId: Schema.Int,
  name: Schema.String,
  coverUrl: Schema.String,
  cloud: CloudStatus,
  players: Schema.Int,
  inLibrary: Schema.Boolean,
});
export type TrendingEntry = typeof TrendingEntry.Type;

/** «В тренде» на главной `/app`: сейчас (`now`) и за неделю (`week`). */
export const TrendingView = Schema.Struct({
  now: Schema.Array(TrendingEntry),
  week: Schema.Array(TrendingEntry),
});
export type TrendingView = typeof TrendingView.Type;

/**
 * `library.list` — библиотека из БД (при первом обращении сначала синхронизируется
 * со Steam); `library.refresh` — синхронизировать со Steam сейчас, при недоступности
 * Steam — `SteamUnavailable` (сохранённая библиотека не меняется); `library.recent` —
 * блок «Недавние» для главной `/app`; `library.trending` — блок «В тренде».
 */
export const LibraryRpcs = RpcGroup.make(
  Rpc.make("library.list", { success: LibraryView }),
  Rpc.make("library.refresh", {
    success: LibraryView,
    error: SteamUnavailable,
  }),
  Rpc.make("library.recent", { success: Schema.Array(RecentEntry) }),
  Rpc.make("library.trending", { success: TrendingView }),
).middleware(AuthMiddleware);
