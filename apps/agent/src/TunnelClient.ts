// TunnelClient: канал тоннеля стрима со стороны агента (спека 2026-11-09 §4).
// По команде `OpenTunnel{tunnelId, sessionId}` агент открывает WebSocket
// `ws(s)://<оркестратор>/agent/tunnel/<tunnelId>` со своим токеном
// (`Authorization: Bearer WORKER_TOKEN`), читает первое управляющее
// сообщение (протокол — `@cg/rpc` `tunnel.ts`) и обслуживает ровно одно
// соединение с Selkies сессии на этом сервере: HTTP-запрос (ответ — текстом
// `response`, тело — бинарными кусками, закрытие 1000) или WebSocket
// (`open` и кадры 1:1 в обе стороны, код и причина закрытия переходят на
// другую сторону). Selkies не ответил или не открыл WebSocket —
// `{ kind: "error" }` и закрытие 1011.
//
// Защита от SSRF: адрес Selkies агент берёт только из `sessionId`
// (`TunnelUpstream`, по умолчанию `http://cg-session-<id>:8080`), из канала —
// лишь путь, и итоговый адрес обязан остаться на том же origin. Тоннель
// открывается только к сессии, которую ведёт этот агент и чей стрим готов
// (`SessionSupervisor.hasStream`); чужая — канал не открывается вовсе
// (оркестратор ответит api 502 по тайм-ауту).
//
// Заголовки к Selkies — присланные оркестратором, кроме hop-by-hop и
// `host`/`origin`: `Host` ставит клиент по адресу Selkies, а с чужим `Origin`
// и `Host` контейнера Selkies отвечает 403 (см. прокси стрима api).
import {
  decodeTunnelControl,
  encodeTunnelControl,
  pipeFrames,
  sessionStreamUrl,
  type TunnelControl,
  type TunnelOpenHttp,
  type TunnelOpenWs,
} from "@cg/rpc";
import { BunSocket } from "@effect/platform-bun";
import { Context, Data, Effect, Layer, Option, Redacted } from "effect";
import * as Socket from "effect/socket/Socket";
import { AgentConfig, orchestratorHttpBase } from "./config";
import { SessionSupervisor } from "./SessionSupervisor";

/**
 * Больше одновременных каналов агент не держит (у оркестратора тот же
 * предел на сервер, `MAX_TUNNELS_PER_WORKER`): сверх — отказ без канала и
 * предупреждение в логе.
 */
export const MAX_TUNNELS = 64;

/**
 * Сколько ждём каждого шага: открытия канала, запроса оркестратора по нему,
 * ответа (заголовков) Selkies или открытия его WebSocket.
 */
export const TUNNEL_TIMEOUT = "10 seconds";

/**
 * Адрес Selkies сессии. По умолчанию — `http://cg-session-<id>:8080`
 * (`sessionStreamUrl`); тесты подменяют адресом фейкового Selkies (как
 * `StreamUpstream` в api).
 */
export const TunnelUpstream = Context.Reference<(sessionId: string) => string>(
  "@cg/agent/TunnelUpstream",
  { defaultValue: () => sessionStreamUrl },
);

