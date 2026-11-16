// Раздача десктоп-сборок: `GET /download/desktop/latest.json` и
// `GET /download/desktop/:version/:file` из фейкового бакета (Map). Маршруты публичные.
import { afterAll, describe, expect, it } from "bun:test";
import { BunHttpServer } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { desktopConfig } from "../src/config";
import {
  contentTypeOf,
  DesktopReleases,
} from "../src/download/DesktopReleases";
import { DesktopRoutes } from "../src/download/routes";

const exe = new Uint8Array([77, 90, 144, 0, 3, 0, 0, 0]);
const objects = new Map<string, { body: Uint8Array; contentType?: string }>([
  [
    "latest.json",
    { body: new TextEncoder().encode('{"version":"0.1.0"}') },
  ],
  ["0.1.0/GameCrate_0.1.0_x64-setup.exe", { body: exe }],
  ["0.1.0/GameCrate_0.1.0_universal.app.tar.gz", { body: new Uint8Array(3) }],
  ["0.1.0/GameCrate_0.1.0_universal.app.tar.gz.sig", { body: new Uint8Array(2) }],
]);

const app = HttpRouter.toWebHandler(
  DesktopRoutes.pipe(
    Layer.provide(DesktopReleases.test(objects)),
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
  ])("is 404 for a bad path: %s", async (_name, path) => {
    const response = await get(path);
    expect(response.status).toBe(404);
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
  });

  it("empty compose placeholders are the same as unset", async () => {
    const config = await parse({
      DESKTOP_S3_ACCESS_KEY: "",
      DESKTOP_S3_SECRET_KEY: "",
    });
    expect(Option.isNone(config.credentials)).toBe(true);
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
  const s3 = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      seen.push(`${request.method} ${pathname}`);
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
});
