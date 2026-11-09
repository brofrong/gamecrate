// WorkerAuth: аутентификация игровых серверов их собственными токенами (спека
// §3, вместо общего `AGENT_TOKEN`). Проверка токена (апгрейд `GET /agent`,
// `/agent/config`, тоннель стрима), обмен одноразового кода подключения на
// постоянный токен (`POST /agent/enroll`) и фоновое отключение серверов, чей
// токен отозвали или заменили. В БД — только SHA-256 токенов и кодов
// (`sha256Hex`), сами значения не логируются.
import {
  Db,
  newWorkerToken,
  regions,
  sha256Hex,
  workerCredentials,
  workerOfTokenHash,
  workers,
} from "@cg/db";
import { and, eq, gt } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Option } from "effect";
import { AgentHub } from "./AgentHub";

/** Как часто проверять, действуют ли токены подключённых серверов. */
export const REVOKE_CHECK_MS = 10_000;

/** Итог обмена кода: сервер, его новый постоянный токен и код региона (`null` — без региона). */
export interface Enrollment {
  readonly workerId: string;
  readonly token: string;
  readonly regionCode: string | null;
}

export interface WorkerAuthShape {
  /**
   * Сервер по действующему токену: хэш совпал, токен не отозван. Токен
   * сравнивается через свой SHA-256 (поиск по индексу `token_hash`), так
   * что время ответа не зависит от совпадающего префикса самого токена.
   */
  readonly workerOfToken: (
    token: string,
  ) => Effect.Effect<Option.Option<string>>;
  /**
   * Обменять одноразовый код подключения на постоянный токен: одним
   * `UPDATE … WHERE enroll_code_hash = … AND enroll_expires_at > now`
   * (атомарно — из двух одновременных обменов одного кода проходит один)
   * пишет новый `token_hash`, `token_issued_at = now`, снимает `revoked_at`
   * и обнуляет код. Прежний токен сервера (если был) перестаёт действовать,
   * его соединение закроет фоновая проверка. Код не подошёл или истёк —
   * `None`.
   */
  readonly enroll: (
    code: string,
    now: Date,
  ) => Effect.Effect<Option.Option<Enrollment>>;
}

/** Токен из `Authorization: Bearer <токен>`; другой схемы или пусто — `undefined`. */
export const bearerToken = (
  authorization: string | undefined,
): string | undefined => /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];

const make = Effect.gen(function* () {
  const db = yield* Db;
  const hub = yield* AgentHub;

  const workerOfToken: WorkerAuthShape["workerOfToken"] = (token) =>
    workerOfTokenHash(sha256Hex(token)).pipe(Effect.provideService(Db, db));

  const enroll: WorkerAuthShape["enroll"] = (code, now) =>
    Effect.gen(function* () {
      const token = newWorkerToken();
      const [enrolled] = yield* db
        .update(workerCredentials)
        .set({
          tokenHash: sha256Hex(token),
          tokenIssuedAt: now,
          revokedAt: null,
          enrollCodeHash: null,
          enrollExpiresAt: null,
        })
        .where(
          and(
            eq(workerCredentials.enrollCodeHash, sha256Hex(code)),
            gt(workerCredentials.enrollExpiresAt, now),
          ),
        )
        .returning({ workerId: workerCredentials.workerId });
      if (enrolled === undefined) return Option.none();
      const [region] = yield* db
        .select({ code: regions.code })
        .from(workers)
        .innerJoin(regions, eq(regions.id, workers.regionId))
        .where(eq(workers.id, enrolled.workerId));
      return Option.some({
        workerId: enrolled.workerId,
        token,
        regionCode: region?.code ?? null,
      });
    }).pipe(Effect.orDie);

  /**
   * Подключённые серверы, чей токен (тот, с которым подключилось текущее
   * соединение) больше не действует — отозван или заменён обменом нового
   * кода, — отключаются (`hub.disconnect`); заново агент не войдёт: апгрейд
   * с тем же токеном получит 401. Перед отключением хэш сверяется ещё раз:
   * за время запроса соединение могли заменить новым, на действующем токене.
   */
  const kickRevoked = Effect.gen(function* () {
    for (const workerId of hub.connected()) {
      const tokenHash = hub.tokenHash(workerId);
      if (tokenHash === undefined) continue;
      const owner = yield* workerOfTokenHash(tokenHash).pipe(
        Effect.provideService(Db, db),
      );
      if (Option.getOrUndefined(owner) === workerId) continue;
      if (hub.tokenHash(workerId) !== tokenHash) continue;
      yield* Effect.logWarning(
        "Worker token is no longer valid, disconnecting its agent",
        { workerId },
      );
      yield* hub.disconnect(workerId);
    }
  });

  // Сбой проверки (БД недоступна) не останавливает цикл: следующая — через
  // REVOKE_CHECK_MS.
  yield* kickRevoked.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Revoked worker token check failed", { cause }),
    ),
    Effect.delay(Duration.millis(REVOKE_CHECK_MS)),
    Effect.forever,
    Effect.forkScoped,
  );

  return { workerOfToken, enroll } satisfies WorkerAuthShape;
});

export class WorkerAuth extends Context.Service<WorkerAuth, WorkerAuthShape>()(
  "@cg/orchestrator/WorkerAuth",
) {
  /** Сервис и фоновая проверка отзыва (живёт, пока жив слой). */
  static readonly layer: Layer.Layer<WorkerAuth, never, Db | AgentHub> =
    Layer.effect(WorkerAuth, make);
}
