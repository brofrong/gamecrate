// Прокси стрима: `ANY /stream/<sessionId>/*` → Selkies сессии (`streamUrl`,
// внутренний адрес в сети `cg-sessions`), HTTP и WebSocket.
//
// Доступ: только владелец (cookie Better Auth), только активная сессия с готовым
// стримом. WebSocket-апгрейд и небезопасные методы (POST и т. п.) — только с
// Origin из `rpcAllowedOrigins` (как `/rpc`: cookie SameSite=Lax уходит и с
// соседних поддоменов). Любой отказ — 403 (не 404: существование чужих сессий
// не раскрывается).
//
// Запрос к Selkies (решение R2): путь без префикса `/stream/<id>`; `Host` —
// хост `streamUrl` (его ставит HTTP/WS-клиент по URL); `Origin` браузера
// убирается после нашей проверки — Selkies пропускает WS без Origin, а с
// публичным Origin и `Host` контейнера отвечает 403 (проверено в Task 5);
// cookie (наша сессия Better Auth) и `Referer` не передаются. `Set-Cookie`
// Selkies браузеру не отдаётся — контейнер не может ставить cookie нашему домену.
// Selkies ещё не поднялся (отказ соединения, таймаут) — 502.
import { Db } from "@cg/db";
import { Effect } from "effect";
import {
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import { BetterAuth } from "../auth/auth";
import { AppConfig, rpcAllowedOrigins } from "../config";
import { streamUrlOf } from "./SessionRepo";

/** `/stream/<id>` и остаток пути (с начальным `/`, если есть). */
const streamPath = /^\/stream\/([^/?#]+)(\/[^?#]*)?$/;

/** Сколько ждём ответа (заголовков) или открытия WebSocket от Selkies. */
const upstreamTimeout = "10 seconds";

/** Заголовки запроса, которые не уходят в Selkies. */
const droppedRequestHeaders = new Set([
  // Свои значения ставит клиент по URL апстрима / не нужны Selkies.
  "host",
  "origin",
  "referer",
  "cookie",
  "authorization",
  // Сжатие: fetch Bun сам распаковывает ответ — просим без сжатия.
  "accept-encoding",
  "content-length",
  // Hop-by-hop.
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Заголовки ответа Selkies, которые не уходят браузеру. */
const droppedResponseHeaders = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const forbidden = HttpServerResponse.text("Forbidden", { status: 403 });
const badGateway = HttpServerResponse.text("Стрим ещё не готов", {
  status: 502,
});

const isSafeMethod = (method: string) =>
  method === "GET" || method === "HEAD" || method === "OPTIONS";

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["upgrade"]?.toLowerCase() === "websocket";

/** Адрес Selkies из БД: только http(s) без учётных данных, иначе undefined. */
const parseStreamUrl = (streamUrl: string): URL | undefined => {
  try {
    const url = new URL(streamUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    return url;
  } catch {
    return undefined;
  }
};

/** URL апстрима: путь `streamUrl` + остаток пути после `/stream/<id>` + query. */
const upstreamUrl = (base: URL, rest: string, search: string) => {
  const url = new URL(base.href);
  url.pathname = base.pathname.replace(/\/+$/, "") + rest;
  url.search = search;
  url.hash = "";
  return url;
};

const forwardRequestHeaders = (
  request: HttpServerRequest.HttpServerRequest,
) => {
  const headers = new globalThis.Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!droppedRequestHeaders.has(name.toLowerCase()))
      headers.set(name, value);
  }
  return headers;
};

const forwardResponse = (response: Response) => {
  const headers = new globalThis.Headers();
  response.headers.forEach((value, name) => {
    if (!droppedResponseHeaders.has(name.toLowerCase()))
      headers.set(name, value);
  });
  // fetch уже распаковал тело: исходные кодировка и длина к нему не относятся.
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return HttpServerResponse.fromWeb(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
};

/** HTTP-запрос к Selkies; нет соединения/таймаут — 502. */
const proxyHttp = (
  request: HttpServerRequest.HttpServerRequest,
  target: URL,
  sessionId: string,
) =>
  Effect.gen(function* () {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? yield* request.arrayBuffer : undefined;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(target, {
          method: request.method,
          headers: forwardRequestHeaders(request),
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal,
        }),
      catch: (cause) => cause,
    }).pipe(Effect.timeout(upstreamTimeout));
    return forwardResponse(response);
  }).pipe(
    Effect.catch((cause) =>
      Effect.as(
        Effect.logWarning("Stream upstream HTTP request failed", {
          sessionId,
          cause: String(cause),
        }),
        badGateway,
      ),
    ),
  );

/** Коды закрытия, которые можно отправить в кадре Close (RFC 6455 §7.4). */
const sendableCloseCode = (code: number, browserApi: boolean) =>
  code === 1000 ||
  (code >= 3000 && code <= 4999) ||
  (!browserApi &&
    ((code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014)));

/**
 * Закрытие для второй стороны, когда первая закрылась или упала. `browserApi` —
 * сторона за WebSocket-клиентом (Selkies): его `close()` принимает только
 * 1000 и 3000–4999.
 */
const closeFor = (error: Socket.SocketError, browserApi: boolean) => {
  const reason = error.reason;
  if (reason._tag === "SocketCloseError") {
    if (sendableCloseCode(reason.code, browserApi))
      return new Socket.CloseEvent(reason.code, reason.closeReason);
    if (browserApi || reason.code === 1005) return new Socket.CloseEvent(1000);
    if (reason.code === 1006) return new Socket.CloseEvent(1001);
  }
  return new Socket.CloseEvent(browserApi ? 1000 : 1011);
};

/** Кадры из `from` в `to`, пока `from` не закроется; затем закрывает `to`. */
const pipeFrames = (
  from: Socket.Reader,
  to: Socket.Writer,
  browserApi: boolean,
) =>
  Effect.forever(
    Effect.flatMap(from.pull, (chunks) => to.writeAll(chunks)),
  ).pipe(
    Effect.catch((error) => to.write(closeFor(error, browserApi))),
    Effect.ignore,
  );

/**
 * WebSocket: сначала открывается соединение с Selkies (не открылось — 502 без
 * апгрейда браузера), затем апгрейд браузера и перекачка кадров в обе стороны
 * (текст остаётся текстом, бинарные — бинарными) до закрытия любой стороны.
 */
const proxyWebSocket = (
  request: HttpServerRequest.HttpServerRequest,
  target: URL,
  sessionId: string,
) =>
  Effect.gen(function* () {
    const wsTarget = new URL(target.href);
    wsTarget.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const upstream = yield* Socket.makeWebSocket(wsTarget.href, {
      openTimeout: upstreamTimeout,
    });
    const opened = yield* Effect.result(upstream.reader);
    if (opened._tag === "Failure") {
      yield* Effect.logWarning("Stream upstream WebSocket failed to open", {
        sessionId,
        cause: String(opened.failure),
      });
      return badGateway;
    }
    const upstreamWriter = yield* upstream.writer;

    const client = yield* request.upgrade;
    const clientReader = yield* client.reader;
    const clientWriter = yield* client.writer;
    yield* Effect.raceFirst(
      pipeFrames(opened.success, clientWriter, false),
      pipeFrames(clientReader, upstreamWriter, true),
    );
    return HttpServerResponse.empty();
  }).pipe(
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
    Effect.scoped,
    Effect.catch((cause) =>
      Effect.as(
        Effect.logWarning("Stream WebSocket proxy failed", {
          sessionId,
          cause: String(cause),
        }),
        HttpServerResponse.empty(),
      ),
    ),
  );

const handle = (
  request: HttpServerRequest.HttpServerRequest,
  auth: BetterAuth["Service"],
  allowedOrigins: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://localhost");
    const match = streamPath.exec(url.pathname);
    const rawId = match?.[1];
    if (match === null || rawId === undefined) return forbidden;
    const rest = match[2];
    // Без завершающего слэша: клиент Selkies строит URL от своего пути.
    if (rest === undefined)
      return HttpServerResponse.redirect(`/stream/${rawId}/${url.search}`, {
        status: 308,
      });

    const origin = request.headers["origin"];
    const originAllowed = origin !== undefined && allowedOrigins.has(origin);
    const upgrade = isWebSocketUpgrade(request);
    if ((upgrade || !isSafeMethod(request.method)) && !originAllowed)
      return forbidden;

    let sessionId: string;
    try {
      sessionId = decodeURIComponent(rawId);
    } catch {
      return forbidden;
    }
    const user = yield* auth.currentUser(request.headers);
    if (user._tag === "None") return forbidden;
    const streamUrl = yield* streamUrlOf(user.value.id, sessionId);
    if (streamUrl === undefined) return forbidden;
    const base = parseStreamUrl(streamUrl);
    if (base === undefined) {
      yield* Effect.logError("Session has an invalid streamUrl", { sessionId });
      return badGateway;
    }

    const target = upstreamUrl(base, rest, url.search);
    return upgrade
      ? yield* proxyWebSocket(request, target, sessionId)
      : yield* proxyHttp(request, target, sessionId);
  });

/** Маршрут `/stream/:sessionId/*` (и `/stream/:sessionId` — редирект со слэшем). */
export const StreamProxyRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* BetterAuth;
    const db = yield* Db;
    const allowedOrigins = rpcAllowedOrigins(yield* AppConfig);
    yield* router.add("*", "/stream/:sessionId/*", (request) =>
      handle(request, auth, allowedOrigins).pipe(Effect.provideService(Db, db)),
    );
  }),
);
