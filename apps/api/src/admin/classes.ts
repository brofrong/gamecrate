// Классы воркеров для админки (блок «Классы» на вкладке «Воркеры», спека
// §5.1): список по силе, создание (всегда самым слабым), переименование,
// перестановка силы, удаление (только если у класса нет воркеров).
import { Db, workerClasses, workers } from "@cg/db";
import type { AdminWorkerClass } from "@cg/rpc";
import { and, asc, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { Effect } from "effect";

/**
 * Временный ранг для обмена местами двух классов под уникальным индексом
 * `worker_classes.rank` (минимум int32 — заведомо вне диапазона реальных рангов).
 */
const TEMP_RANK = -2147483648;

/** Классы по силе (`rank desc`, сильнейший сверху), с числом воркеров у каждого. */
export const listClasses = (): Effect.Effect<
  Array<AdminWorkerClass>,
  never,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    // `left join` + `group by` (а не коррелированный подзапрос) — у `workers`
    // своя колонка `id`, подзапрос с неквалифицированным именем цеплялся бы к ней.
    return yield* db
      .select({
        id: workerClasses.id,
        name: workerClasses.name,
        rank: workerClasses.rank,
        workers: sql<number>`count(${workers.id})::int`,
      })
      .from(workerClasses)
      .leftJoin(workers, eq(workers.classId, workerClasses.id))
      .groupBy(workerClasses.id, workerClasses.name, workerClasses.rank)
      .orderBy(desc(workerClasses.rank));
  }).pipe(Effect.orDie);

/**
 * Новый класс самым слабым: `rank = min(rank) − 1`, пустой список классов →
 * `1`. Занятое имя — `"duplicate"`.
 */
export const createClass = (
  name: string,
): Effect.Effect<"ok" | "duplicate", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [existing] = yield* db
          .select({ id: workerClasses.id })
          .from(workerClasses)
          .where(eq(workerClasses.name, name));
        if (existing !== undefined) return "duplicate" as const;

        const [weakest] = yield* db
          .select({ rank: workerClasses.rank })
          .from(workerClasses)
          .orderBy(asc(workerClasses.rank))
          .limit(1);
        const rank = weakest === undefined ? 1 : weakest.rank - 1;

        yield* db.insert(workerClasses).values({ name, rank });
        return "ok" as const;
      }),
    );
  }).pipe(Effect.orDie);

/**
 * Переименовать класс. Нет такого класса — `"notFound"`, занятое другим
 * классом имя — `"duplicate"`, иначе `"ok"`.
 */
export const renameClass = (
  id: string,
  name: string,
): Effect.Effect<"ok" | "duplicate" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [found] = yield* db
          .select({ id: workerClasses.id })
          .from(workerClasses)
          .where(eq(workerClasses.id, id))
          .for("update");
        if (found === undefined) return "notFound" as const;

        const [duplicate] = yield* db
          .select({ id: workerClasses.id })
          .from(workerClasses)
          .where(and(eq(workerClasses.name, name), ne(workerClasses.id, id)));
        if (duplicate !== undefined) return "duplicate" as const;

        yield* db
          .update(workerClasses)
          .set({ name })
          .where(eq(workerClasses.id, id));
        return "ok" as const;
      }),
    );
  }).pipe(Effect.orDie);

/**
 * Поднять/опустить класс: обменять `rank` с соседом в эту сторону
 * (`"up"` — следующий сильнее, `"down"` — следующий слабее) одной
 * транзакцией. Крайний класс (нет соседа в эту сторону) — `"edge"`, нет
 * класса — `"notFound"`. Обмен — через `TEMP_RANK`, иначе второй `update`
 * упёрся бы в уникальный индекс `rank` (значение ещё занято первым классом).
 */
export const moveClass = (
  id: string,
  direction: "up" | "down",
): Effect.Effect<"ok" | "edge" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [current] = yield* db
          .select({ id: workerClasses.id, rank: workerClasses.rank })
          .from(workerClasses)
          .where(eq(workerClasses.id, id))
          .for("update");
        if (current === undefined) return "notFound" as const;

        const [neighbor] = yield* db
          .select({ id: workerClasses.id, rank: workerClasses.rank })
          .from(workerClasses)
          .where(
            direction === "up"
              ? gt(workerClasses.rank, current.rank)
              : lt(workerClasses.rank, current.rank),
          )
          .orderBy(
            direction === "up"
              ? asc(workerClasses.rank)
              : desc(workerClasses.rank),
          )
          .limit(1)
          .for("update");
        if (neighbor === undefined) return "edge" as const;

        yield* db
          .update(workerClasses)
          .set({ rank: TEMP_RANK })
          .where(eq(workerClasses.id, current.id));
        yield* db
          .update(workerClasses)
          .set({ rank: current.rank })
          .where(eq(workerClasses.id, neighbor.id));
        yield* db
          .update(workerClasses)
          .set({ rank: neighbor.rank })
          .where(eq(workerClasses.id, current.id));
        return "ok" as const;
      }),
    );
  }).pipe(Effect.orDie);

/**
 * Удалить класс. У класса есть воркеры — `"inUse"` (кнопка на этот случай,
 * `workers.class_id` всё равно `on delete restrict`); нет класса —
 * `"notFound"`, иначе `"ok"`.
 */
export const deleteClass = (
  id: string,
): Effect.Effect<"ok" | "inUse" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [found] = yield* db
          .select({ id: workerClasses.id })
          .from(workerClasses)
          .where(eq(workerClasses.id, id))
          .for("update");
        if (found === undefined) return "notFound" as const;

        const [inUse] = yield* db
          .select({ id: workers.id })
          .from(workers)
          .where(eq(workers.classId, id))
          .limit(1);
        if (inUse !== undefined) return "inUse" as const;

        yield* db.delete(workerClasses).where(eq(workerClasses.id, id));
        return "ok" as const;
      }),
    );
  }).pipe(Effect.orDie);
