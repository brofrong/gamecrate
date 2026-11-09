// Регионы игровых серверов для админки (вкладка «Регионы», спека §6): список
// по порядку, создание с коротким кодом, переименование/перестановка
// порядка, удаление (только если у региона нет серверов). По образцу
// `classes.ts` — CRUD, результаты проверок как строковые литералы,
// нарушения ограничений БД различаем по имени constraint'а
// (`violatedConstraint`), а не отдельным `select`-check (та же гонка
// check-then-act, что в `classes.ts`: два одновременных запроса на один
// код/регион могут одинаково пройти предварительную проверку).
import { Db, regions, REGION_CODE_PATTERN, workers } from "@cg/db";
import type { AdminRegion } from "@cg/rpc";
import { asc, eq, sql } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect, Option } from "effect";

/** Имена constraint'ов, по которым различаем Postgres-нарушения ниже. */
const CODE_UNIQUE_CONSTRAINT = "regions_code_key";
const WORKERS_REGION_ID_FK_CONSTRAINT = "workers_region_id_regions_id_fkey";

/**
 * Имя нарушенного ограничения БД, если `error` — `EffectDrizzleQueryError` с
 * нарушением уникальности или FK; иначе `undefined` (копия
 * `violatedConstraint` из `classes.ts` — своя: `rpc`/`db` не делят модуль
 * ошибок между контроллерами).
 */
const violatedConstraint = (error: unknown): string | undefined => {
  if (!(error instanceof EffectDrizzleQueryError)) return undefined;
  const sqlError = Option.getOrUndefined(
    Cause.findErrorOption(error.cause as Cause.Cause<unknown>),
  ) as { reason?: unknown } | undefined;
  const reason = sqlError?.reason as
    | { _tag?: string; constraint?: string; cause?: { constraint?: string } }
    | undefined;
  if (reason?._tag === "UniqueViolation") return reason.constraint;
  if (reason?._tag === "ConstraintError") return reason.cause?.constraint;
  return undefined;
};

/** Регионы, `position asc, name asc`, с числом серверов у каждого. */
export const listRegions = (): Effect.Effect<Array<AdminRegion>, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    // `left join` + `group by` (как у `listClasses`), а не коррелированный
    // подзапрос — у `workers` своя колонка `id`.
    return yield* db
      .select({
        id: regions.id,
        code: regions.code,
        name: regions.name,
        position: regions.position,
        workers: sql<number>`count(${workers.id})::int`,
      })
      .from(regions)
      .leftJoin(workers, eq(workers.regionId, regions.id))
      .groupBy(regions.id, regions.code, regions.name, regions.position)
      .orderBy(asc(regions.position), asc(regions.name));
  }).pipe(Effect.orDie);

/**
 * Новый регион. Код не по `REGION_CODE_PATTERN` — `"invalid"` (проверяем
 * раньше похода в БД); занятый код — `"codeTaken"`, ловим нарушение
 * уникального индекса на самом `insert` (не отдельным `select`-check).
 */
export const createRegion = (
  code: string,
  name: string,
): Effect.Effect<AdminRegion | "codeTaken" | "invalid", never, Db> =>
  Effect.gen(function* () {
    if (!REGION_CODE_PATTERN.test(code)) return "invalid" as const;
    const db = yield* Db;
    return yield* db
      .insert(regions)
      .values({ code, name })
      .returning({
        id: regions.id,
        code: regions.code,
        name: regions.name,
        position: regions.position,
      })
      .pipe(
        Effect.map(([row]) => ({ ...row!, workers: 0 }) as AdminRegion),
        Effect.catch((error) =>
          violatedConstraint(error) === CODE_UNIQUE_CONSTRAINT
            ? Effect.succeed("codeTaken" as const)
            : Effect.die(error),
        ),
      );
  });

/** Переименовать/переставить порядок региона. Нет такого региона — `"notFound"`. */
export const updateRegion = (
  id: string,
  name: string,
  position: number,
): Effect.Effect<"ok" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const updated = yield* db
      .update(regions)
      .set({ name, position })
      .where(eq(regions.id, id))
      .returning({ id: regions.id });
    return updated.length > 0 ? ("ok" as const) : ("notFound" as const);
  }).pipe(Effect.orDie);

/**
 * Удалить регион. У региона есть серверы — `"notEmpty"`: ловим нарушение
 * `on delete restrict` на самом `delete` (а не отдельным `select`-check на
 * `workers`, который гонка с конкурентным `admin.workers.setRegion` обходит
 * тем же способом, что в `classes.ts`/`deleteClass`). Нет региона —
 * `"notFound"` (0 удалённых строк).
 */
export const deleteRegion = (
  id: string,
): Effect.Effect<"ok" | "notEmpty" | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db
      .delete(regions)
      .where(eq(regions.id, id))
      .returning({ id: regions.id })
      .pipe(
        Effect.map((rows) =>
          rows.length > 0 ? ("ok" as const) : ("notFound" as const),
        ),
        Effect.catch((error) =>
          violatedConstraint(error) === WORKERS_REGION_ID_FK_CONSTRAINT
            ? Effect.succeed("notEmpty" as const)
            : Effect.die(error),
        ),
      );
  });
