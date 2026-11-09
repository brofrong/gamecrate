// Прокси стрима: `ANY /stream/<sessionId>/*` → relay оркестратора (спека
// 2026-11-09 §4, `http://cg-orchestrator:3002/relay/<sessionId>/…`, оркестратор
// слушает его на `RELAY_PORT`), который тоннелирует запрос до Selkies сессии на
// сервере, где она реально запущена. Многосерверный деплой: api больше не
// ходит в локальную сеть `cg-sessions` напрямую (там нет сессий с других
// серверов). HTTP и WebSocket.
//
// Доступ: только владелец (cookie Better Auth), только активная сессия с готовым
// стримом. WebSocket-апгрейд и небезопасные методы (POST и т. п.) — только с
// Origin из `rpcAllowedOrigins` (как `/rpc`: cookie SameSite=Lax уходит и с
// соседних поддоменов). Любой отказ — 403 (не 404: существование чужих сессий
// не раскрывается).
//
// Запрос к апстриму (решение R2): путь без префикса `/stream/<id>`; `Host` —
// хост апстрима (его ставит HTTP/WS-клиент по URL); `Origin` браузера
// убирается после нашей проверки — relay/Selkies пропускает запрос без
// Origin, а с публичным Origin и чужим `Host` отвечает 403 (проверено в
// Task 5); cookie (наша сессия Better Auth) и `Referer` не передаются.
// `Set-Cookie` апстрима браузеру не отдаётся — он не может ставить cookie
// нашему домену. Каждый запрос и открытие WebSocket к relay несут общий
// секрет `RELAY_SECRET` в `x-cg-relay-secret` (заголовок с этим именем от
// браузера заменяется): relay слушается и в сети обратного прокси и без
// секрета отвечает 403. Апстрим не ответил (relay вернул 502 — сессии нет на
// сервере или агент не подключён, отказ соединения, таймаут) — 502.
//
// Жёсткие ограничения:
// - id в пути — только формат `isSessionId` (uuid), иначе 403 до запроса к БД;
//   путь нормализуется (`..`, `%2e%2e`) до разбора, так что обход в чужую
//   сессию упирается в проверку владельца;
// - подключаемся только к relay оркестратора (`StreamUpstream`/
//   `orchestratorRelayUrl`), а не по адресу из БД: `streamUrl` сессии
//   (`isSessionStreamUrl`) проверяется отдельно и только как признак
//   готовности стрима (не тот формат — 502 и предупреждение в логе, защита
//   от SSRF через подделанный отчёт агента остаётся на стороне проверки);
// - ответы апстрима нельзя встроить в чужой сайт (`frame-ancestors 'self'`,
//   `X-Frame-Options: SAMEORIGIN`); `Location` на абсолютный путь, на relay
//   или на адрес Selkies из `streamUrl` переписывается под префикс
//   `/stream/<id>`.
import { Db } from "@cg/db";
import {
  isSessionId,
  isSessionStreamUrl,
  pipeFrames,
  RELAY_SECRET_HEADER,
  readStreamBody,
  sessionStreamUrl,
  StreamBodyTooLarge,
} from "@cg/rpc";
import { BunSocket } from "@effect/platform-bun";
import { Context, Effect, Fiber, FiberSet, Redacted } from "effect";
import {
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import { BetterAuth } from "../auth/auth";
import { AppConfig, rpcAllowedOrigins } from "../config";
import { streamUrlOf } from "./SessionRepo";

/**
 * Тестовый крюк для подмены апстрима (в тестах нет TCP до `cg-orchestrator`,
 * поэтому подменяют адресом фейкового Selkies). `Context.Reference` не может
 * прочитать `AppConfig` в своём `defaultValue`, так что его значение здесь —
 * только заглушка: `StreamProxyRoute` читает подмену напрямую из контекста
 * (`Context.getOrUndefined`, без разрешения этого значения по умолчанию) и
 * без неё сам считает адрес из `AppConfig.orchestratorRelayUrl`.
 */
export const StreamUpstream = Context.Reference<(sessionId: string) => string>(
  "@cg/api/StreamUpstream",
  { defaultValue: () => sessionStreamUrl },
);

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
const streamUnavailable = HttpServerResponse.text("Стрим недоступен", {
  status: 502,
});
const payloadTooLarge = HttpServerResponse.text("Слишком большой запрос", {
  status: 413,
});

const isSafeMethod = (method: string) =>
  method === "GET" || method === "HEAD" || method === "OPTIONS";

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["upgrade"]?.toLowerCase() === "websocket";

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
  relaySecret: Redacted.Redacted<string>,
) => {
  const headers = new globalThis.Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!droppedRequestHeaders.has(name.toLowerCase()))
      headers.set(name, value);
  }
  // После копирования: заголовок браузера с тем же именем заменяется.
  headers.set(RELAY_SECRET_HEADER, Redacted.value(relaySecret));
  return headers;
};

