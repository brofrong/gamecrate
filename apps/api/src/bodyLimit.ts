// Общий страж тела запроса — глобальный middleware роутера, срабатывает до поиска маршрута.
//
// Bun.serve разрешает тело до `serverMaxRequestBodySize` (≈ 501 МиБ) — это нужно только выкладке
// десктоп-сборок `PUT /download/desktop/*` (поток в бакет, свой лимит и свой 413 в маршруте).
// Остальные маршруты читают тело целиком в память (Better Auth — `getBody`, прокси стрима —
// `readStreamBody`), а у `cg-api` `mem_limit: 512m`: один анонимный POST на 500 МБ в `/api/auth/*`
// положил бы API. Поэтому для всего, кроме выкладки:
//   - `Content-Length` больше `maxBodyBytes` (1 МиБ) → 413, тело не читается;
//   - тело без `Content-Length` (chunked) → 411: длину заранее не проверить, а честным клиентам
//     (браузер, fetch, curl с -d) она известна всегда;
//   - кривой `Content-Length` → 400.
// Кто принимает тело и сколько: `/api/auth/*` — JSON форм входа (килобайты); `/stream/<id>/*` —
// мелкие запросы Selkies, свой предел `MAX_STREAM_BODY_BYTES` = 1 МиБ; `PUT /download/desktop/*`
// — до `maxUploadBytes`, chunked можно. `GET /rpc` (апгрейд WebSocket), `/healthz`, статика — без
// тела; сообщения RPC идут уже по WebSocket и этим стражем не меряются.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { maxUploadBytes } from "./download/routes";

/** Предел тела для всех маршрутов, кроме выкладки десктоп-сборок. */
export const maxBodyBytes = 1024 * 1024;

/**
 * `maxRequestBodySize` для Bun.serve (main.ts): по умолчанию Bun режет на 128 МБ, а выкладка —
 * до `maxUploadBytes`. Запас в 1 МиБ — чтобы сверх лимита ответил сам маршрут (413), а не обрыв
 * потока в Bun.
 */
export const serverMaxRequestBodySize = maxUploadBytes + 1024 * 1024;

/** Ровно маршруты выкладки: `latest.json` или `<версия>/<файл>`, без лишних сегментов. */
const desktopUploadPath =
  /^\/download\/desktop\/(?:latest\.json|[^/?#]+\/[^/?#]+)(?:\?.*)?$/;

/** `PUT /download/desktop/*` — единственное, чему можно большое и chunked тело. */
export const isDesktopUpload = (method: string, url: string): boolean =>
  method === "PUT" && desktopUploadPath.test(url);

/**
 * Решение по заголовкам: `undefined` — пропустить, иначе код ответа. `hasBody` — у запроса есть
 * поток тела (Bun даёт `body === null`, если тела нет).
 */
export const bodyVerdict = (
  headers: Readonly<Record<string, string | undefined>>,
  hasBody: boolean,
): 400 | 411 | 413 | undefined => {
  const length = headers["content-length"];
  if (length !== undefined) {
    if (!/^\d+$/.test(length)) return 400;
    return Number(length) > maxBodyBytes ? 413 : undefined;
  }
  if (headers["transfer-encoding"] !== undefined || hasBody) return 411;
  return undefined;
};

const texts = {
  400: "Bad Content-Length",
  411: "Length required",
  413: "Payload too large",
} as const;

/** Есть ли у запроса тело: у Bun и `toWebHandler` источник — web `Request`. */
const hasBody = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.source instanceof Request
    ? request.source.body !== null
    : request.headers["transfer-encoding"] !== undefined;

/** Глобальный middleware: в `HttpApp` (http.ts), действует на все маршруты и на 404. */
export const BodyLimit = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      if (isDesktopUpload(request.method, request.url)) return httpEffect;
      const verdict = bodyVerdict(request.headers, hasBody(request));
      return verdict === undefined
        ? httpEffect
        : Effect.succeed(
            HttpServerResponse.text(texts[verdict], { status: verdict }),
          );
    }),
  { global: true },
);
