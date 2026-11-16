// Раздача десктоп-сборок: `GET /download/desktop/latest.json` и
// `GET /download/desktop/:version/:file` из фейкового бакета (Map). Маршруты публичные.
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { BunHttpServer } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { desktopConfig } from "../src/config";
import {
  contentTypeOf,
  DesktopReleases,
  DesktopReleasesError,
} from "../src/download/DesktopReleases";
import {
  DesktopRoutes,
  DesktopUpload,
  maxUploadBytes,
} from "../src/download/routes";

const exe = new Uint8Array([77, 90, 144, 0, 3, 0, 0, 0]);
const objects = new Map<string, { body: Uint8Array; contentType?: string }>([
  ["latest.json", { body: new TextEncoder().encode('{"version":"0.1.0"}') }],
  ["0.1.0/GameCrate_0.1.0_x64-setup.exe", { body: exe }],
  ["0.1.0/GameCrate_0.1.0_universal.app.tar.gz", { body: new Uint8Array(3) }],
  [
    "0.1.0/GameCrate_0.1.0_universal.app.tar.gz.sig",
    { body: new Uint8Array(2) },
  ],
]);

const app = HttpRouter.toWebHandler(
  DesktopRoutes.pipe(
    Layer.provide(DesktopReleases.test(objects)),
    Layer.provide(DesktopUpload.none),
    Layer.provide(BunHttpServer.layerHttpServices),
  ),
  { disableLogger: true },
);
afterAll(() => app.dispose());

const get = (path: string, init?: RequestInit) =>
  app.handler(new Request(`http://localhost${path}`, init));

