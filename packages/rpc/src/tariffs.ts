// Схемы тарифов и пакетов часов (спека §1 «Тарифы»): тариф определяет
// приоритет очереди, лимит/перенос минут в месяц, потолок разрешения/битрейта
// стрима и максимальную длину сессии; пакет часов — разовая докупка минут
// сверх тарифа. RPC `admin.tariffs.*`/`admin.hourPacks.*`, использующие эти
// схемы, — в `admin.ts` (та же группа `AdminRpcs`, что и остальная админка).
// Task 6 добавит сюда же `AccountRpcs` для игрока (свой тариф, покупка
// пакета), поэтому файл сразу разложен на «форма записи» / «форма ввода».
import { Schema } from "effect";
import { maxBitrateMbps, minBitrateMbps, StreamResolution } from "./streamSettings";

/** Непустая строка длиной 1..60 после обрезки пробелов по краям (имя тарифа/пакета). */
const Name60 = Schema.Trim.check(Schema.isBetweenLength(1, 60));

/** Целое в диапазоне, инклюзивно с обеих сторон (цена, минуты и т. п.). */
const IntBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

/**
 * Тариф для админки (вкладка «Тарифы», спека §1.1). `priceRub`/`monthlyMinutes`/
 * `maxSessionMinutes` — `null` — соответственно «бесплатный/не продаётся
 * отдельно», «безлимит минут», «без ограничения длины сессии». `isDefault` —
 * ровно у одного тарифа (частичный уникальный индекс `tariffs_default_idx`,
 * `@cg/db`); `archived` — `archived_at is not null`, архивный тариф не
 * выдаётся новым пользователям, но у выданных ранее продолжает действовать.
 */
export const Tariff = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  priceRub: Schema.NullOr(Schema.Int),
  queuePriority: Schema.Int,
  monthlyMinutes: Schema.NullOr(Schema.Int),
  rollover: Schema.Boolean,
  maxResolution: StreamResolution,
  maxBitrateMbps: Schema.Int,
  maxSessionMinutes: Schema.NullOr(Schema.Int),
  isDefault: Schema.Boolean,
  archived: Schema.Boolean,
});
export type Tariff = typeof Tariff.Type;

/**
 * Поля тарифа, которые задаёт админ при создании/редактировании (без
 * `id`/`isDefault`/`archived` — те меняются отдельными методами:
 * `admin.tariffs.setDefault`/`setArchived`).
 */
export const TariffInput = Schema.Struct({
  name: Name60,
  priceRub: Schema.NullOr(IntBetween(0, 1_000_000)),
  queuePriority: IntBetween(0, 1000),
  monthlyMinutes: Schema.NullOr(IntBetween(60, 100_000)),
  rollover: Schema.Boolean,
  maxResolution: StreamResolution,
  maxBitrateMbps: IntBetween(minBitrateMbps, maxBitrateMbps),
  maxSessionMinutes: Schema.NullOr(IntBetween(10, 10_000)),
});
export type TariffInput = typeof TariffInput.Type;

/**
 * Разовый пакет часов для админки (докупка сверх тарифа, спека §1.3):
 * `priceRub` — `null` — пакет временно не продаётся; `archived` —
 * `archived_at is not null`, снимает пакет с продажи, не трогая уже
 * купленные начисления (`minute_credits`, `@cg/db`).
 */
export const HourPack = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  minutes: Schema.Int,
  priceRub: Schema.NullOr(Schema.Int),
  archived: Schema.Boolean,
});
export type HourPack = typeof HourPack.Type;

/** Поля пакета часов, которые задаёт админ (без `id`/`archived`). */
export const HourPackInput = Schema.Struct({
  name: Name60,
  minutes: IntBetween(60, 100_000),
  priceRub: Schema.NullOr(IntBetween(0, 1_000_000)),
});
export type HourPackInput = typeof HourPackInput.Type;
