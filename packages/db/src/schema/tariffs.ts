// Тарифы, пакеты часов, выдачи тарифов и начисления минут (спека §2): тариф
// определяет приоритет очереди, лимит/перенос минут в месяц, потолок
// разрешения/битрейта стрима и максимальную длину сессии. Назначение тарифа
// пользователю — отдельная таблица `tariffGrants` (несколько выдач могут
// действовать параллельно, бизнес-логика «какая выигрывает» — вне этого
// пакета). Ровно один тариф — тариф по умолчанию (частичный уникальный
// индекс `tariffs_default_idx`); на него падает пользователь без активной
// выдачи. Миграция сеет тариф «Базовый» (`is_default = true`); если такого
// тарифа всё же не нашлось, действует встроенный `FALLBACK_TARIFF` с теми же
// значениями (анти-цель спеки — никогда не запрещать игру).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { StreamResolution } from "@cg/rpc";
import { user } from "./auth";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

// Те же значения, что `StreamResolution` в @cg/rpc (streamSettings.ts):
// drizzle-kit транспилирует файлы схемы без алиасов монорепы, рантайм-импорт
// из другого пакета сюда не резолвится — как `gameEnds`/`sessionStates` в
// `sessions.ts`, значения просто повторяются локальной константой.
// `satisfies` на компиляции подтверждает, что список не расходится с rpc.
const maxResolutions = [
  "720p",
  "1080p",
  "1440p",
] as const satisfies readonly StreamResolution[];

export const tariffs = pgTable(
  "tariffs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    priceRub: integer("price_rub"),
    queuePriority: integer("queue_priority").notNull().default(0),
    // `null` — безлимит (без переноса остатка, см. `rollover`).
    monthlyMinutes: integer("monthly_minutes"),
    rollover: boolean("rollover").notNull().default(false),
    maxResolution: text("max_resolution", { enum: maxResolutions })
      .notNull()
      .default("1440p"),
    maxBitrateMbps: integer("max_bitrate_mbps").notNull().default(40),
    // `null` — без ограничения длины сессии.
    maxSessionMinutes: integer("max_session_minutes"),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamptz("archived_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("tariffs_default_idx")
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
  ],
);
export type TariffRow = typeof tariffs.$inferSelect;

/** Разовый пакет часов (докупка сверх тарифа) — каталог админки, продажа отдельная задача. */
export const hourPacks = pgTable("hour_packs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  minutes: integer("minutes").notNull(),
  priceRub: integer("price_rub"),
  archivedAt: timestamptz("archived_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/**
 * Выдача тарифа пользователю (покупка/подарок админа/акция). `endsAt` —
 * `null` — бессрочно (до следующей выдачи/отмены). `grantedBy` — админ,
 * выдавший вручную; `null` — покупка самим пользователем или системная выдача.
 */
export const tariffGrants = pgTable(
  "tariff_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tariffId: text("tariff_id")
      .notNull()
      .references(() => tariffs.id),
    startsAt: timestamptz("starts_at").notNull(),
    endsAt: timestamptz("ends_at"),
    grantedBy: text("granted_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("tariff_grants_user_starts_idx").on(t.userId, t.startsAt.desc()),
  ],
);

/**
 * Начисление минут сверх тарифа (докупка пакета часов, компенсация админа).
 * `minutes` — всегда положительное число (CHECK); списание минут — отдельный
 * учёт (вне этой таблицы), эта таблица — только пополнения. `grantedBy` —
 * админ, начисливший вручную; `null` — автоматическое начисление (покупка).
 */
export const minuteCredits = pgTable(
  "minute_credits",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    minutes: integer("minutes").notNull(),
    comment: text("comment").notNull().default(""),
    grantedBy: text("granted_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("minute_credits_user_created_idx").on(t.userId, t.createdAt),
    check("minute_credits_minutes_positive", sql`${t.minutes} > 0`),
  ],
);