/** Куда отвечает Selkies: префикс сессии и origin, которые считаются им самим. */
interface Upstream {
  readonly prefix: string;
  readonly origins: ReadonlySet<string>;
  readonly target: URL;
}

const hasScheme = /^[a-z][a-z0-9+.-]*:/i;

/**
 * `Location` от Selkies: абсолютный путь (`/x`) и адрес самого Selkies
 * (`http://cg-session-<id>:8080/x`, `//cg-session-<id>:8080/x`) — под
 * префикс сессии; относительный и внешний — как есть.
 */
export const rewriteLocation = (location: string, upstream: Upstream) => {
  if (location.startsWith("/") && !location.startsWith("//"))
    return upstream.prefix + location;
  if (!hasScheme.test(location) && !location.startsWith("//")) return location;
  let url: URL;
  try {
    url = new URL(location, upstream.target);
  } catch {
    return location;
  }
  return upstream.origins.has(url.origin)
    ? upstream.prefix + url.pathname + url.search + url.hash
    : location;
};

const forwardResponse = (response: Response, upstream: Upstream) => {
  const headers = new globalThis.Headers();
  response.headers.forEach((value, name) => {
    if (!droppedResponseHeaders.has(name.toLowerCase()))
      headers.set(name, value);
  });
  // Встраивать стрим можно только нашим страницам. Отдельный заголовок CSP:
  // несколько политик действуют одновременно, политика Selkies не ослабляется.
  headers.append("content-security-policy", "frame-ancestors 'self'");
  headers.set("x-frame-options", "SAMEORIGIN");
  const location = headers.get("location");
  if (location !== null)
    headers.set("location", rewriteLocation(location, upstream));
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

/**
 * HTTP-запрос к Selkies; нет соединения/таймаут — 502. Тело больше
 * `MAX_STREAM_BODY_BYTES` — 413 без запроса к relay (тело буферизуется для
 * fetch целиком).
 */
const proxyHttp = (
  request: HttpServerRequest.HttpServerRequest,
  target: URL,
  upstream: Upstream,
  sessionId: string,
  relaySecret: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? yield* readStreamBody(request) : undefined;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(target, {
          method: request.method,
          headers: forwardRequestHeaders(request, relaySecret),
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal,
        }),
      catch: (cause) => cause,
    }).pipe(Effect.timeout(upstreamTimeout));
    return forwardResponse(response, upstream);
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof StreamBodyTooLarge
        ? Effect.succeed(payloadTooLarge)
        : Effect.as(
            Effect.logWarning("Stream upstream HTTP request failed", {
              sessionId,
              cause: String(cause),
            }),
            badGateway,
          ),
    ),
  );

/**
 * WebSocket: сначала открывается соединение с Selkies (не открылось — 502 без
 * апгрейда браузера), затем апгрейд браузера и перекачка кадров в обе стороны
 * (текст остаётся текстом, бинарные — бинарными) до закрытия любой стороны.
 *
 * Запускается в отдельном файбере слоя маршрута (`runBridge`), а не в файбере
 * запроса: когда браузер закрывает WebSocket, Bun отменяет исходный запрос и
 * сервер прерывает его файбер — мост успел бы только закрыть Selkies с 1000,
 * не передав код и причину браузера.
 */
