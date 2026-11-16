// Статика SPA с витриной: `index.html` отдаётся вариантом под хост запроса (бренд и способы
// входа подставляет `renderIndexHtml`), всё остальное — как раньше, `HttpStaticServer`.
import { BRANDS, brandForHost } from "@cg/brands";
import { Effect, FileSystem, Layer, Path } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
import { AppConfig } from "../config";
import { oauthForHost, renderIndexHtml } from "./indexHtml";
import { requestHost } from "./requestBrand";

/** Пути, которые обслуживают другие маршруты: сюда `index.html` витрины не подставляется. */
const isReservedPath = (pathname: string): boolean =>
  pathname === "/healthz" ||
  pathname === "/rpc" ||
  pathname === "/api" ||
  pathname.startsWith("/api/") ||
  pathname.startsWith("/stream/");

const safeDecode = (pathname: string): string => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

/** Страница SPA: последний сегмент пути без расширения файла (`/`, `/app/game/570`) и сам
 *  `/index.html` — исходный шаблон без витрины наружу не отдаётся. */
const isPagePath = (pathname: string): boolean =>
  pathname === "/index.html" ||
  (!isReservedPath(pathname) &&
    !(pathname.split("/").pop() ?? "").includes("."));

/**
 * Остальные GET: страницы SPA → `index.html` витрины хоста (шаблон читается при первом запросе
 * и кешируется, варианты — по ключу «витрина + флаги входа»); файлы — `HttpStaticServer`.
 * Нет собранного `index.html` — поведение статики как раньше (404), сервер не падает.
 */
export const BrandedStaticRoute = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const router = yield* HttpRouter.HttpRouter;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Без `spa`: страницы обслуживает этот маршрут, а встроенный SPA-откат статики отдал бы
    // исходный `index.html` без витрины (например, `/api/x` с `Accept: text/html`).
    const staticApp = yield* HttpStaticServer.make({
      root: config.webDistDir,
      spa: false,
    });
    const indexPath = path.join(config.webDistDir, "index.html");

    let template: string | undefined;
    const variants = new Map<string, string>();

    const variantFor = (headers: Headers) => {
      const host = requestHost(headers);
      const brand = BRANDS[brandForHost(host, config.brandHosts)];
      const oauth = oauthForHost(config, host);
      const key = `${brand.id}|${JSON.stringify(oauth)}`;
      const cached = variants.get(key);
      if (cached !== undefined || template === undefined) return cached;
      const html = renderIndexHtml(template, brand, oauth);
      variants.set(key, html);
      return html;
    };

    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = new URL(request.url, "http://localhost").pathname;
      // Статика ищет файл по декодированному пути: `/%69ndex.html` — тот же `/index.html`.
      if (isPagePath(safeDecode(pathname))) {
        if (template === undefined) {
          template = yield* fileSystem
            .readFileString(indexPath)
            .pipe(Effect.orElseSucceed(() => undefined));
        }
        const html = variantFor(new Headers(request.headers));
        if (html !== undefined) {
          return HttpServerResponse.text(html, {
            contentType: "text/html; charset=utf-8",
            // Варианты различаются по хосту: общий кеш не должен их смешивать.
            headers: {
              "cache-control": "no-cache",
              vary: "host, x-forwarded-host",
            },
          });
        }
      }
      return yield* staticApp;
    }).pipe(Effect.catch(HttpServerRespondable.toResponse));

    yield* router.add("GET", "/*", handler);
  }),
);
