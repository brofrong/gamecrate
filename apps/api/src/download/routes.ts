// Раздача десктоп-сборок (публично, без входа):
//   GET /download/desktop/latest.json        — манифест updater Tauri (`no-cache`);
//   GET /download/desktop/<версия>/<файл>    — установщик или `.sig` потоком из бакета.
// Выкладка (джоб `publish` в `.github/workflows/desktop.yml`; RustFS снаружи docker-сети не виден):
//   PUT /download/desktop/latest.json, PUT /download/desktop/<версия>/<файл>
//   с `Authorization: Bearer <DESKTOP_UPLOAD_TOKEN>` → 201. Нет токена в конфиге — 404, неверный
//   или нет заголовка — 401, тело больше `maxUploadBytes` — 413, пустое тело — 400. Файл версии,
//   который уже выложен, — 409 (выложенная версия неизменна, у её файлов кэш `immutable`);
//   `latest.json` перезаписывается. Тело идёт в бакет потоком. Большое и chunked тело можно только
//   здесь — остальным маршрутам общий страж (bodyLimit.ts) оставляет 1 МиБ. Сам токен никуда не
//   пишется (в логе — только ключ объекта и текст ошибки S3).
// Версия — только `X.Y.Z`, файл — только `[A-Za-z0-9._-]+`, не `.`/`..`: путь в бакете строится
// из этих двух сегментов, так что выйти из префикса или попасть в чужой объект нельзя. Версионные
// файлы неизменны (новая версия — новый путь), поэтому кэш `immutable`. Нет объекта или
// хранилище не настроено — 404; сбой хранилища — 502. Всё остальное под `/download/desktop/` —
// тоже 404, иначе его подхватил бы SPA-фолбэк статики (200 с `index.html` вместо файла).
import { createHash, timingSafeEqual } from "node:crypto";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { desktopConfig } from "../config";
import {
  contentTypeOf,
  DesktopReleases,
  type DesktopReleasesShape,
} from "./DesktopReleases";

/** Лимит тела выкладки: установщики 100–300 МБ с запасом. */
export const maxUploadBytes = 500 * 1024 * 1024;

export type DesktopUploadShape = {
  /** `DESKTOP_UPLOAD_TOKEN`; `None` — выкладка выключена (`PUT` → 404). */
  readonly token: Option.Option<Redacted.Redacted<string>>;
  readonly maxBytes: number;
};

/** Настройки выкладки сборок через API. */
export class DesktopUpload extends Context.Service<
  DesktopUpload,
  DesktopUploadShape
>()("@cg/api/DesktopUpload") {
  /** Из окружения (`DESKTOP_UPLOAD_TOKEN`), лимит — `maxUploadBytes`. */
  static readonly layer: Layer.Layer<DesktopUpload> = Layer.effect(
    DesktopUpload,
    desktopConfig.pipe(
      Effect.orDie,
      Effect.map((config) => ({
        token: config.uploadToken,
        maxBytes: maxUploadBytes,
      })),
    ),
  );

  /** Выкладка выключена. */
  static readonly none: Layer.Layer<DesktopUpload> = Layer.succeed(
    DesktopUpload,
    { token: Option.none(), maxBytes: maxUploadBytes },
  );

  /** С заданным токеном (тесты). */
  static readonly withToken = (
    token: string,
    maxBytes: number = maxUploadBytes,
  ): Layer.Layer<DesktopUpload> =>
    Layer.succeed(DesktopUpload, {
      token: Option.some(Redacted.make(token)),
      maxBytes,
    });
}

