// Подключение игровых серверов для админки (спека §3 «Подключение игрового
// сервера к главному»): создание записи сервера с одноразовым кодом
// подключения, перевыпуск кода для уже заведённого сервера, отзыв токена.
// Сам код/токен виден вызывающему только в момент выдачи — в БД остаётся
// только его SHA-256 (`sha256Hex` из `@cg/db`), восстановить обратно нельзя.
// По образцу `classes.ts` (строковые литералы результатов, нарушения
// ограничений БД различаем по имени constraint'а, а не отдельным
// `select`-check).
import {
  Db,
  ENROLL_CODE_TTL_MS,
  newEnrollCode,
  sha256Hex,
  WORKER_ID_PATTERN,
  workerCredentials,
  workers,
} from "@cg/db";
import { eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { violatedConstraint } from "./dbErrors";

/** `workers.id` — первичный ключ без явного имени, Postgres называет его так (см. `violatedConstraint` в `./dbErrors`). */
const WORKERS_PKEY_CONSTRAINT = "workers_pkey";

/** Код + момент истечения для ответа админке. */
type EnrollCode = { readonly code: string; readonly expiresAt: string };

/**
 * Выпустить новый код подключения для сервера, у которого уже есть строка
 * `workers` (сама по себе, без проверки, что сервер существует — вызывающие
 * ниже это уже проверили). `upsert` по `workerId` — у старых воркеров (до
 * этой задачи) строки `worker_credentials` могло не быть; при перевыпуске
 * трогаем только `enroll_code_hash`/`enroll_expires_at`, оставляя
 * `token_hash`/`revoked_at` как есть — текущий токен, если он уже выдан,
 * продолжает действовать, пока код не обменяли на новый.
 */
const issueEnrollCode = (
  workerId: string,
): Effect.Effect<EnrollCode, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = yield* DateTime.nowAsDate;
    const code = newEnrollCode();
    const expiresAt = new Date(now.getTime() + ENROLL_CODE_TTL_MS);
    const enrollCodeHash = sha256Hex(code);
    yield* db
      .insert(workerCredentials)
      .values({ workerId, enrollCodeHash, enrollExpiresAt: expiresAt })
      .onConflictDoUpdate({
        target: workerCredentials.workerId,
        set: { enrollCodeHash, enrollExpiresAt: expiresAt },
      });
    return { code, expiresAt: expiresAt.toISOString() };
  }).pipe(Effect.orDie);

/**
 * Завести сервер: `workers(id, publicIp: "", slots: 0, regionId)` — реальные
 * `publicIp`/`slots` сервер сообщит сам при первом подключении (Task 3) —
 * и код подключения, одной транзакцией. Id не по `WORKER_ID_PATTERN` —
 * `"invalid"` (проверяем до похода в БД); занятый id — `"idTaken"`, ловим
 * нарушение первичного ключа на самом `insert` (не отдельным
 * `select`-check — та же гонка, что в `classes.ts`/`createClass`).
 *
 * `insert` воркера — в своей вложенной транзакции (`db.transaction` внутри
 * `db.transaction` даёт `SAVEPOINT` у `@effect/sql`): Postgres считает всю
 * транзакцию «в ошибке» после нарушения constraint'а, пока явно не
 * откатить именно до этой точки — поймать ошибку `Effect.catch`'ем без
 * вложенной транзакции оставило бы внешнюю транзакцию в этом состоянии, и
 * следующий `insert` (кода подключения) или финальный `COMMIT` упали бы
 * дефектом «current transaction is aborted» вместо документированного
 * `"idTaken"`.
 */
export const createWorker = (
  id: string,
  regionId: string,
): Effect.Effect<EnrollCode | "idTaken" | "invalid", never, Db> =>
  Effect.gen(function* () {
    if (!WORKER_ID_PATTERN.test(id)) return "invalid" as const;
    const db = yield* Db;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const created = yield* db
          .transaction(() =>
            db.insert(workers).values({ id, publicIp: "", slots: 0, regionId }),
          )
          .pipe(
            Effect.as(true as const),
            Effect.catch((error) =>
              violatedConstraint(error) === WORKERS_PKEY_CONSTRAINT
                ? Effect.succeed(false as const)
                : Effect.die(error),
            ),
          );
        if (!created) return "idTaken" as const;
        return yield* issueEnrollCode(id);
      }),
    );
  }).pipe(Effect.orDie);

/**
 * Новый код подключения для существующего сервера. Нет сервера —
 * `"notFound"`; иначе — `issueEnrollCode` (текущий токен, если есть,
 * продолжает действовать до обмена кода).
 */
export const issueCode = (
  workerId: string,
): Effect.Effect<EnrollCode | "notFound", never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [worker] = yield* db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.id, workerId));
    if (worker === undefined) return "notFound" as const;
    return yield* issueEnrollCode(workerId);
  }).pipe(Effect.orDie);

/**
 * Отозвать токен и код подключения сервера: `token_hash`/`enroll_code_hash
 * = null`, `revoked_at = now` — оркестратор (Task 3) рвёт соединение этого
 * воркера. Есть строка `worker_credentials` — `true`, нет (сервер только
 * заведён до этой задачи, кода/токена никогда не было) — `false`.
 */
export const revoke = (workerId: string): Effect.Effect<boolean, never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = yield* DateTime.nowAsDate;
    const updated = yield* db
      .update(workerCredentials)
      .set({ tokenHash: null, enrollCodeHash: null, revokedAt: now })
      .where(eq(workerCredentials.workerId, workerId))
      .returning({ workerId: workerCredentials.workerId });
    return updated.length > 0;
  }).pipe(Effect.orDie);
