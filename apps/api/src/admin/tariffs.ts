// Тарифы и пакеты часов для админки (вкладка «Тарифы», спека §1, §8): CRUD
// по образцу `regions.ts`/`classes.ts` — конфликт уникального имени тарифа
// ловим на самом `insert`/`update` через `violatedConstraint` (не отдельным
// `select`-check, та же гонка, что в `classes.ts`/`createClass`); тариф по
// умолчанию переставляется одной транзакцией (как `moveClass` обменивает
// ранг), а "тариф по умолчанию нельзя архивировать" — отдельная бизнес-
// проверка (не ограничение БД), читаем строку с `for("update")`, чтобы не
// гонять check-then-act с конкурентным `setArchived`/`setDefault` на той же
// строке. Пакеты часов — тот же CRUD, но без уникальности имени и без
// понятия "по умолчанию".
import { Db, hourPacks, tariffs, type TariffRow } from "@cg/db";
import type { HourPack, HourPackInput, Tariff, TariffInput } from "@cg/rpc";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { violatedConstraint } from "./dbErrors";

/** Имя constraint'а уникального имени тарифа (инлайн `.unique()` в схеме). */
const TARIFF_NAME_UNIQUE_CONSTRAINT = "tariffs_name_key";

/** Строка `tariffs` → форма для админки: `archived` — `archived_at is not null`. */
const toTariff = (row: TariffRow): Tariff => ({
  id: row.id,
  name: row.name,
  priceRub: row.priceRub,
  queuePriority: row.queuePriority,
  monthlyMinutes: row.monthlyMinutes,
  rollover: row.rollover,
  maxResolution: row.maxResolution,
  maxBitrateMbps: row.maxBitrateMbps,
  maxSessionMinutes: row.maxSessionMinutes,
  isDefault: row.isDefault,
  archived: row.archivedAt !== null,
});

/** Тарифы, `queue_priority asc, name asc`. */
export const listTariffs = (): Effect.Effect<Array<Tariff>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select()
      .from(tariffs)
      .orderBy(asc(tariffs.queuePriority), asc(tariffs.name));
    return rows.map(toTariff);
  }).pipe(Effect.orDie);

/**
 * Новый тариф (всегда не по умолчанию, не архивный). Занятое имя —
 * `"duplicate"`: ловим нарушение уникального индекса на самом `insert`.
 */
export const createTariff = (
  input: TariffInput,
): Effect.Effect<"ok" | "duplicate", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .insert(tariffs)
      .values({ id: crypto.randomUUID(), ...input })
      .pipe(
        Effect.as("ok" as const),
        Effect.catch((error) =>
          violatedConstraint(error) === TARIFF_NAME_UNIQUE_CONSTRAINT
            ? Effect.succeed("duplicate" as const)
            : Effect.die(error),
        ),
      );
  });

/**
 * Изменить поля тарифа (`isDefault`/`archived` этим методом не трогаются —
 * см. `setDefaultTariff`/`setArchivedTariff`). Нет тарифа — `"notFound"`,
 * занятое другим тарифом имя — `"duplicate"` (та же гонка, что в `createTariff`).
 */
export const updateTariff = (
  id: string,
  input: TariffInput,
): Effect.Effect<"ok" | "duplicate" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .update(tariffs)
      .set(input)
      .where(eq(tariffs.id, id))
      .returning({ id: tariffs.id })
      .pipe(
        Effect.map((rows) =>
          rows.length > 0 ? ("ok" as const) : ("notFound" as const),
        ),
        Effect.catch((error) =>
          violatedConstraint(error) === TARIFF_NAME_UNIQUE_CONSTRAINT
            ? Effect.succeed("duplicate" as const)
            : Effect.die(error),
        ),
      );
  });

/**
 * Сделать тариф тарифом по умолчанию: снять флаг со старого и поставить на
 * новый одной транзакцией (как `moveClass` обменивает ранг под уникальным
 * индексом) — снаружи транзакции не бывает ни нуля, ни двух тарифов по
 * умолчанию. Архивный тариф тарифом по умолчанию не становится —
 * `"archived"`; нет тарифа — `"notFound"`.
 */
export const setDefaultTariff = (
  id: string,
): Effect.Effect<"ok" | "archived" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({ archivedAt: tariffs.archivedAt })
          .from(tariffs)
          .where(eq(tariffs.id, id))
          .for("update");
        if (row === undefined) return "notFound" as const;
        if (row.archivedAt !== null) return "archived" as const;

        yield* db
          .update(tariffs)
          .set({ isDefault: false })
          .where(eq(tariffs.isDefault, true));
        yield* db
          .update(tariffs)
          .set({ isDefault: true })
          .where(eq(tariffs.id, id));
        return "ok" as const;
      }),
    );
  }).pipe(Effect.orDie);

/**
 * Заархивировать/разархивировать тариф (`archived_at = now`/`null`). Тариф
 * по умолчанию нельзя архивировать — `"isDefault"` (разархивировать можно
 * всегда, это из `isDefault` не следует). Нет тарифа — `"notFound"`.
 */
export const setArchivedTariff = (
  id: string,
  archived: boolean,
  now: Date,
): Effect.Effect<"ok" | "isDefault" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({ isDefault: tariffs.isDefault })
          .from(tariffs)
          .where(eq(tariffs.id, id))
          .for("update");
        if (row === undefined) return "notFound" as const;
        if (archived && row.isDefault) return "isDefault" as const;

        yield* db
          .update(tariffs)
          .set({ archivedAt: archived ? now : null })
          .where(eq(tariffs.id, id));
        return "ok" as const;
      }),
    );
  }).pipe(Effect.orDie);

/** Строка `hour_packs` → форма для админки: `archived` — `archived_at is not null`. */
const toHourPack = (row: typeof hourPacks.$inferSelect): HourPack => ({
  id: row.id,
  name: row.name,
  minutes: row.minutes,
  priceRub: row.priceRub,
  archived: row.archivedAt !== null,
});

/** Пакеты часов, по имени (имя не уникально, в отличие от тарифов). */
export const listHourPacks = (): Effect.Effect<Array<HourPack>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select()
      .from(hourPacks)
      .orderBy(asc(hourPacks.name));
    return rows.map(toHourPack);
  }).pipe(Effect.orDie);

/** Новый пакет часов; имя не уникально (в отличие от тарифов) — всегда `"ok"`. */
export const createHourPack = (
  input: HourPackInput,
): Effect.Effect<"ok", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(hourPacks).values({ id: crypto.randomUUID(), ...input });
    return "ok" as const;
  }).pipe(Effect.orDie);

/** Изменить поля пакета часов. Нет пакета — `"notFound"`. */
export const updateHourPack = (
  id: string,
  input: HourPackInput,
): Effect.Effect<"ok" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const updated = yield* db
      .update(hourPacks)
      .set(input)
      .where(eq(hourPacks.id, id))
      .returning({ id: hourPacks.id });
    return updated.length > 0 ? ("ok" as const) : ("notFound" as const);
  }).pipe(Effect.orDie);

/** Заархивировать/разархивировать пакет часов. Нет пакета — `"notFound"`. */
export const setArchivedHourPack = (
  id: string,
  archived: boolean,
  now: Date,
): Effect.Effect<"ok" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const updated = yield* db
      .update(hourPacks)
      .set({ archivedAt: archived ? now : null })
      .where(eq(hourPacks.id, id))
      .returning({ id: hourPacks.id });
    return updated.length > 0 ? ("ok" as const) : ("notFound" as const);
  }).pipe(Effect.orDie);