const proxyWebSocket = (
  request: HttpServerRequest.HttpServerRequest,
  target: URL,
  sessionId: string,
  relaySecret: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const wsTarget = new URL(target.href);
    wsTarget.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const upstream = yield* Socket.makeWebSocket(wsTarget.href, {
      openTimeout: upstreamTimeout,
      headers: { [RELAY_SECRET_HEADER]: Redacted.value(relaySecret) },
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
    // Конструктор Bun: глобальный (стандартный) не умеет заголовки апгрейда.
    Effect.provide(BunSocket.layerWebSocketConstructor),
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
  upstreamFor: (sessionId: string) => string,
  relaySecret: Redacted.Redacted<string>,
  runBridge: (
    bridge: Effect.Effect<HttpServerResponse.HttpServerResponse>,
  ) => Fiber.Fiber<HttpServerResponse.HttpServerResponse>,
) =>
  Effect.gen(function* () {
    // `new URL` нормализует `..` и `%2e%2e` до разбора пути.
    const url = new URL(request.url, "http://localhost");
    const match = streamPath.exec(url.pathname);
    const sessionId = match?.[1];
    // Только uuid: `%00`, `%2F` и прочее — сразу 403, без БД.
    if (match === null || sessionId === undefined || !isSessionId(sessionId))
      return forbidden;
    const rest = match[2];
    // Без завершающего слэша: клиент Selkies строит URL от своего пути.
    if (rest === undefined)
      return HttpServerResponse.redirect(`/stream/${sessionId}/${url.search}`, {
        status: 308,
      });

    const origin = request.headers["origin"];
    const originAllowed = origin !== undefined && allowedOrigins.has(origin);
    const upgrade = isWebSocketUpgrade(request);
    if ((upgrade || !isSafeMethod(request.method)) && !originAllowed)
      return forbidden;

    const user = yield* auth.currentUser(request.headers);
    if (user._tag === "None") return forbidden;
    const streamUrl = yield* streamUrlOf(user.value.id, sessionId);
    if (streamUrl === undefined) return forbidden;
    if (!isSessionStreamUrl(sessionId, streamUrl)) {
      yield* Effect.logWarning("Session streamUrl is not its Selkies address", {
        sessionId,
        streamUrl,
      });
      return streamUnavailable;
    }

    const base = new URL(upstreamFor(sessionId));
    const upstream: Upstream = {
      prefix: `/stream/${sessionId}`,
      origins: new Set([base.origin, new URL(streamUrl).origin]),
      target: base,
    };
    const target = upstreamUrl(base, rest, url.search);
    return upgrade
      ? // Прерывание ожидания (файбер запроса) мост не останавливает.
        yield* Fiber.join(
          runBridge(proxyWebSocket(request, target, sessionId, relaySecret)),
        )
      : yield* proxyHttp(request, target, upstream, sessionId, relaySecret);
  });

/** Маршрут `/stream/:sessionId/*` (и `/stream/:sessionId` — редирект со слэшем). */
export const StreamProxyRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* BetterAuth;
    const db = yield* Db;
    const config = yield* AppConfig;
    const allowedOrigins = rpcAllowedOrigins(config);
    // Подмена тестов (если провели слоем) — без неё адрес из конфига:
    // `Context.getOrUndefined` не разрешает `defaultValue` `StreamUpstream`
    // (`Context.Reference` не умеет прочитать `AppConfig` в своём
    // `defaultValue`), так что в проде это именно relay оркестратора.
    const override = Context.getOrUndefined(
      yield* Effect.context<never>(),
      StreamUpstream,
    );
    const upstreamFor =
      override ??
      ((sessionId: string) =>
        `${config.orchestratorRelayUrl}/relay/${sessionId}`);
    // Мосты WebSocket живут в scope слоя: при остановке сервера прерываются.
    const runBridge = yield* FiberSet.makeRuntime<
      never,
      HttpServerResponse.HttpServerResponse,
      never
    >();
    yield* router.add("*", "/stream/:sessionId/*", (request) =>
      handle(
        request,
        auth,
        allowedOrigins,
        upstreamFor,
        config.relaySecret,
        runBridge,
      ).pipe(Effect.provideService(Db, db)),
    );
  }),
);
