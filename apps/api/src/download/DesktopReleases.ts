// Хранилище десктоп-сборок: бакет `cg-desktop` в `cg-rustfs` (S3, path-style, как
// `apps/agent/src/profile/ProfileStore.ts`), API только читает. Ключи объектов:
// `latest.json` (манифест updater) и `<версия>/<файл>` (установщики, `.sig`).
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { desktopConfig } from "../config";

/** Сбой хранилища (RustFS недоступен и т. п.); содержимое объектов и ключи в `message` не попадают. */
export class DesktopReleasesError extends Schema.TaggedError<DesktopReleasesError>()(
  "DesktopReleasesError",
  { message: Schema.String },
) {}

export type DesktopObject = {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly contentType: string;
};

export interface DesktopReleasesShape {
  /** Объект по ключу; `None` — его нет (или хранилище не настроено). */
  readonly get: (
    key: string,
  ) => Effect.Effect<Option.Option<DesktopObject>, DesktopReleasesError>;
}

const octet = "application/octet-stream";

/** Тип содержимого по расширению: объекты кладут разными инструментами, их метаданным не верим. */
export const contentTypeOf = (key: string): string => {
  const name = key.toLowerCase();
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".deb")) return "application/vnd.debian.binary-package";
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz"))
    return "application/gzip";
  if (name.endsWith(".sig")) return "text/plain; charset=utf-8";
  return octet;
};

/** S3 «объекта нет»: у Bun это `S3Error` с кодом `NoSuchKey`/`NotFound`. */
const isMissing = (cause: unknown): boolean => {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === "NoSuchKey" || code === "NotFound";
};

const failure = (cause: unknown): DesktopReleasesError =>
  new DesktopReleasesError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

export type DesktopReleasesOptions = {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

/** Клиент на `Bun.S3Client`: размер из HEAD, тело — поток (в память файл не читаем). */
export const make = (options: DesktopReleasesOptions): DesktopReleasesShape => {
  const client = new Bun.S3Client({
    endpoint: options.endpoint,
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    virtualHostedStyle: false,
  });
  return {
    get: (key) =>
      Effect.tryPromise({
        try: async () => {
          const file = client.file(key);
          const stat = await file.stat().then(
            (value) => value,
            (cause: unknown) => {
              if (isMissing(cause)) return null;
              throw cause;
            },
          );
          if (stat === null) return Option.none<DesktopObject>();
          return Option.some<DesktopObject>({
            body: file.stream(),
            size: stat.size,
            contentType: contentTypeOf(key),
          });
        },
        catch: failure,
      }),
  };
};

export class DesktopReleases extends Context.Service<
  DesktopReleases,
  DesktopReleasesShape
>()("@cg/api/DesktopReleases") {
  static readonly make = make;

  /** Без ключей S3: ничего не раздаём (маршруты отвечают 404), API при этом стартует как прежде. */
  static readonly disabled: Layer.Layer<DesktopReleases> = Layer.succeed(
    DesktopReleases,
    { get: () => Effect.succeed(Option.none()) },
  );

  /** Из окружения (`desktopConfig`): ключи заданы — `Bun.S3Client`, нет — `disabled`. */
  static readonly layer: Layer.Layer<DesktopReleases> = Layer.unwrap(
    desktopConfig.pipe(
      Effect.orDie,
      Effect.map((config) =>
        Option.match(config.credentials, {
          onNone: () => DesktopReleases.disabled,
          onSome: ({ accessKey, secretKey }) =>
            Layer.succeed(
              DesktopReleases,
              make({
                endpoint: config.endpoint,
                bucket: config.bucket,
                accessKeyId: Redacted.value(accessKey),
                secretAccessKey: Redacted.value(secretKey),
              }),
            ),
        }),
      ),
    ),
  );

  /** Тестовый слой: объекты в `Map` (ключ → тело). */
  static readonly test = (
    objects: ReadonlyMap<string, { readonly body: Uint8Array }>,
  ): Layer.Layer<DesktopReleases> =>
    Layer.succeed(DesktopReleases, {
      get: (key) =>
        Effect.sync(() => {
          const object = objects.get(key);
          if (object === undefined) return Option.none<DesktopObject>();
          const bytes = object.body;
          return Option.some<DesktopObject>({
            body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(),
            size: bytes.length,
            contentType: contentTypeOf(key),
          });
        }),
    });
}
