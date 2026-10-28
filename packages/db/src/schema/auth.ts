// Таблицы Better Auth 1.7 (ядро + плагины better-auth-steam и genericOAuth).
// Имена свойств совпадают с именами полей Better Auth — так их находит drizzle-адаптер;
// имена колонок в БД — snake_case.
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const roles = ["player", "admin"] as const;
export type Role = (typeof roles)[number];

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  // Плагин better-auth-steam: SteamID64, у пользователей Pocket ID — null.
  steamId: text("steam_id").unique(),
  role: text("role", { enum: roles }).notNull().default("player"),
  librarySyncedAt: timestamptz("library_synced_at"),
  libraryPrivate: boolean("library_private").notNull().default(false),
  // Админ заблокировал вход в игру (`admin.users.setBlocked`); сайт логин не
  // трогает, только живую сессию (`SessionRepo.startSession`). Не в
  // `additionalFields` Better Auth — пользователь не должен задавать её сам.
  blockedAt: timestamptz("blocked_at"),
  // Админ попросил сбросить вход Steam в контейнере (`admin.users.resetSteamLogin`);
  // `steam_id`/строки `account` не трогает — только отметка для оркестратора
  // (Task 3). Не в `additionalFields` Better Auth.
  steamLoginResetAt: timestamptz("steam_login_reset_at"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamptz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
