// Хранилище зашифрованных профилей в S3-совместимом бакете (RustFS), поверх
// `Bun.S3Client` (path-style). Расшифровка/шифровка — `./codec`.
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { AgentConfig } from "../config";
import {
  importProfileKey,
  openProfile,
  type ProfileKeyInvalid,
  sealProfile,
} from "./codec";

/**
 * Ошибка хранилища: сбой сети/S3 (`operation` — `get`/`put`/`remove`) либо
 * повреждённый объект, обёрнутый из `ProfileCorrupt`. Тело объекта и ключ
 * шифрования в `message` никогда не попадают.
 */
export class ProfileStoreError extends Schema.TaggedError<ProfileStoreError>()(
  "ProfileStoreError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface ProfileStoreShape {
  /** Расшифрованный tar профиля по ключу объекта. */
  readonly get: (
    objectKey: string,
  ) => Effect.Effect<Uint8Array, ProfileStoreError>;
  /**
   * Шифрует и загружает `tar`; ключ объекта —
   * `profiles/<userId>/<crypto.randomUUID()>.cgp`. `sizeBytes` — размер
   * зашифрованного (не исходного) объекта.
   */
  readonly put: (
    userId: string,
    tar: Uint8Array,
  ) => Effect.Effect<
    { readonly objectKey: string; readonly sizeBytes: number },
    ProfileStoreError
  >;
  readonly remove: (
    objectKey: string,
  ) => Effect.Effect<void, ProfileStoreError>;
}

export interface ProfileStoreOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly profileKey: CryptoKey;
}

/** Оборачивает причину отказа промиса S3 в `ProfileStoreError`. */
const toStoreError =
  (operation: string) =>
  (cause: unknown): ProfileStoreError =>
    new ProfileStoreError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    });

/** Клиент хранилища профилей на `Bun.S3Client` с заданными параметрами доступа. */
export const make = (options: ProfileStoreOptions): ProfileStoreShape => {
  const client = new Bun.S3Client({
    endpoint: options.endpoint,
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    virtualHostedStyle: false,
  });

  return {
    get: (objectKey) =>
      Effect.gen(function* () {
        const buffer = yield* Effect.tryPromise({
          try: () => client.file(objectKey).arrayBuffer(),
          catch: toStoreError("get"),
        });
        return yield* openProfile(
          new Uint8Array(buffer),
          options.profileKey,
        ).pipe(
          Effect.mapError(
            (error) =>
              new ProfileStoreError({
                operation: "get",
                message: error.reason,
              }),
          ),
        );
      }),

    put: (userId, tar) =>
      Effect.gen(function* () {
        const sealed = yield* sealProfile(tar, options.profileKey);
        const objectKey = `profiles/${userId}/${crypto.randomUUID()}.cgp`;
        yield* Effect.tryPromise({
          try: () => client.write(objectKey, sealed),
          catch: toStoreError("put"),
        });
        return { objectKey, sizeBytes: sealed.length };
      }),

    remove: (objectKey) =>
      Effect.tryPromise({
        try: () => client.delete(objectKey),
        catch: toStoreError("remove"),
      }).pipe(Effect.asVoid),
  };
};

export class ProfileStore extends Context.Service<
  ProfileStore,
  ProfileStoreShape
>()("@cg/agent/ProfileStore") {
  static readonly make = make;
  /** Слой из `AgentConfig`: endpoint/bucket/ключи S3 и `PROFILE_KEY` (base64, 32 байта). */
  static readonly layer: Layer.Layer<
    ProfileStore,
    ProfileKeyInvalid,
    AgentConfig
  > = Layer.effect(
    ProfileStore,
    Effect.gen(function* () {
      const config = yield* AgentConfig;
      const profileKey = yield* importProfileKey(config.profileKey);
      return make({
        endpoint: config.s3Endpoint,
        bucket: config.s3Bucket,
        accessKeyId: Redacted.value(config.s3AccessKey),
        secretAccessKey: Redacted.value(config.s3SecretKey),
        profileKey,
      });
    }),
  );
}
