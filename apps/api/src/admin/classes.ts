// Классы воркеров для админки (блок «Классы» на вкладке «Воркеры», спека
// §5.1): список по силе, создание (всегда самым слабым), переименование,
// перестановка силы, удаление (только если у класса нет воркеров).
import { Db, workerClasses, workers } from "@cg/db";
import type { AdminWorkerClass } from "@cg/rpc";
import { asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { Effect } from "effect";
import { violatedConstraint } from "./dbErrors";

/**
 * Временный ранг для обмена местами двух классов под уникальным индексом
 * `worker_classes.rank` (минимум int32 — заведомо вне диапазона реальных рангов).
 */
const TEMP_RANK = -2147483648;

/** Имена constraint'ов, по которым различаем Postgres-нарушения ниже (см. `violatedConstraint` в `./dbErrors`). */
const NAME_UNIQUE_CONSTRAINT = "worker_classes_name_key";
const WORKERS_CLASS_ID_FK_CONSTRAINT =
  "workers_class_id_worker_classes_id_fkey";

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
 * `1`. Занятое имя — `"duplicate"`: ловим нарушение уникального индекса на
 * `insert` (а не отдельным `select`-check, который два одновременных
 * `create` одного имени оба проходят и падают дефектом на втором `insert`).
 */
export const createClass = (
  name: string,
): Effect.Effect<"ok" | "duplicate", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [weakest] = yield* db
      .select({ rank: workerClasses.rank })
      .from(workerClasses)
      .orderBy(asc(workerClasses.rank))
      .limit(1)
      .pipe(Effect.orDie);
    const rank = weakest === undefined ? 1 : weakest.rank - 1;

    return yield* db
      .insert(workerClasses)
      .values({ name, rank })
      .pipe(
        Effect.as("ok" as const),
        Effect.catch((error) =>
          violatedConstraint(error) === NAME_UNIQUE_CONSTRAINT
            ? Effect.succeed("duplicate" as const)
            : Effect.die(error),
        ),
      );
  });

/**
 * Переименовать класс. Нет такого класса — `"notFound"` (0 обновлённых
 * строк); занятое другим классом имя — `"duplicate"`, пойманное нарушением
 * уникального индекса на самом `update` (не отдельным `select`-check — та же
 * гонка, что в `createClass`).
 */
export const renameClass = (
  id: string,
  name: string,
): Effect.Effect<"ok" | "duplicate" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .update(workerClasses)
      .set({ name })
      .where(eq(workerClasses.id, id))
      .returning({ id: workerClasses.id })
      .pipe(
        Effect.map((rows) =>
          rows.length > 0 ? ("ok" as const) : ("notFound" as const),
        ),
        Effect.catch((error) =>
          violatedConstraint(error) === NAME_UNIQUE_CONSTRAINT
            ? Effect.succeed("duplicate" as const)
            : Effect.die(error),
        ),
      );
  });

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
 * Удалить класс. У класса есть воркеры — `"inUse"`: ловим нарушение `on
 * delete restrict` на самом `delete` (а не отдельным `select`-check на
 * `workers`, который гонка с конкурентным `admin.workers.setClass` —
 * назначением этого класса воркеру между проверкой и `delete` — обходит,
 * роняя запрос дефектом). Нет класса — `"notFound"` (0 удалённых строк).
 */
export const deleteClass = (
  id: string,
): Effect.Effect<"ok" | "inUse" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .delete(workerClasses)
      .where(eq(workerClasses.id, id))
      .returning({ id: workerClasses.id })
      .pipe(
        Effect.map((rows) =>
          rows.length > 0 ? ("ok" as const) : ("notFound" as const),
        ),
        Effect.catch((error) =>
          violatedConstraint(error) === WORKERS_CLASS_ID_FK_CONSTRAINT
            ? Effect.succeed("inUse" as const)
            : Effect.die(error),
        ),
      );
  });
