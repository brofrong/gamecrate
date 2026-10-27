// Каталог игр Steam и библиотеки пользователей.
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const games = pgTable("games", {
  appId: integer("app_id").primaryKey(),
  name: text("name").notNull(),
  // Рейтинг ProtonDB; "pending" — ещё не проверяли или ProtonDB не знает игру.
  protonTier: text("proton_tier").notNull().default("pending"),
  protonCheckedAt: timestamptz("proton_checked_at"),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const userGames = pgTable(
  "user_games",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    appId: integer("app_id")
      .notNull()
      .references(() => games.appId),
    playtimeMinutes: integer("playtime_minutes").notNull().default(0),
    syncedAt: timestamptz("synced_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.appId] }),
    index("user_games_app_id_idx").on(t.appId),
  ],
);

/**
 * Кэш Steam Store (`appdetails`) для страницы игры (спека 2026-10-27 §4.1): строка
 * живёт 7 суток от `fetchedAt`. `found = false` — Steam игру не знает (инструмент,
 * удалённая), тоже кэшируется, чтобы не спрашивать Steam при каждом открытии.
 * `achievementsFetchedAt` — когда брали схему достижений (`game_achievements`),
 * null — ещё не брали.
 */
export const gameDetails = pgTable("game_details", {
  appId: integer("app_id")
    .primaryKey()
    .references(() => games.appId, { onDelete: "cascade" }),
  fetchedAt: timestamptz("fetched_at").notNull(),
  found: boolean("found").notNull(),
  shortDescription: text("short_description"),
  aboutTheGame: text("about_the_game"),
  developers: text("developers").array(),
  publishers: text("publishers").array(),
  genres: text("genres").array(),
  releaseDate: text("release_date"),
  metacriticScore: integer("metacritic_score"),
  metacriticUrl: text("metacritic_url"),
  controllerSupport: text("controller_support"),
  linux: boolean("linux").notNull().default(false),
  achievementsTotal: integer("achievements_total").notNull().default(0),
  screenshots:
    jsonb("screenshots").$type<Array<{ thumb: string; full: string }>>(),
  movies:
    jsonb("movies").$type<
      Array<{
        name: string;
        thumbnail: string;
        hls: string;
        highlight: boolean;
      }>
    >(),
  achievementsFetchedAt: timestamptz("achievements_fetched_at"),
});

/** Схема достижений игры из Steam (`GetSchemaForGame`), срок жизни — как у `game_details`. */
export const gameAchievements = pgTable(
  "game_achievements",
  {
    appId: integer("app_id")
      .notNull()
      .references(() => games.appId, { onDelete: "cascade" }),
    apiName: text("api_name").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    icon: text("icon").notNull(),
    iconGray: text("icon_gray").notNull(),
    hidden: boolean("hidden").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.appId, t.apiName] })],
);
