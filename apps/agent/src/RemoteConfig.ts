// RemoteConfig: S3 профилей и PROFILE_KEY, которые агент получает с главного
// (`GET /agent/config`, задача 3 — спека §3 «Конфиг с главного»). Раньше эти
// секреты читались из окружения агента; теперь их хранит только оркестратор,
// у агента — только WORKER_TOKEN.
import { Duration, Effect, Redacted, Schema } from "effect";

/**
 * base64 ровно 32 байт (AES-256), как генерирует `openssl rand -base64 32`:
 * 43 символа и один `=` — та же проверка, что у `PROFILE_KEY` оркестратора
 * (`apps/orchestrator/src/config.ts`).
 */
const base64Key32Pattern = /^[A-Za-z0-9+/]{43}=$/;

/** Тело ответа `GET /agent/config` (оркестратор, `apps/orchestrator/src/http.ts`). */
const RemoteConfigResponse = Schema.Struct({
  s3: Schema.Struct({
    endpoint: Schema.String,
    bucket: Schema.String,
    accessKey: Schema.String,
    secretKey: Schema.String,
  }),
  profileKey: Schema.String,
});

/** S3 профилей и ключ шифрования, полученные от оркестратора. */
export interface RemoteConfigValues {
  readonly s3Endpoint: string;
  readonly s3Bucket: string;
  readonly s3AccessKey: Redacted.Redacted<string>;
  readonly s3SecretKey: Redacted.Redacted<string>;
  readonly profileKey: Redacted.Redacted<string>;
}

/**
 * Сеть недоступна, нет ответа или HTTP-статус не 200/401 (в т.ч. 5xx) —
 * `fetchRemoteConfig` повторяет запрос сам (оркестратор может быть временно
 * недоступен, например во время своего деплоя).
 */
export class RemoteConfigUnreachable extends Schema.TaggedError<RemoteConfigUnreachable>()(
  "RemoteConfigUnreachable",
  { reason: Schema.String },
) {}

/**
 * HTTP 401: `WORKER_TOKEN` не действует. Может быть выдан заново (обмен кода
 * подключения повторили) — тоже повторяется, а не фатально.
 */
export class RemoteConfigUnauthorized extends Schema.TaggedError<RemoteConfigUnauthorized>()(
  "RemoteConfigUnauthorized",
  {},
) {}

/**
 * Ответ 200, но данные не той формы — например `profileKey` не base64 ровно
 * 32 байт. Повтор того же запроса даст тот же неверный ответ, поэтому это
 * фатальная ошибка конфигурации — `fetchRemoteConfig` её не повторяет.
 */
export class RemoteConfigInvalid extends Schema.TaggedError<RemoteConfigInvalid>()(
  "RemoteConfigInvalid",
  { reason: Schema.String },
) {}

export type RemoteConfigError =
  RemoteConfigUnreachable | RemoteConfigUnauthorized | RemoteConfigInvalid;

/**
 * Один запрос `GET url` с `Authorization: Bearer <token>`, без повтора.
 * Секреты ответа никогда не попадают в ошибку — только текст причины сбоя
 * сети/разбора.
 */
const attempt = (
  url: string,
  token: Redacted.Redacted<string>,
): Effect.Effect<RemoteConfigValues, RemoteConfigError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          headers: { authorization: `Bearer ${Redacted.value(token)}` },
        }),
      catch: (error) =>
        new RemoteConfigUnreachable({
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
    if (response.status === 401)
      return yield* Effect.fail(new RemoteConfigUnauthorized());
    if (!response.ok)
      return yield* Effect.fail(
        new RemoteConfigUnreachable({ reason: `HTTP ${response.status}` }),
      );
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (error) =>
        new RemoteConfigUnreachable({
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
    const decoded = yield* Schema.decodeUnknownEffect(RemoteConfigResponse)(
      body,
    ).pipe(
      Effect.mapError(
        (error) => new RemoteConfigInvalid({ reason: String(error) }),
      ),
    );
    if (!base64Key32Pattern.test(decoded.profileKey))
      return yield* Effect.fail(
        new RemoteConfigInvalid({
          reason: "profileKey: ожидается base64 ровно 32 байт",
        }),
      );
    return {
      s3Endpoint: decoded.s3.endpoint,
      s3Bucket: decoded.s3.bucket,
      s3AccessKey: Redacted.make(decoded.s3.accessKey),
      s3SecretKey: Redacted.make(decoded.s3.secretKey),
      profileKey: Redacted.make(decoded.profileKey),
    } satisfies RemoteConfigValues;
  });

/** Задержки повтора: от 1 с, удвоение до потолка 30 с. */
export const RETRY_MIN = Duration.seconds(1);
export const RETRY_MAX = Duration.seconds(30);

/**
 * `GET url` (с `Authorization: Bearer <token>`) с повтором без предела по
 * числу попыток: сеть, 5xx или 401 (токен могли выпустить заново обменом
 * кода) — лог раз в попытку и пауза (экспоненциально 1 с → 30 с);
 * `RemoteConfigInvalid` (данные ответа не той формы, например неверный
 * `profileKey`) не повторяется — тот же запрос даст тот же неверный ответ,
 * это фатальная ошибка конфигурации. Секреты (ключи S3, `profileKey`) в лог
 * не попадают — причина сбоя не несёт тела ответа.
 */
export const fetchRemoteConfig = (
  url: string,
  token: Redacted.Redacted<string>,
): Effect.Effect<RemoteConfigValues, RemoteConfigError> =>
  Effect.gen(function* () {
    let delay = RETRY_MIN;
    while (true) {
      const result = yield* Effect.result(attempt(url, token));
      if (result._tag === "Success") return result.success;
      const error = result.failure;
      if (error._tag === "RemoteConfigInvalid")
        return yield* Effect.fail(error);
      yield* error._tag === "RemoteConfigUnauthorized"
        ? Effect.logWarning("Worker token rejected by orchestrator")
        : Effect.logWarning("Waiting for orchestrator config", {
            reason: error.reason,
          });
      yield* Effect.sleep(delay);
      delay = Duration.min(Duration.times(delay, 2), RETRY_MAX);
    }
  });
