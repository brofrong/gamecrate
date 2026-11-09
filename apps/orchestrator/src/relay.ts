// Relay стрима (спека 2026-11-09 §4): для api оркестратор выглядит как
// Selkies сессии — `ANY /relay/<sessionId>/…` на внутреннем `RELAY_PORT`
// (наружу не публикуется, в общий роутер не входит). Каждое соединение
// (один HTTP-запрос или один WebSocket) — свой канал тоннеля
// (`Tunnels.open`) до агента сервера сессии, который сам ходит в
// `cg-session-<id>:8080`.
//
// Сессия должна быть активной (`SessionRepo.isActive`, как у `streamUrlOf`
// api), с готовым стримом (`stream_url`), а агент её сервера — подключён;
// иначе 502 без команды агенту. Владельца сессии проверяет api.
//
// Запрос агенту: путь без префикса `/relay/<id>` + query, заголовки api как
// есть, кроме hop-by-hop и секрета relay (api уже убрал host/cookie/origin и
// т. п.). Ответ: статус, заголовки и тело потоком — как прислал агент
// (переписывает api).
//
// Relay слушается и в сети обратного прокси (оркестратор в `proxy` ради
// маршрута `/agent*`), поэтому любой запрос без общего секрета api
// (`RELAY_SECRET` в заголовке `x-cg-relay-secret`) — 403 сразу, до разбора
// пути, БД и `OpenTunnel`.
import { createHash, timingSafeEqual } from "node:crypto";
import { Db, sessions } from "@cg/db";
import {
  encodeTunnelControl,
  decodeTunnelControl,
  isSessionId,
  pipeFrames,
  RELAY_SECRET_HEADER,
  type TunnelControl,
} from "@cg/rpc";
import { BunHttpServer } from "@effect/platform-bun";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  Cause,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  Cookies,
  type Headers,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import { AgentHub } from "./AgentHub";
import { OrchestratorConfig } from "./config";
import { isActive } from "./SessionRepo";
import { TunnelError, Tunnels } from "./Tunnels";

/** Сколько ждём ответа агента (заголовков HTTP или открытия WebSocket) после открытия канала. */
export const TUNNEL_ANSWER_TIMEOUT = "10 seconds";

/** `/relay/<id>` и остаток пути (с начальным `/`, если есть). */
const relayPath = /^\/relay\/([^/?#]+)(\/[^?#]*)?$/;

/** Hop-by-hop (RFC 9110 §7.6.1) и то, что агент ставит сам по своему запросу. */
const droppedRequestHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Рукопожатие WebSocket — своё у каждого участка; подпротоколы — в `protocols`.
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  // Секрет api ↔ relay агенту и Selkies не нужен.
  RELAY_SECRET_HEADER,
]);

const droppedResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });
const forbidden = () => HttpServerResponse.text("Forbidden", { status: 403 });

/**
 * Совпадает ли присланный секрет с `RELAY_SECRET`: сравнение SHA-256 обоих
 * за постоянное время (`timingSafeEqual` требует равной длины). Нет
 * заголовка — нет.
 */
const relaySecretMatches = (
  sent: string | undefined,
  expected: Redacted.Redacted<string>,
) => {
  if (sent === undefined) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(sent), digest(Redacted.value(expected)));
};
const badGateway = () =>
  HttpServerResponse.text("Стрим недоступен", { status: 502 });
const tooManyTunnels = () =>
  HttpServerResponse.text("Слишком много соединений со стримом", {
    status: 503,
  });

/** Агент ответил не по протоколу, сообщил о сбое или канал оборвался. */
class RelayFailure extends Schema.TaggedError<RelayFailure>()("RelayFailure", {
  message: Schema.String,
}) {}

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const forwardedHeaders = (headers: Headers.Headers) =>
  Object.entries(headers).filter(
    ([name]) => !droppedRequestHeaders.has(name.toLowerCase()),
  ) as Array<[string, string]>;

/**
 * Сервер сессии, если к ней можно открыть тоннель: активна, стрим готов
 * (`stream_url`), размещена на сервере. Иначе `undefined`.
 */
const workerOfLiveSession = (sessionId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .select({ workerId: sessions.workerId })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          isActive,
          isNotNull(sessions.streamUrl),
        ),
      );
    return row?.workerId ?? undefined;
  }).pipe(Effect.orDie);

/** Закрыт ли канал штатно (код 1000 — агент дослал тело). */
const isNormalClose = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError" && error.reason.code === 1000;

/**
 * Сообщения канала по одному поверх `Reader.pull` (он отдаёт пачками):
 * `next` — следующее, `rest` — уже вычитанное из сокета, но ещё не отданное.
 */
const channelMessages = (reader: Socket.Reader) => {
  let buffered: ReadonlyArray<string | Uint8Array> = [];
  const batch: Effect.Effect<
    ReadonlyArray<string | Uint8Array>,
    Socket.SocketError
  > = Effect.suspend(() => {
    if (buffered.length === 0) return reader.pull;
    const chunk = buffered;
    buffered = [];
    return Effect.succeed(chunk);
  });
  const next = Effect.map(batch, (chunk) => {
    const [first, ...rest] = chunk;
    buffered = rest;
    return first!;
  });
  return {
    next,
    batch,
    rest: () => {
      const chunk = buffered;
      buffered = [];
      return chunk;
    },
  };
};
type ChannelMessages = ReturnType<typeof channelMessages>;