const versionPattern = /^\d+\.\d+\.\d+$/;
const filePattern = /^[A-Za-z0-9._-]{1,200}$/;
/** `/download/desktop/<версия>/<файл>` и больше ничего (без query-части). */
const filePath = /^\/download\/desktop\/([^/?#]+)\/([^/?#]+)(?:\?.*)?$/;

const notFound = () => HttpServerResponse.text("Not found", { status: 404 });

const decode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

/** Объект `key` из бакета ответом: 200 потоком, 404, если нет, 502 при сбое хранилища. */
const serve = (
  releases: DesktopReleasesShape,
  key: string,
  cacheControl: string,
) =>
  releases.get(key).pipe(
    Effect.map(
      Option.match({
        onNone: notFound,
        onSome: (object) =>
          HttpServerResponse.fromWeb(
            new Response(object.body, {
              headers: {
                "content-type": object.contentType,
                "content-length": String(object.size),
                "cache-control": cacheControl,
              },
            }),
          ),
      }),
    ),
    // в сообщении ошибки нет ключей доступа, только код и путь объекта
    Effect.catch((error) =>
      Effect.logWarning(`desktop download: ${key}: ${error.message}`).pipe(
        Effect.as(
          HttpServerResponse.text("Storage unavailable", { status: 502 }),
        ),
      ),
    ),
  );

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

/**
 * `Authorization: Bearer <токен>` совпадает с ожидаемым. Сравниваются SHA-256 обоих значений
 * за постоянное время: ни длина, ни общий префикс по времени ответа не угадываются.
 */
const bearerMatches = (
  header: string | undefined,
  token: Redacted.Redacted<string>,
): boolean => {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "");
  if (match?.[1] === undefined) return false;
  return timingSafeEqual(sha256(match[1]), sha256(Redacted.value(token)));
};

/** Длина из `Content-Length`; `undefined` — нет или не число. */
const declaredLength = (header: string | undefined): number | undefined => {
  if (header === undefined || !/^\d+$/.test(header)) return undefined;
  return Number(header);
};

const status = (text: string, code: number) =>
  HttpServerResponse.text(text, { status: code });

/**
 * Поток `body`, если в нём есть хоть один байт, иначе `undefined` (пустое chunked-тело). Пустые
 * куски в начале пропускаются, первый непустой возвращается в поток, остальное читается дальше.
 */
const nonEmpty = async (
  body: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array> | undefined> => {
  const reader = body.getReader();
  let first: Uint8Array | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return undefined;
    if (value.byteLength > 0) {
      first = value;
      break;
    }
  }
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(first);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
};

/**
 * Принять тело `PUT` в бакет под ключом `key`. Порядок: выкладка выключена → 404; токен → 401;
 * путь → 404; размер → 413; файл версии уже есть → 409; пустое тело → 400; тело потоком в
 * хранилище → 201 (сбой хранилища — 502).
 */
const receive = (
  releases: DesktopReleasesShape,
  upload: DesktopUploadShape,
  request: HttpServerRequest.HttpServerRequest,
  key: string | undefined,
) =>
  Effect.gen(function* () {
    if (Option.isNone(upload.token)) return notFound();
    if (!bearerMatches(request.headers.authorization, upload.token.value))
      return status("Unauthorized", 401);
    if (key === undefined) return notFound();
    const length = declaredLength(request.headers["content-length"]);
    if (length !== undefined && length > upload.maxBytes)
      return status("Payload too large", 413);
    // Проверка и запись не атомарны: два публикатора одной версии одновременно могут оба получить
    // 201. Публикатор один (джоб `publish`, тег — одна версия), гонкой пренебрегаем.
    if (key !== "latest.json") {
      const taken = yield* releases.exists(key).pipe(Effect.result);
      if (taken._tag === "Failure")
        return yield* Effect.logWarning(
          `desktop upload: ${key}: ${taken.failure.message}`,
        ).pipe(Effect.as(status("Storage unavailable", 502)));
      if (taken.success) return status("Version already published", 409);
    }
    const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    const raw = web.body;
    if (raw === null || length === 0) return status("Empty body", 400);
    // клиент оборвал тело до первого байта — то же, что пустое
    const filled = yield* Effect.tryPromise(() => nonEmpty(raw)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (filled === undefined) return status("Empty body", 400);
    // тело без Content-Length (chunked) считаем по ходу; лишний байт — поток рвётся, объекта нет
    let received = 0;
    let tooLarge = false;
    const body = filled.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > upload.maxBytes) {
            tooLarge = true;
            controller.error(new Error("payload too large"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return yield* releases.put(key, body, contentTypeOf(key)).pipe(
      Effect.as(status("Created", 201)),
      Effect.catch((error) =>
        tooLarge
          ? Effect.succeed(status("Payload too large", 413))
          : Effect.logWarning(`desktop upload: ${key}: ${error.message}`).pipe(
              Effect.as(status("Storage unavailable", 502)),
            ),
      ),
    );
  });

/** Ключ объекта по пути запроса; `undefined` — путь не по шаблону (→ 404). */
const objectKey = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined => {
  const match = filePath.exec(request.url);
  if (match === null) return undefined;
  const version = decode(match[1] ?? "");
  const file = decode(match[2] ?? "");
  if (
    version === undefined ||
    file === undefined ||
    !versionPattern.test(version) ||
    !filePattern.test(file) ||
    file === "." ||
    file === ".."
  )
    return undefined;
  return `${version}/${file}`;
};

export const DesktopRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const releases = yield* DesktopReleases;
    const upload = yield* DesktopUpload;
    yield* router.add("GET", "/download/desktop/latest.json", () =>
      serve(releases, "latest.json", "no-cache"),
    );
    yield* router.add("PUT", "/download/desktop/latest.json", (request) =>
      receive(releases, upload, request, "latest.json"),
    );
    yield* router.add("PUT", "/download/desktop/:version/:file", (request) =>
      receive(releases, upload, request, objectKey(request)),
    );
    yield* router.add("GET", "/download/desktop/:version/:file", (request) => {
      const key = objectKey(request);
      return key === undefined
        ? Effect.succeed(notFound())
        : serve(releases, key, "public, max-age=31536000, immutable");
    });
    // Не `"*"`: он занял бы и HEAD, а HEAD без своего маршрута роутер сам отдаёт GET-маршрутам
    // (`curl -I` и менеджеры загрузок видят настоящий размер файла).
    for (const method of [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "QUERY",
    ] as const) {
      yield* router.add(method, "/download/desktop/*", () =>
        Effect.succeed(notFound()),
      );
    }
  }),
);
