// Раздача десктоп-сборок (публично, без входа):
//   GET /download/desktop/latest.json        — манифест updater Tauri (`no-cache`);
//   GET /download/desktop/<версия>/<файл>    — установщик или `.sig` потоком из бакета.
// Версия — только `X.Y.Z`, файл — только `[A-Za-z0-9._-]+`, не `.`/`..`: путь в бакете строится
// из этих двух сегментов, так что выйти из префикса или попасть в чужой объект нельзя. Версионные
// файлы неизменны (новая версия — новый путь), поэтому кэш `immutable`. Нет объекта или
// хранилище не настроено — 404; сбой хранилища — 502. Всё остальное под `/download/desktop/` —
// тоже 404, иначе его подхватил бы SPA-фолбэк статики (200 с `index.html` вместо файла).
import { Effect, Option } from "effect";
import {
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { DesktopReleases, type DesktopReleasesShape } from "./DesktopReleases";

const versionPattern = /^\d+\.\d+\.\d+$/;
const filePattern = /^[A-Za-z0-9._-]+$/;
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
const serve = (releases: DesktopReleasesShape, key: string, cacheControl: string) =>
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
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text("Storage unavailable", { status: 502 }),
      ),
    ),
  );

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
    yield* router.add("GET", "/download/desktop/latest.json", () =>
      serve(releases, "latest.json", "no-cache"),
    );
    yield* router.add("GET", "/download/desktop/:version/:file", (request) => {
      const key = objectKey(request);
      return key === undefined
        ? Effect.succeed(notFound())
        : serve(releases, key, "public, max-age=31536000, immutable");
    });
    yield* router.add("*", "/download/desktop/*", () =>
      Effect.succeed(notFound()),
    );
  }),
);