describe("GET /download/desktop/latest.json", () => {
  it("serves the manifest with no-cache, without any cookie", async () => {
    const response = await get("/download/desktop/latest.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ version: "0.1.0" });
  });

  it("is 404 when there is no manifest in the bucket", async () => {
    const empty = HttpRouter.toWebHandler(
      DesktopRoutes.pipe(
        Layer.provide(DesktopReleases.test(new Map())),
        Layer.provide(DesktopUpload.none),
        Layer.provide(BunHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );
    const response = await empty.handler(
      new Request("http://localhost/download/desktop/latest.json"),
    );
    expect(response.status).toBe(404);
    await empty.dispose();
  });
});

describe("GET /download/desktop/:version/:file", () => {
  it("streams the file with Content-Length and an immutable cache", async () => {
    const response = await get(
      "/download/desktop/0.1.0/GameCrate_0.1.0_x64-setup.exe",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(exe.length));
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.microsoft.portable-executable",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(exe);
  });

  it("gives .tar.gz and .sig their own content types", async () => {
    const tar = await get(
      "/download/desktop/0.1.0/GameCrate_0.1.0_universal.app.tar.gz",
    );
    expect(tar.headers.get("content-type")).toBe("application/gzip");
    const sig = await get(
      "/download/desktop/0.1.0/GameCrate_0.1.0_universal.app.tar.gz.sig",
    );
    expect(sig.headers.get("content-type")).toContain("text/plain");
  });

  it("is 404 when the object is missing", async () => {
    const response = await get("/download/desktop/0.1.0/nope.exe");
    expect(response.status).toBe(404);
  });

  it.each([
    ["1.0", "/download/desktop/1.0/a.exe"],
    ["1.0.0.0", "/download/desktop/1.0.0.0/a.exe"],
    ["v1.0.0", "/download/desktop/v1.0.0/a.exe"],
    ["latest", "/download/desktop/latest/a.exe"],
    ["space in file", "/download/desktop/0.1.0/a%20b.exe"],
    ["dotdot in version", "/download/desktop/..%2F0.1.0/a.exe"],
    ["dotdot file", "/download/desktop/0.1.0/..%2Flatest.json"],
    ["encoded slash", "/download/desktop/0.1.0/a%2Fb.exe"],
    ["extra segment", "/download/desktop/0.1.0/a/b.exe"],
    ["too long file", `/download/desktop/0.1.0/${"a".repeat(201)}.exe`],
  ])("is 404 for a bad path: %s", async (_name, path) => {
    const response = await get(path);
    expect(response.status).toBe(404);
  });

  it("answers HEAD with the real size (download managers, curl -I)", async () => {
    const response = await get(
      "/download/desktop/0.1.0/GameCrate_0.1.0_x64-setup.exe",
      { method: "HEAD" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(exe.length));
  });

  it("is 404 for other methods and unknown paths, not the SPA page", async () => {
    // выкладка не настроена (нет DESKTOP_UPLOAD_TOKEN) — PUT тоже 404
    const put = await get(
      "/download/desktop/0.1.0/GameCrate_0.1.0_x64-setup.exe",
      { method: "PUT", body: exe, headers: { authorization: "Bearer x" } },
    );
    expect(put.status).toBe(404);
    const post = await get(
      "/download/desktop/0.1.0/GameCrate_0.1.0_x64-setup.exe",
      { method: "POST" },
    );
    expect(post.status).toBe(404);
    expect((await get("/download/desktop")).status).toBe(404);
    expect((await get("/download/desktop/0.1.0")).status).toBe(404);
    expect(
      (await get("/download/desktop/0.1.0", { method: "HEAD" })).status,
    ).toBe(404);
  });
});

describe("contentTypeOf", () => {
  it.each([
    ["latest.json", "application/json"],
    ["a.dmg", "application/x-apple-diskimage"],
    ["a.AppImage", "application/octet-stream"],
    ["a.deb", "application/vnd.debian.binary-package"],
    ["a.msi", "application/octet-stream"],
    ["a.unknown", "application/octet-stream"],
  ])("%s → %s", (name, expected) => {
    expect(contentTypeOf(name)).toBe(expected);
  });
});

describe("desktopConfig", () => {
  const parse = (env: Record<string, string>) =>
    Effect.runPromise(desktopConfig.parse(ConfigProvider.fromUnknown(env)));

  it("has defaults and no keys when nothing is set", async () => {
    const config = await parse({});
    expect(config.endpoint).toBe("http://cg-rustfs:9000");
    expect(config.bucket).toBe("cg-desktop");
    expect(Option.isNone(config.credentials)).toBe(true);
    expect(Option.isNone(config.uploadToken)).toBe(true);
  });

  it("empty compose placeholders are the same as unset", async () => {
    const config = await parse({
      DESKTOP_S3_ACCESS_KEY: "",
      DESKTOP_S3_SECRET_KEY: "",
      DESKTOP_UPLOAD_TOKEN: "",
    });
    expect(Option.isNone(config.credentials)).toBe(true);
    expect(Option.isNone(config.uploadToken)).toBe(true);
  });

  it("reads the upload token as a secret", async () => {
    const config = await parse({ DESKTOP_UPLOAD_TOKEN: "tok-123" });
    expect(Option.isSome(config.uploadToken)).toBe(true);
    if (!Option.isSome(config.uploadToken)) return;
    expect(Redacted.value(config.uploadToken.value)).toBe("tok-123");
    expect(String(config.uploadToken.value)).not.toContain("tok-123");
  });

  it("reads both keys together", async () => {
    const config = await parse({
      DESKTOP_S3_ENDPOINT: "http://rustfs.example:9000",
      DESKTOP_S3_BUCKET: "b",
      DESKTOP_S3_ACCESS_KEY: "ak",
      DESKTOP_S3_SECRET_KEY: "sk",
    });
    expect(config.endpoint).toBe("http://rustfs.example:9000");
    expect(config.bucket).toBe("b");
    expect(Option.isSome(config.credentials)).toBe(true);
  });

  it("rejects a lone key", async () => {
    const result = await Effect.runPromise(
      desktopConfig
        .parse(ConfigProvider.fromUnknown({ DESKTOP_S3_ACCESS_KEY: "ak" }))
        .pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("DesktopReleases on Bun.S3Client", () => {
  const seen: string[] = [];
  const stored = new Map<string, { body: Uint8Array; type: string | null }>();
  const s3 = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      seen.push(`${request.method} ${pathname}`);
      if (request.method === "PUT" && pathname === "/cg-desktop/fail.exe")
        return new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: 403,
        });
      if (request.method === "PUT") {
        stored.set(pathname, {
          body: new Uint8Array(await request.arrayBuffer()),
          type: request.headers.get("content-type"),
        });
        return new Response(null, { headers: { etag: '"x"' } });
      }
      if (pathname === "/cg-desktop/0.1.0/a.exe")
        return new Response(request.method === "HEAD" ? null : "abcde", {
          headers: { "content-length": "5", etag: '"x"' },
        });
      if (pathname === "/cg-desktop/boom")
        return new Response("<Error><Code>InternalError</Code></Error>", {
          status: 500,
        });
      return new Response(
        "<Error><Code>NoSuchKey</Code><Message>nope</Message></Error>",
        { status: 404, headers: { "content-type": "application/xml" } },
      );
    },
  });
  afterAll(() => s3.stop(true));

  const releases = DesktopReleases.make({
    endpoint: `http://127.0.0.1:${s3.port}`,
    bucket: "cg-desktop",
    accessKeyId: "ak",
    secretAccessKey: "sk",
  });

  it("reads a stream with its size through a path-style URL", async () => {
    const found = await Effect.runPromise(releases.get("0.1.0/a.exe"));
    expect(Option.isSome(found)).toBe(true);
    if (!Option.isSome(found)) return;
    expect(found.value.size).toBe(5);
    expect(found.value.contentType).toBe(
      "application/vnd.microsoft.portable-executable",
    );
    expect(await new Response(found.value.body).text()).toBe("abcde");
    expect(seen).toContain("HEAD /cg-desktop/0.1.0/a.exe");
  });

  it("answers None for a missing object", async () => {
    const found = await Effect.runPromise(releases.get("0.1.0/missing.exe"));
    expect(Option.isNone(found)).toBe(true);
  });

  it("fails on a storage error", async () => {
    const result = await Effect.runPromise(
      releases.get("boom").pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });

  it("writes a stream with its content type through a path-style URL", async () => {
    const body = new Blob([new Uint8Array([4, 5, 6])]).stream();
    await Effect.runPromise(
      releases.put("0.2.0/up.exe", body, contentTypeOf("up.exe"), 3),
    );
    const object = stored.get("/cg-desktop/0.2.0/up.exe");
    expect(object?.body).toEqual(new Uint8Array([4, 5, 6]));
    expect(object?.type).toBe("application/vnd.microsoft.portable-executable");
  });

  it("fails when the storage refuses the write", async () => {
    const result = await Effect.runPromise(
      releases
        .put("fail.exe", new Blob(["x"]).stream(), "application/octet-stream")
        .pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("DesktopReleases without keys", () => {
  it("answers None for every key", async () => {
    const result = await Effect.runPromise(
      DesktopReleases.use((releases) => releases.get("latest.json")).pipe(
        Effect.provide(DesktopReleases.disabled),
      ),
    );
    expect(Option.isNone(result)).toBe(true);
  });

  it("refuses writes", async () => {
    const result = await Effect.runPromise(
      DesktopReleases.use((releases) =>
        releases.put(
          "latest.json",
          new Blob(["{}"]).stream(),
          "application/json",
        ),
      ).pipe(Effect.provide(DesktopReleases.disabled), Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("PUT /download/desktop/* (выкладка из GitHub Actions)", () => {
  const token = "upload-token-0123456789abcdef";
  const limit = 1024;
  const bucket = new Map<string, { body: Uint8Array }>();
  const upload = HttpRouter.toWebHandler(
    DesktopRoutes.pipe(
      Layer.provide(DesktopReleases.test(bucket)),
      // маленький лимит, чтобы не гонять в тесте 500 МБ
      Layer.provide(DesktopUpload.withToken(token, limit)),
      Layer.provide(BunHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  afterAll(() => upload.dispose());
  afterEach(() => bucket.clear());

  const put = (
    path: string,
    body: BodyInit | null,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
  ) =>
    upload.handler(
      new Request(`http://localhost${path}`, { method: "PUT", body, headers }),
    );
  const getFrom = (path: string, init?: RequestInit) =>
    upload.handler(new Request(`http://localhost${path}`, init));

  const file = "/download/desktop/0.2.0/GameCrate_0.2.0_x64-setup.exe";
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);

  it("stores the file with the right token (201), then GET and HEAD serve it", async () => {
    const response = await put(file, payload);
    expect(response.status).toBe(201);
    expect(bucket.get("0.2.0/GameCrate_0.2.0_x64-setup.exe")?.body).toEqual(
      payload,
    );
    const served = await getFrom(file);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(payload);
    const head = await getFrom(file, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(payload.length));
  });

  it("stores latest.json at its own path", async () => {
    const manifest = '{"version":"0.2.0"}';
    const response = await put("/download/desktop/latest.json", manifest, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    expect(response.status).toBe(201);
    const served = await getFrom("/download/desktop/latest.json");
    expect(served.headers.get("cache-control")).toBe("no-cache");
    expect(await served.json()).toEqual({ version: "0.2.0" });
  });

  it("streams a body without Content-Length (chunked)", async () => {
    const chunks = [new Uint8Array([9, 9]), new Uint8Array([8])];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await put(file, stream);
    expect(response.status).toBe(201);
    expect(bucket.get("0.2.0/GameCrate_0.2.0_x64-setup.exe")?.body).toEqual(
      new Uint8Array([9, 9, 8]),
    );
  });

  it.each([
    ["no Authorization", {}],
    ["wrong token", { authorization: "Bearer nope" }],
    ["token prefix", { authorization: `Bearer ${token.slice(0, -1)}` }],
    ["token with suffix", { authorization: `Bearer ${token}x` }],
    ["not Bearer", { authorization: `Basic ${token}` }],
    ["empty Bearer", { authorization: "Bearer " }],
  ])("is 401 with %s and stores nothing", async (_name, headers) => {
    const response = await put(file, payload, headers);
    expect(response.status).toBe(401);
    expect(bucket.size).toBe(0);
  });

  it.each([
    ["1.0", "/download/desktop/1.0/a.exe"],
    ["v-prefix", "/download/desktop/v0.2.0/a.exe"],
    ["dotdot file", "/download/desktop/0.2.0/..%2Flatest.json"],
    ["encoded slash", "/download/desktop/0.2.0/a%2Fb.exe"],
    ["extra segment", "/download/desktop/0.2.0/a/b.exe"],
    ["space", "/download/desktop/0.2.0/a%20b.exe"],
    ["no file", "/download/desktop/0.2.0"],
    ["other json", "/download/desktop/other.json"],
  ])("is 404 for a bad path: %s", async (_name, path) => {
    const response = await put(path, payload);
    expect(response.status).toBe(404);
    expect(bucket.size).toBe(0);
  });

  it("is 413 when Content-Length is over the limit, before reading the body", async () => {
    let pulled = false;
    // highWaterMark 0: pull только когда тело действительно читают
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await upload.handler(
      new Request(`http://localhost${file}`, {
        method: "PUT",
        body: stream,
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": String(limit + 1),
        },
      }),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBe(false);
    expect(bucket.size).toBe(0);
  });

  it("is 413 when a chunked body grows over the limit, and nothing is stored", async () => {
    const chunk = new Uint8Array(300);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // чуть больше лимита
        if (sent > limit) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const response = await put(file, stream);
    expect(response.status).toBe(413);
    expect(bucket.size).toBe(0);
  });

  it("accepts a body of exactly the limit", async () => {
    const response = await put(file, new Uint8Array(limit));
    expect(response.status).toBe(201);
  });

  it("is 400 without a body", async () => {
    const response = await put(file, null);
    expect(response.status).toBe(400);
    expect(bucket.size).toBe(0);
  });

  it("never logs the token, even when the storage fails", async () => {
    const broken = HttpRouter.toWebHandler(
      DesktopRoutes.pipe(
        Layer.provide(
          Layer.succeed(DesktopReleases, {
            get: () => Effect.succeed(Option.none()),
            put: (key) =>
              Effect.fail(new DesktopReleasesError({ message: `boom ${key}` })),
          }),
        ),
        Layer.provide(DesktopUpload.withToken(token)),
        Layer.provide(BunHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );
    const output: string[] = [];
    const capture = (...args: unknown[]) => {
      output.push(
        args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" "),
      );
    };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => spyOn(console, method).mockImplementation(capture),
    );
    try {
      const failed = await broken.handler(
        new Request(`http://localhost${file}`, {
          method: "PUT",
          body: payload,
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(failed.status).toBe(502);
      const denied = await put(file, payload, {
        authorization: "Bearer wrong-token-value",
      });
      expect(denied.status).toBe(401);
    } finally {
      for (const spy of spies) spy.mockRestore();
      await broken.dispose();
    }
    // сбой хранилища залогирован (перехват работает), токена в логе нет
    expect(output.join("\n")).toContain(
      "boom 0.2.0/GameCrate_0.2.0_x64-setup.exe",
    );
    expect(output.join("\n")).not.toContain(token);
    expect(output.join("\n")).not.toContain("wrong-token-value");
  });
});

describe("DesktopUpload", () => {
  it("defaults to a 500 MiB limit", () => {
    expect(maxUploadBytes).toBe(500 * 1024 * 1024);
  });

  it("withToken() keeps the token redacted", async () => {
    const value = await Effect.runPromise(
      DesktopUpload.use((t) => Effect.succeed(t)).pipe(
        Effect.provide(DesktopUpload.withToken("secret-x")),
      ),
    );
    expect(Option.isSome(value.token)).toBe(true);
    expect(value.maxBytes).toBe(maxUploadBytes);
    expect(JSON.stringify(value)).not.toContain("secret-x");
  });
});
