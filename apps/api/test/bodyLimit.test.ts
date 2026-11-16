// Общий страж тела запроса (src/bodyLimit.ts): всё, кроме `PUT /download/desktop/*`, — не больше
// 1 МиБ по `Content-Length` (иначе 413) и только с `Content-Length` (chunked — 411). Проверяется
// и на `toWebHandler`, и на настоящем Bun-сервере с лимитом из main.ts (там заголовки ставит
// сам HTTP-парсер Bun).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import {
  BodyLimit,
  bodyVerdict,
  isDesktopUpload,
  maxBodyBytes,
  serverMaxRequestBodySize,
} from "../src/bodyLimit";
import { DesktopReleases } from "../src/download/DesktopReleases";
import {
  DesktopRoutes,
  DesktopUpload,
  maxUploadBytes,
} from "../src/download/routes";

const token = "upload-token-0123456789abcdef";

/** Принятые выкладкой байты: считаем и выбрасываем, чтобы не держать 300 МБ в памяти теста. */
let storedBytes = 0;
const countingReleases = Layer.succeed(DesktopReleases, {
  get: () => Effect.succeed(Option.none()),
  put: (_key, body) =>
    Effect.promise(async () => {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        storedBytes += value.byteLength;
      }
    }),
});

/** Как Better Auth: читает тело целиком (`/api/auth/*` любым методом). */
const authLike = HttpRouter.use((router) =>
  router.add("*", "/api/auth/*", (request) =>
    request.text.pipe(
      Effect.map((text) => HttpServerResponse.text(`auth:${text.length}`)),
      Effect.orDie,
    ),
  ),
);

const app = Layer.mergeAll(
  authLike,
  HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok")),
  DesktopRoutes.pipe(
    Layer.provide(countingReleases),
    Layer.provide(DesktopUpload.withToken(token)),
  ),
  BodyLimit,
);

const chunkedStream = (size: number, chunk = 64 * 1024) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      const length = Math.min(chunk, size - sent);
      sent += length;
      controller.enqueue(new Uint8Array(length));
    },
  });
};

describe("bodyVerdict", () => {
  it.each([
    ["no body", {}, false, undefined],
    ["small", { "content-length": "10" }, true, undefined],
    ["zero", { "content-length": "0" }, false, undefined],
    [
      "exactly 1 MiB",
      { "content-length": String(maxBodyBytes) },
      true,
      undefined,
    ],
    ["1 MiB + 1", { "content-length": String(maxBodyBytes + 1) }, true, 413],
    ["chunked", { "transfer-encoding": "chunked" }, true, 411],
    ["body without length", {}, true, 411],
    ["broken length", { "content-length": "12abc" }, true, 400],
  ] as const)("%s", (_name, headers, hasBody, expected) => {
    expect(bodyVerdict(headers, hasBody)).toBe(expected);
  });
});

describe("isDesktopUpload", () => {
  it.each([
    ["PUT", "/download/desktop/latest.json", true],
    ["PUT", "/download/desktop/0.1.0/a.exe", true],
    ["PUT", "/download/desktop/0.1.0/a.exe?x=1", true],
    ["POST", "/download/desktop/0.1.0/a.exe", false],
    ["GET", "/download/desktop/latest.json", false],
    ["PUT", "/download/desktop/0.1.0/a/b.exe", false],
    ["PUT", "/download/desktop", false],
    ["PUT", "/api/auth/download/desktop/0.1.0/a.exe", false],
    ["PUT", "/api/auth/sign-in/email", false],
  ] as const)("%s %s → %s", (method, url, expected) => {
    expect(isDesktopUpload(method, url)).toBe(expected);
  });

  it("server limit fits the desktop upload and its own 413", () => {
    expect(serverMaxRequestBodySize).toBeGreaterThan(maxUploadBytes);
  });
});

describe("BodyLimit on toWebHandler", () => {
  const web = HttpRouter.toWebHandler(
    app.pipe(Layer.provide(BunHttpServer.layerHttpServices)),
    { disableLogger: true },
  );
  afterAll(() => web.dispose());

  it("2 MiB on /api/auth/sign-in/email is 413 before the handler reads it", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await web.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        body,
        headers: { "content-length": String(2 * 1024 * 1024) },
      }),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBe(false);
  });

  it("a body without Content-Length on a regular route is 411", async () => {
    const response = await web.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        body: chunkedStream(10),
      }),
    );
    expect(response.status).toBe(411);
  });

  it("small requests pass", async () => {
    const response = await web.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        body: '{"email":"a@b.c"}',
        headers: { "content-length": "17" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("auth:17");
    const get = await web.handler(new Request("http://localhost/healthz"));
    expect(get.status).toBe(200);
  });

  it("an unknown route is still subject to the limit (no handler reads it)", async () => {
    const response = await web.handler(
      new Request("http://localhost/nowhere", {
        method: "POST",
        body: chunkedStream(10),
      }),
    );
    expect(response.status).toBe(411);
  });
});

describe("BodyLimit on a real Bun server (main.ts limit)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>;
  let base: string;

  beforeAll(async () => {
    runtime = ManagedRuntime.make(
      HttpRouter.serve(app, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(
          BunHttpServer.layer({
            hostname: "127.0.0.1",
            port: 0,
            maxRequestBodySize: serverMaxRequestBodySize,
          }),
        ),
      ),
    );
    const address = await runtime.runPromise(
      HttpServer.HttpServer.useSync((server) => server.address),
    );
    if (!("port" in address)) throw new Error("expected a TCP address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => runtime.dispose());

  it("2 MiB on /api/auth/sign-in/email is 413", async () => {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      body: new Uint8Array(2 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it("chunked on a regular route is 411", async () => {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      body: chunkedStream(4096),
    });
    expect(response.status).toBe(411);
  });

  it("small POST and GET pass", async () => {
    const post = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      body: '{"email":"a@b.c"}',
    });
    expect(await post.text()).toBe("auth:17");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("a 300 MB desktop build PUT still goes through, chunked too", async () => {
    const size = 300 * 1000 * 1000;
    storedBytes = 0;
    const sized = await fetch(`${base}/download/desktop/0.3.0/big.exe`, {
      method: "PUT",
      body: new Uint8Array(size),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sized.status).toBe(201);
    expect(storedBytes).toBe(size);

    storedBytes = 0;
    const chunked = await fetch(`${base}/download/desktop/0.3.1/big.exe`, {
      method: "PUT",
      body: chunkedStream(size, 1024 * 1024),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(chunked.status).toBe(201);
    expect(storedBytes).toBe(size);
  }, 120_000);
});
