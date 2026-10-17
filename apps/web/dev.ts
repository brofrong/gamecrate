// Dev-сервер SPA: HTML-импорт Bun (Tailwind — через bunfig.toml [serve.static]).
// `/api/*`, `/rpc` (WebSocket) и `/stream/*` (стрим сессии: HTTP и WebSocket Selkies)
// проксируются на apps/api, чтобы браузер видел один origin и cookie сессии Better Auth
// ходили и в HTTP, и в апгрейд сокета (iframe стрима тоже должен быть same-origin).
//   WEB_PORT — порт dev-сервера (по умолчанию 5173), API_URL — адрес api (http://localhost:3000).
import index from "./src/index.html";

const port = Number(Bun.env.WEB_PORT ?? 5173);
const apiUrl = new URL(Bun.env.API_URL ?? "http://localhost:3000");
/** WebSocket-адрес api для пути (и query) запроса браузера. */
const apiWsUrl = (request: Request) => {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, apiUrl);
  target.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  return target;
};

/** HTTP-прокси на api; Host/Origin браузера сохраняются, редиректы отдаются браузеру как есть. */
async function proxyHttp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, apiUrl);
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
  // fetch уже распаковал тело — длина и кодировка исходного ответа не подходят.
  const out = new Headers(response.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}

/** Сообщение сокета: NDJSON-сериализация RPC шлёт текст, двоичные кадры пропускаем как есть. */
type Frame = string | ArrayBuffer;

type WsData = {
  target: URL;
  headers: Record<string, string>;
  upstream?: WebSocket;
  queue: Array<Frame>;
};

const toFrame = (message: string | Buffer): Frame =>
  typeof message === "string"
    ? message
    : (new Uint8Array(message).buffer as ArrayBuffer);

/** Конструктор WebSocket из Bun: в отличие от DOM-версии принимает заголовки. */
const BunWebSocket = WebSocket as unknown as new (
  url: URL,
  options: Bun.WebSocketOptions,
) => WebSocket;

/** Заголовки апгрейда, которые нужны api: cookie сессии, origin и user-agent. */
const forwardedWsHeaders = (request: Request) => {
  const headers: Record<string, string> = {};
  for (const name of ["cookie", "origin", "user-agent"]) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
};

const upgrade = (request: Request, server: Bun.Server<WsData>) =>
  server.upgrade(request, {
    data: {
      target: apiWsUrl(request),
      headers: forwardedWsHeaders(request),
      queue: [],
    },
  });

const server = Bun.serve({
  port,
  // HMR выключен: dev-бандлер Bun 1.4.4 ломается на циклическом импорте в
  // @tanstack/router-core (router.js ↔ load-client.js) — «Cannot read properties of
  // null (reading 'replaceRouteChunk')». Без HMR страница пересобирается на каждый
  // запрос: после правки достаточно обновить вкладку.
  development: { hmr: false },
  routes: {
    "/api/*": proxyHttp,
    "/rpc": (request, server) =>
      upgrade(request, server)
        ? undefined
        : new Response("Ожидался WebSocket", { status: 426 }),
    // Selkies: страница и ассеты по HTTP, сигналинг — WebSocket на том же префиксе.
    "/stream/*": (request, server) =>
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ? upgrade(request, server)
          ? undefined
          : new Response("Ожидался WebSocket", { status: 426 })
        : proxyHttp(request),
    "/*": index,
  },
  websocket: {
    data: {} as WsData,
    open(ws) {
      const upstream = new BunWebSocket(ws.data.target, {
        headers: ws.data.headers,
      });
      upstream.binaryType = "arraybuffer";
      ws.data.upstream = upstream;
      upstream.addEventListener("open", () => {
        for (const message of ws.data.queue) upstream.send(message);
        ws.data.queue = [];
      });
      upstream.addEventListener("message", (event) => {
        ws.send(event.data as Frame);
      });
      upstream.addEventListener("close", (event) => {
        ws.close(event.code === 1005 ? 1000 : event.code, event.reason);
      });
      upstream.addEventListener("error", () => {
        ws.close(1011, "api недоступен");
      });
    },
    message(ws, message) {
      const upstream = ws.data.upstream;
      const frame = toFrame(message);
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
      else ws.data.queue.push(frame);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});

console.log(`web dev: ${server.url} → api ${apiUrl.origin}`);