/** Адрес канала тоннеля: база оркестратора (`ws`/`wss`) + `/agent/tunnel/<id>`. */
export const tunnelChannelUrl = (orchestratorUrl: string, tunnelId: string) => {
  const url = new URL(orchestratorHttpBase(orchestratorUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/agent/tunnel/${encodeURIComponent(tunnelId)}`;
  return url.href;
};

/**
 * Заголовки запроса, которые не уходят в Selkies: hop-by-hop (RFC 9110
 * §7.6.1), рукопожатие WebSocket (своё у каждого участка, подпротоколы — в
 * `protocols`), `host`/`origin` (см. шапку), `content-length` (ставит fetch
 * по телу) и `accept-encoding` (fetch Bun сам распаковывает ответ — просим
 * без сжатия, как прокси api).
 */
const droppedRequestHeaders = new Set([
  "host",
  "origin",
  "content-length",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

/** Hop-by-hop ответа Selkies: в канал не уходят. */
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

/** Канал или Selkies подвели: причина уходит в лог (и оркестратору, если канал жив). */
class TunnelFailed extends Data.TaggedError("TunnelFailed")<{
  readonly message: string;
}> {}

type Pairs = ReadonlyArray<readonly [string, string]>;

const forwarded = (headers: Pairs) =>
  headers.filter(([name]) => !droppedRequestHeaders.has(name.toLowerCase()));

/**
 * Адрес у Selkies: путь с query из канала поверх `base`. Путь — только
 * абсолютный, и адрес не уходит с origin Selkies (`//host/…` и т. п.).
 */
const targetUrl = (base: string, path: string) => {
  const origin = new URL(base).origin;
  if (!path.startsWith("/"))
    return Effect.fail(new TunnelFailed({ message: "bad path" }));
  try {
    const url = new URL(path, origin);
    return url.origin === origin
      ? Effect.succeed(url)
      : Effect.fail(new TunnelFailed({ message: "path leaves Selkies" }));
  } catch {
    return Effect.fail(new TunnelFailed({ message: "bad path" }));
  }
};

/**
 * Заголовки ответа Selkies парами (повторяющиеся `set-cookie` — отдельными).
 * Тело сжатым не было или fetch его уже распаковал: исходные кодировка и
 * длина к нему не относятся (как в прокси api).
 */
const responseHeaders = (headers: Headers) => {
  const decoded = headers.has("content-encoding");
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (droppedResponseHeaders.has(key) || key === "set-cookie") return;
    if (decoded && (key === "content-encoding" || key === "content-length"))
      return;
    pairs.push([key, value]);
  });
  for (const cookie of headers.getSetCookie())
    pairs.push(["set-cookie", cookie]);
  return pairs;
};

/**
 * Сообщения канала по одному поверх `Reader.pull` (он отдаёт пачками):
 * `next` — следующее, `rest` — уже вычитанное из сокета, но ещё не отданное.
 */
const channelMessages = (reader: Socket.Reader) => {
  let buffered: Array<string | Uint8Array> = [];
  const next = Effect.suspend(() => {
    const first = buffered.shift();
    if (first !== undefined) return Effect.succeed(first);
    return Effect.map(reader.pull, ([head, ...tail]) => {
      buffered = tail;
      return head;
    });
  });
  const rest = () => {
    const chunk = buffered;
    buffered = [];
    return chunk;
  };
  return { next, rest };
};
type ChannelMessages = ReturnType<typeof channelMessages>;

/**
 * WebSocket-клиент Bun (заголовки рукопожатия и подпротоколы); `protocol` —
 * подпротокол, выбранный сервером (пусто — без него), после открытия.
 */
const dialWebSocket = (
  url: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly protocols?: Array<string>;
  },
) =>
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    let created: Socket.WebSocketLike | undefined;
    const socket = yield* Socket.makeWebSocket(url, {
      ...options,
      openTimeout: TUNNEL_TIMEOUT,
    }).pipe(
      Effect.provideService(Socket.WebSocketConstructor, (url, options) => {
        created = make(url, options);
        return created;
      }),
    );
    const protocol = () =>
      (created as { readonly protocol?: string } | undefined)?.protocol ?? "";
    return { socket, protocol };
  }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor));

/** Ответ оркестратору о сбое и закрытие канала 1011 (канал мог уже закрыться). */
const refuse = (writer: Socket.Writer, message: string) =>
  writer
    .write(encodeTunnelControl({ kind: "error", message }))
    .pipe(
      Effect.andThen(writer.write(new Socket.CloseEvent(1011))),
      Effect.ignore,
    );

const timeoutAs = (message: string) =>
  Effect.timeoutOrElse({
    duration: TUNNEL_TIMEOUT,
    orElse: () => Effect.fail(new TunnelFailed({ message })),
  });

/** Канал закрылся (или упал) — для гонки с перекачкой тела ответа. */
const untilClosed = (reader: Socket.Reader) =>
  Effect.forever(reader.pull).pipe(Effect.ignore);