/** Первый ответ агента: управляющее сообщение; закрытие или мусор — `RelayFailure`. */
const answer = (messages: ChannelMessages) =>
  messages.next.pipe(
    Effect.mapError(
      (error) =>
        new RelayFailure({
          message: `channel closed before answer: ${String(error.reason)}`,
        }),
    ),
    Effect.flatMap((message) => {
      const control =
        typeof message === "string" ? decodeTunnelControl(message) : undefined;
      return control === undefined || Option.isNone(control)
        ? Effect.fail(new RelayFailure({ message: "unexpected first message" }))
        : Effect.succeed(control.value);
    }),
    Effect.timeoutOrElse({
      duration: TUNNEL_ANSWER_TIMEOUT,
      orElse: () =>
        Effect.fail(new RelayFailure({ message: "agent did not answer" })),
    }),
  );

const failureOf = (control: TunnelControl) =>
  new RelayFailure({
    message:
      control.kind === "error"
        ? `agent: ${control.message}`
        : `unexpected answer ${control.kind}`,
  });

/**
 * Тело ответа: бинарные сообщения канала до закрытия 1000. Текст
 * `{ kind: "error" }`, другой код закрытия — обрыв тела (api получит
 * недочитанный ответ).
 */
const bodyOf = (messages: ChannelMessages) => {
  const binaryOf = (
    chunk: ReadonlyArray<string | Uint8Array>,
  ): Effect.Effect<
    readonly [Uint8Array, ...Array<Uint8Array>],
    RelayFailure | Cause.Done
  > => {
    const binary: Array<Uint8Array> = [];
    for (const message of chunk) {
      if (typeof message !== "string") {
        binary.push(message);
        continue;
      }
      const control = decodeTunnelControl(message);
      return Effect.fail(
        Option.isSome(control)
          ? failureOf(control.value)
          : new RelayFailure({ message: "text message in body" }),
      );
    }
    const [first, ...rest] = binary;
    // Пачка из одних управляющих сообщений не бывает пустой — но и
    // бинарных в ней может не оказаться: тогда — следующая пачка.
    return first === undefined ? pull : Effect.succeed([first, ...rest]);
  };
  const pull: Effect.Effect<
    readonly [Uint8Array, ...Array<Uint8Array>],
    RelayFailure | Cause.Done
  > = Effect.suspend(() =>
    messages.batch.pipe(
      Effect.catch((error): Effect.Effect<never, RelayFailure | Cause.Done> =>
        isNormalClose(error)
          ? Cause.done()
          : Effect.fail(
              new RelayFailure({
                message: `channel closed mid-body: ${String(error.reason)}`,
              }),
            ),
      ),
      Effect.flatMap(binaryOf),
    ),
  );
  return Stream.fromPull(Effect.succeed(pull));
};

/** Статусы, с которыми ответ без тела (Response их с телом не принимает). */
const nullBodyStatus = (status: number) =>
  status === 204 || status === 205 || status === 304;

/** Заголовки ответа агента → заголовки и cookie ответа relay (без hop-by-hop). */
const responseHeaders = (pairs: ReadonlyArray<readonly [string, string]>) => {
  const headers: Record<string, Array<string>> = {};
  const setCookie: Array<string> = [];
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    if (droppedResponseHeaders.has(key)) continue;
    if (key === "set-cookie") setCookie.push(value);
    else (headers[key] ??= []).push(value);
  }
  return { headers, cookies: Cookies.fromSetCookie(setCookie) };
};

/**
 * HTTP: канал в scope запроса (сервер переносит его на поток тела, так что
 * канал закроется, когда тело дочитают или api оборвёт запрос).
 */
const relayHttp = (
  tunnels: Tunnels["Service"],
  request: HttpServerRequest.HttpServerRequest,
  workerId: string,
  sessionId: string,
  path: string,
) =>
  Effect.gen(function* () {
    const withBody = request.method !== "GET" && request.method !== "HEAD";
    const body = withBody
      ? new Uint8Array(yield* request.arrayBuffer)
      : undefined;
    const hasBody = body !== undefined && body.byteLength > 0;

    const channel = yield* tunnels.open(workerId, sessionId);
    const writer = yield* channel.writer;
    const messages = channelMessages(yield* channel.reader);
    yield* writer.write(
      encodeTunnelControl({
        kind: "http",
        method: request.method,
        path,
        headers: forwardedHeaders(request.headers),
        hasBody,
      }),
    );
    if (hasBody) yield* writer.write(body);

    const control = yield* answer(messages);
    if (control.kind !== "response") return yield* failureOf(control);
    if (control.status < 200 || control.status > 599)
      return yield* new RelayFailure({
        message: `bad status ${control.status}`,
      });
    const { headers, cookies } = responseHeaders(control.headers);
    const options = { status: control.status, headers, cookies };
    return nullBodyStatus(control.status) || request.method === "HEAD"
      ? HttpServerResponse.empty(options)
      : HttpServerResponse.stream(
          bodyOf(messages).pipe(
            Stream.tapError((error) =>
              Effect.logWarning("Relay response body broken off", {
                sessionId,
                workerId,
                message: error.message,
              }),
            ),
          ),
          options,
        );
  });

