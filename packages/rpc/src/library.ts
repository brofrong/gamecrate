// Библиотека: тиры ProtonDB, ошибка Steam Web API, записи библиотеки и группа `library.*`.
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { AuthMiddleware } from "./auth";
import { OwnGameInfo } from "./ownGames";

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
 * «Сведения об играх» (Steam-игры не видны), но `entries` — свои игры
 * пользователя: они не зависят от Steam и видны независимо от приватности
 * профиля. `Ready` — игры (по убыванию времени в игре, затем по имени),
 * время последней синхронизации (ISO 8601, null — ещё не было) и
 * `steamProfile` — у пользователя привязан Steam (иначе библиотека своя,
 * не из Steam).
 */
export const LibraryView = Schema.Union([
  Schema.TaggedStruct("Private", { entries: Schema.Array(LibraryEntry) }),
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

/** Описание и медиа игры из Steam Store (кэш `game_details`, спека 2026-10-27 §4.1). */
export const GameDetails = Schema.Struct({
  shortDescription: Schema.String,
  aboutTheGame: Schema.String,
  developers: Schema.Array(Schema.String),
  publishers: Schema.Array(Schema.String),
  genres: Schema.Array(Schema.String),
  releaseDate: Schema.NullOr(Schema.String),
  metacriticScore: Schema.NullOr(Schema.Int),
  metacriticUrl: Schema.NullOr(Schema.String),
  controllerSupport: Schema.NullOr(Schema.Literals(["full", "partial"])),
  linux: Schema.Boolean,
  achievementsTotal: Schema.Int,
  screenshots: Schema.Array(
    Schema.Struct({ thumb: Schema.String, full: Schema.String }),
  ),
  movies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      thumbnail: Schema.String,
      hls: Schema.String,
      highlight: Schema.Boolean,
    }),
  ),
});
export type GameDetails = typeof GameDetails.Type;

/**
 * Достижения пользователя в игре: `None` — у игры их нет или Steam не ответил,
 * `Private` — профиль Steam закрыт, `Unlinked` — у пользователя нет Steam,
 * `Ready` — открытые (по дате получения, новые первыми) и закрытые.
 */
export const GameAchievements = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Private", {}),
  Schema.TaggedStruct("Unlinked", {}),
  Schema.TaggedStruct("Ready", {
    total: Schema.Int,
    unlocked: Schema.Array(
      Schema.Struct({
        apiName: Schema.String,
        name: Schema.String,
        description: Schema.String,
        icon: Schema.String,
        unlockedAt: Schema.String,
      }),
    ),
    locked: Schema.Array(
      Schema.Struct({
        apiName: Schema.String,
        name: Schema.String,
        description: Schema.String,
        iconGray: Schema.String,
        hidden: Schema.Boolean,
      }),
    ),
  }),
]);
export type GameAchievements = typeof GameAchievements.Type;

/** Сессия пользователя в игре: начало (ISO 8601) и длительность в минутах. */
export const GameSessionEntry = Schema.Struct({
  id: Schema.String,
  startedAt: Schema.String,
  minutes: Schema.Int,
});
export type GameSessionEntry = typeof GameSessionEntry.Type;

/**
 * Страница игры `/app/game/<appId>` (спека 2026-10-27 §4.3). `details: null` —
 * Steam Store не ответил и кэша нет (или Steam игру не знает); фронт рисует то,
 * что есть. `inLibrary: false` — игры нет в библиотеке пользователя («В тренде»).
 * `own: null` — игра из Steam (обычная страница); есть — своя игра, фронт
 * показывает её вместо Steam-блоков («Фанатский ПК-порт», «Управление»).
 */
export const GameView = Schema.Struct({
  appId: Schema.Int,
  name: Schema.String,
  coverUrl: Schema.String,
  cloud: CloudStatus,
  protonTier: ProtonTier,
  inLibrary: Schema.Boolean,
  playtimeMinutes: Schema.Int,
  sizeBytes: Schema.NullOr(Schema.Int),
  lastSession: Schema.NullOr(GameSessionEntry),
  sessions: Schema.Array(GameSessionEntry),
  details: Schema.NullOr(GameDetails),
  achievements: GameAchievements,
  /** Есть ли сейчас подходящий игре воркер для пользователя (спека §3). */
  available: Schema.Boolean,
  own: Schema.NullOr(OwnGameInfo),
});
export type GameView = typeof GameView.Type;

/** Игры с таким `appId` нет ни в каталоге `games`, ни в библиотеке пользователя. */
export class GameNotFound extends Schema.TaggedError<GameNotFound>()(
  "GameNotFound",
  { appId: Schema.Int },
) {}

/**
 * `library.list` — библиотека из БД (при первом обращении сначала синхронизируется
 * со Steam); `library.refresh` — синхронизировать со Steam сейчас, при недоступности
 * Steam — `SteamUnavailable` (сохранённая библиотека не меняется); `library.recent` —
 * блок «Недавние» для главной `/app`; `library.trending` — блок «В тренде»;
 * `library.game` — страница игры (`GameNotFound`, если игры нет).
 */
export const LibraryRpcs = RpcGroup.make(
  Rpc.make("library.list", { success: LibraryView }),
  Rpc.make("library.refresh", {
    success: LibraryView,
    error: SteamUnavailable,
  }),
  Rpc.make("library.recent", { success: Schema.Array(RecentEntry) }),
  Rpc.make("library.trending", { success: TrendingView }),
  Rpc.make("library.game", {
    payload: Schema.Struct({ appId: Schema.Int }),
    success: GameView,
    error: GameNotFound,
  }),
).middleware(AuthMiddleware);