/**
 * HTTP: запрос к Selkies (тело — следующее бинарное сообщение канала, если
 * `hasBody`), ответ — `response` и тело кусками, закрытие 1000. Selkies не
 * ответил за `TUNNEL_TIMEOUT` или сбой соединения — `error` и 1011. Канал
 * закрылся посреди тела (api бросил запрос) — запрос к Selkies отменяется.
 */
const serveHttp = (
  request: TunnelOpenHttp,
  base: string,
  reader: Socket.Reader,
  messages: ChannelMessages,
  writer: Socket.Writer,
) =>
  Effect.gen(function* () {
    const target = yield* targetUrl(base, request.path);
    const body = request.hasBody
      ? yield* messages.next.pipe(
          Effect.mapError(
            () => new TunnelFailed({ message: "channel closed before body" }),
          ),
          timeoutAs("no request body"),
          Effect.flatMap((message) =>
            typeof message === "string"
              ? Effect.fail(new TunnelFailed({ message: "text body" }))
              : Effect.succeed(message),
          ),
        )
      : undefined;
    const headers = new Headers();
    for (const [name, value] of forwarded(request.headers))
      headers.append(name, value);
    // Запрос к Selkies живёт не дольше канала: закрытие scope его отменяет.
    const abort = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    const withBody =
      body !== undefined &&
      request.method !== "GET" &&
      request.method !== "HEAD";
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(target, {
          method: request.method,
          headers,
          ...(withBody ? { body: new Uint8Array(body) } : {}),
          redirect: "manual",
          signal: abort.signal,
        }),
      catch: (cause) =>
        new TunnelFailed({
          message: `Selkies request failed: ${String(cause)}`,
        }),
    }).pipe(timeoutAs("Selkies did not answer"));

    yield* writer.write(
      encodeTunnelControl({
        kind: "response",
        status: response.status,
        headers: responseHeaders(response.headers),
      }),
    );
    const stream = response.body;
    if (stream !== null) {
      const chunks = stream.getReader();
      const pump: Effect.Effect<void, TunnelFailed | Socket.SocketError> =
        Effect.gen(function* () {
          while (true) {
            const chunk = yield* Effect.tryPromise({
              try: () => chunks.read(),
              catch: (cause) =>
                new TunnelFailed({
                  message: `Selkies body broken off: ${String(cause)}`,
                }),
            });
            if (chunk.done) return;
            if (chunk.value.byteLength > 0) yield* writer.write(chunk.value);
          }
        });
      // Канал закрылся раньше, чем тело кончилось, — дальше слать некуда.
      const finished = yield* Effect.raceFirst(
        Effect.as(pump, true),
        Effect.as(untilClosed(reader), false),
      );
      if (!finished) return;
    }
    yield* writer.write(new Socket.CloseEvent(1000));
  });

/**
 * WebSocket: открыть WebSocket Selkies с подпротоколами api, ответить
 * `open` с выбранным Selkies, затем кадры в обе стороны до закрытия любой.
 * Обе стороны — клиент WebSocket Bun, а он (в отличие от браузерного)
 * отправляет и коды 1001–1014, поэтому `browserApi = false`, как в relay.
 */
const serveWs = (
  request: TunnelOpenWs,
  base: string,
  reader: Socket.Reader,
  messages: ChannelMessages,
  writer: Socket.Writer,
) =>
  Effect.gen(function* () {
    const target = yield* targetUrl(base, request.path);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const headers: Record<string, string> = {};
    for (const [name, value] of forwarded(request.headers)) {
      const key = name.toLowerCase();
      headers[key] =
        headers[key] === undefined ? value : `${headers[key]}, ${value}`;
    }
    const selkies = yield* dialWebSocket(target.href, {
      headers,
      ...(request.protocols.length > 0
        ? { protocols: [...request.protocols] }
        : {}),
    });
    const selkiesReader = yield* selkies.socket.reader.pipe(
      Effect.mapError(
        (error) =>
          new TunnelFailed({
            message: `Selkies WebSocket did not open: ${String(error.reason)}`,
          }),
      ),
    );
    const selkiesWriter = yield* selkies.socket.writer;
    yield* writer.write(
      encodeTunnelControl({ kind: "open", protocol: selkies.protocol() }),
    );
    // Кадры api, пришедшие вместе с запросом (обычно их нет: api ждёт `open`).
    const [first, ...rest] = messages.rest();
    if (first !== undefined) yield* selkiesWriter.writeAll([first, ...rest]);
    yield* Effect.raceFirst(
      pipeFrames(selkiesReader, writer, false),
      pipeFrames(reader, selkiesWriter, false),
    );
  });