/**
 * WebSocket: канал, `TunnelOpenWs`, ждём `{ kind: "open" }` (сбой или
 * тишина — 502 без апгрейда api), затем апгрейд api и кадры в обе стороны
 * до закрытия любой; код и причина закрытия переходят на другую сторону.
 * Обе стороны — серверные сокеты Bun, так что коды 1001–1014 тоже
 * передаются (`browserApi = false`).
 *
 * Запускается в файбере слоя (`runBridge`), а не запроса: когда api
 * закрывает WebSocket, Bun отменяет исходный запрос — мост успел бы только
 * закрыть канал, не передав код и причину api (как в прокси api).
 */
const relayWebSocket = (
  tunnels: Tunnels["Service"],
  request: HttpServerRequest.HttpServerRequest,
  workerId: string,
  sessionId: string,
  path: string,
) =>
  Effect.gen(function* () {
    const channel = yield* tunnels.open(workerId, sessionId);
    const writer = yield* channel.writer;
    const reader = yield* channel.reader;
    const messages = channelMessages(reader);
    const protocols = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter((protocol) => protocol.length > 0);
    yield* writer.write(
      encodeTunnelControl({
        kind: "ws",
        path,
        headers: forwardedHeaders(request.headers),
        protocols,
      }),
    );
    const control = yield* answer(messages);
    if (control.kind !== "open") return yield* failureOf(control);

    const api = yield* request.upgrade;
    const apiReader = yield* api.reader;
    const apiWriter = yield* api.writer;
    // Кадры Selkies, пришедшие вместе с `open`.
    const [first, ...rest] = messages.rest();
    if (first !== undefined) yield* apiWriter.writeAll([first, ...rest]);
    yield* Effect.raceFirst(
      pipeFrames(reader, apiWriter, false),
      pipeFrames(apiReader, writer, false),
    );
    return HttpServerResponse.empty();
  }).pipe(Effect.scoped);

/** Сбой relay → предупреждение в лог и ответ api (лимит — 503, иначе 502). */
const relayFailed = (sessionId: string, workerId: string) => (error: unknown) =>
  Effect.as(
    Effect.logWarning("Relay to session stream failed", {
      sessionId,
      workerId,
      cause:
        error instanceof RelayFailure
          ? error.message
          : error instanceof TunnelError
            ? error.reason
            : String(error),
    }),
    error instanceof TunnelError && error.reason === "Limit"
      ? tooManyTunnels()
      : badGateway(),
  );

/**
 * Обработчик relay. Зависит от конфига (`RELAY_SECRET`), Db, AgentHub и
 * Tunnels; мосты WebSocket — в `runBridge` (живут в scope слоя).
 */
const handler = Effect.gen(function* () {
  const { relaySecret } = yield* OrchestratorConfig;
  const db = yield* Db;
  const hub = yield* AgentHub;
  const tunnels = yield* Tunnels;
  const runBridge = yield* FiberSet.makeRuntime<
    never,
    HttpServerResponse.HttpServerResponse,
    never
  >();

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!relaySecretMatches(request.headers[RELAY_SECRET_HEADER], relaySecret))
      return forbidden();
    const url = new URL(request.url, "http://localhost");
    const match = relayPath.exec(url.pathname);
    const sessionId = match?.[1];
    if (match === null || sessionId === undefined) return notFound();
    if (!isSessionId(sessionId)) return badGateway();

    const workerId = yield* workerOfLiveSession(sessionId).pipe(
      Effect.provideService(Db, db),
    );
    if (workerId === undefined || hub.info(workerId) === undefined)
      return badGateway();

    const path = (match[2] ?? "/") + url.search;
    if (isWebSocketUpgrade(request))
      // Прерывание ожидания (файбер запроса) мост не останавливает.
      return yield* Fiber.join(
        runBridge(
          relayWebSocket(tunnels, request, workerId, sessionId, path).pipe(
            Effect.catch(relayFailed(sessionId, workerId)),
          ),
        ),
      );
    return yield* relayHttp(tunnels, request, workerId, sessionId, path).pipe(
      Effect.catch(relayFailed(sessionId, workerId)),
    );
  });
});

/** Relay на текущем `HttpServer` (без логгера запросов: файлы плеера шумят). */
export const RelayHttp = Layer.effectDiscard(
  Effect.flatMap(handler, (app) => HttpServer.serveEffect(app)),
);

/** Relay на своём Bun-сервере на `RELAY_PORT`. */
export const RelayServer = Layer.unwrap(
  OrchestratorConfig.useSync((config) =>
    RelayHttp.pipe(
      Layer.provide(BunHttpServer.layer({ port: config.relayPort })),
    ),
  ),
);
