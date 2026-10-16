// Каталог игр Steam и библиотеки пользователей.
import {
  index,
  integer,
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
