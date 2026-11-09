// Общий разбор нарушений ограничений БД для контроллеров админки
// (`classes.ts`, `regions.ts`, `workerEnroll.ts`): результат проверок
// («занято», «не найдено», «используется») строится по самому
// Postgres-нарушению на запись, а не отдельным предварительным
// `select`-check'ом.
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Option } from "effect";

/**
 * Имя нарушенного ограничения БД, если `error` — `EffectDrizzleQueryError` с
 * нарушением уникальности или FK (`UniqueViolation`/`ConstraintError`
 * Postgres-реасонов `@effect/sql`); иначе `undefined` — вызывающий код сам
 * решает, что делать (как правило, `Effect.die`).
 *
 * Нужно для check-then-act гонок: create/rename с одинаковым именем/кодом
 * или delete/setClass/setRegion на одной записи могут одновременно пройти
 * предварительную проверку и упереться в constraint на запись — тогда
 * конкретный Postgres-код надёжнее второй проверки (которую та же гонка
 * обходит тем же способом).
 */
export const violatedConstraint = (error: unknown): string | undefined => {
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

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Похоже ли `id` на uuid (ключи `regions`, `worker_classes`): проверяется до
 * запроса — иначе Postgres отвечает на `uuid`-колонку ошибкой разбора
 * («invalid input syntax for type uuid»), и она ушла бы дефектом.
 */
export const isUuid = (id: string): boolean => uuidPattern.test(id);