export interface TunnelClientShape {
  /**
   * Обслужить тоннель `tunnelId` к Selkies сессии `sessionId`; завершается,
   * когда канал закрыт. Не падает: отказы и сбои — предупреждения в логе.
   * Долгий (WebSocket живёт всю игру) — запускать в фоне, не в потоке команд.
   */
  readonly open: (command: {
    readonly tunnelId: string;
    readonly sessionId: string;
  }) => Effect.Effect<void>;
}

const make = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const supervisor = yield* SessionSupervisor;
  const upstreamFor = yield* TunnelUpstream;
  const authorization = `Bearer ${Redacted.value(config.workerToken)}`;
  /** Каналы в работе (от проверки предела до закрытия). */
  let inFlight = 0;

  const reserve = Effect.acquireRelease(
    Effect.sync(() => {
      if (inFlight >= MAX_TUNNELS) return false;
      inFlight++;
      return true;
    }),
    (reserved) =>
      reserved
        ? Effect.sync(() => {
            inFlight--;
          })
        : Effect.void,
  );

  const serve = (tunnelId: string, sessionId: string) =>
    Effect.gen(function* () {
      const channel = yield* dialWebSocket(
        tunnelChannelUrl(config.orchestratorUrl, tunnelId),
        { headers: { authorization } },
      );
      const reader = yield* channel.socket.reader.pipe(
        Effect.mapError(
          (error) =>
            new TunnelFailed({
              message: `channel did not open: ${String(error.reason)}`,
            }),
        ),
      );
      const writer = yield* channel.socket.writer;
      const messages = channelMessages(reader);
      // Любой сбой после открытия канала — `error` оркестратору и код 1011.
      yield* Effect.gen(function* () {
        const request = yield* messages.next.pipe(
          Effect.mapError(
            () =>
              new TunnelFailed({ message: "channel closed before request" }),
          ),
          timeoutAs("no request on channel"),
          Effect.map((message) =>
            typeof message === "string"
              ? decodeTunnelControl(message)
              : Option.none<TunnelControl>(),
          ),
        );
        const base = upstreamFor(sessionId);
        if (Option.isSome(request) && request.value.kind === "http")
          return yield* serveHttp(
            request.value,
            base,
            reader,
            messages,
            writer,
          );
        if (Option.isSome(request) && request.value.kind === "ws")
          return yield* serveWs(request.value, base, reader, messages, writer);
        return yield* new TunnelFailed({ message: "unexpected request" });
      }).pipe(
        Effect.tapError((error) =>
          refuse(
            writer,
            error._tag === "TunnelFailed" ? error.message : "channel error",
          ),
        ),
      );
    });

  const open: TunnelClientShape["open"] = ({ tunnelId, sessionId }) =>
    Effect.gen(function* () {
      if (!supervisor.hasStream(sessionId)) {
        yield* Effect.logWarning(
          "Tunnel refused: no live stream of this session here",
          { tunnelId, sessionId },
        );
        return;
      }
      if (!(yield* reserve)) {
        yield* Effect.logWarning("Tunnel refused: too many open tunnels", {
          tunnelId,
          sessionId,
          limit: MAX_TUNNELS,
        });
        return;
      }
      yield* serve(tunnelId, sessionId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Stream tunnel failed", {
            tunnelId,
            sessionId,
            cause:
              error._tag === "TunnelFailed"
                ? error.message
                : String(error.reason),
          }),
        ),
      );
    }).pipe(Effect.scoped);

  return { open } satisfies TunnelClientShape;
});

export class TunnelClient extends Context.Service<
  TunnelClient,
  TunnelClientShape
>()("@cg/agent/TunnelClient") {
  static readonly layer: Layer.Layer<
    TunnelClient,
    never,
    AgentConfig | SessionSupervisor
  > = Layer.effect(TunnelClient, make);
}
