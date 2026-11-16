// `index.html` по витрине домена и флаги способов входа по хосту: маршрут через `toWebHandler`
// с временным WEB_DIST_DIR (как в streamProxy.test.ts) и чистые функции `oauthForHost`/`renderIndexHtml`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRANDS } from "@cg/brands";
import { DbTest } from "@cg/db/test";
import { BunHttpServer } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { BetterAuth } from "../src/auth/auth";
import { oauthForHost, renderIndexHtml } from "../src/brand/indexHtml";
import { AppConfig, type AppConfigValues, appConfig } from "../src/config";
import { HttpApp } from "../src/http";
import { OwnGameCatalog } from "../src/library/OwnGameCatalog";
import { ProtonDb } from "../src/steam/ProtonDb";
import { SteamApi } from "../src/steam/SteamApi";
import { SteamStoreApi } from "../src/steam/SteamStoreApi";

const baseEnv = {
  PUBLIC_URL: "https://game.x.ru",
  DATABASE_URL: "postgres://unused",
  STEAM_API_KEY: "unused",
  BETTER_AUTH_SECRET: "unused",
  POCKET_ID_URL: "https://sso.example.invalid",
  POCKET_ID_CLIENT_ID: "unused",
  POCKET_ID_CLIENT_SECRET: "unused",
  POCKET_ID_ADMIN_GROUP: "admins",
  WEB_DIST_DIR: "unused",
  SMTP_URL: "log://",
  MAIL_FROM: "GameCrate <test@example.com>",
  RELAY_SECRET: "test-relay-secret-test-relay-secret-0001",
  BRAND_HOSTS: "play.beeline.ru=beeline",
};

const parseConfig = (env: Record<string, string>): Promise<AppConfigValues> =>
  Effect.runPromise(appConfig.parse(ConfigProvider.fromUnknown(env)));

/** Собранный `index.html` в том виде, как его отдаёт Bun-сборка (см. apps/web/dist/index.html). */
const template = `<!doctype html>
<html lang="ru" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="theme-color" content="#05060f" />
    <meta
      name="description"
      content="Твоя библиотека Steam."
    />
    <meta property="og:title" content="GameCrate — облачный гейминг" />
    <meta
      property="og:description"
      content="Твоя библиотека Steam."
    />
    <title>GameCrate — облачный гейминг</title>
    <link rel="icon" type="image/svg+xml" href="/favicon-s1sq26pm.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon-15jczx5w.png" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

const noOauth = {
  google: false,
  yandex: false,
  pocketId: false,
  telegram: false,
};

describe("renderIndexHtml", () => {
  it("sets brand, oauth list, title and meta for beeline", () => {
    const html = renderIndexHtml(template, BRANDS.beeline, {
      google: true,
      yandex: false,
      pocketId: true,
      telegram: true,
    });
    expect(html).toContain(
      '<html lang="ru" class="dark" data-brand="beeline" data-oauth="google pocket-id telegram">',
    );
    expect(html).toContain("<title>билайн — облачный гейминг</title>");
    expect(html).toContain('<meta name="theme-color" content="#28303f" />');
    expect(html).toContain(
      '<meta property="og:title" content="билайн — облачный гейминг" />',
    );
    expect(html).toContain('href="/brands/beeline/favicon.svg"');
    expect(html).toContain('href="/brands/beeline/apple-touch-icon.png"');
    expect(html).not.toContain("favicon-s1sq26pm");
    expect(html).not.toContain("GameCrate");
  });

  it("keeps template icons for a brand without icons", () => {
    const html = renderIndexHtml(template, BRANDS.gamecrate, noOauth);
    expect(html).toContain('data-brand="gamecrate" data-oauth=""');
    expect(html).toContain('href="/favicon-s1sq26pm.svg"');
    expect(html).toContain('href="/apple-touch-icon-15jczx5w.png"');
  });

  it("real web index.html has no GameCrate left for beeline", async () => {
    const source = await readFile(
      join(import.meta.dir, "../../web/src/index.html"),
      "utf8",
    );
    const html = renderIndexHtml(source, BRANDS.beeline, {
      google: false,
      yandex: false,
      pocketId: false,
      telegram: false,
    });
    expect(html).toContain('data-brand="beeline"');
    expect(html).toContain('href="/brands/beeline/favicon.svg"');
    expect(html).toContain('href="/brands/beeline/apple-touch-icon.png"');
    expect(html).not.toContain("GameCrate");
  });

  it("escapes < and quotes in values", () => {
    const html = renderIndexHtml(
      template,
      { ...BRANDS.beeline, title: "a<b>\"c\" & 'd'", description: 'x"y<' },
      noOauth,
    );
    expect(html).toContain(
      "<title>a&lt;b&gt;&quot;c&quot; &amp; &#39;d&#39;</title>",
    );
    expect(html).toContain('content="x&quot;y&lt;"');
    expect(html).not.toContain("<b>");
  });
});

describe("oauthForHost", () => {
  it("google configured, OAUTH_HOSTS_GOOGLE unset: only the PUBLIC_URL host", async () => {
    const config = await parseConfig({
      ...baseEnv,
      GOOGLE_CLIENT_ID: "g-id",
      GOOGLE_CLIENT_SECRET: "g-secret",
    });
    expect(oauthForHost(config, "game.x.ru").google).toBe(true);
    expect(oauthForHost(config, "play.beeline.ru").google).toBe(false);
  });

  it("google not configured: false everywhere", async () => {
    const config = await parseConfig({
      ...baseEnv,
      OAUTH_HOSTS_GOOGLE: "game.x.ru,play.beeline.ru",
    });
    expect(oauthForHost(config, "game.x.ru").google).toBe(false);
    expect(oauthForHost(config, "play.beeline.ru").google).toBe(false);
  });

  it("host list extends to a brand host; port and case are ignored; pocket id always configured", async () => {
    const config = await parseConfig({
      ...baseEnv,
      GOOGLE_CLIENT_ID: "g-id",
      GOOGLE_CLIENT_SECRET: "g-secret",
      OAUTH_HOSTS_GOOGLE: "game.x.ru, play.beeline.ru",
    });
    expect(oauthForHost(config, "Play.Beeline.ru:443").google).toBe(true);
    expect(oauthForHost(config, "play.beeline.ru").pocketId).toBe(false);
    expect(oauthForHost(config, "game.x.ru").pocketId).toBe(true);
    expect(oauthForHost(config, undefined)).toEqual(noOauth);
  });
});

describe("index.html route", () => {
  let webDistDir: string;
  let app: ReturnType<typeof makeHandler>;

  const makeHandler = (config: AppConfigValues) =>
    HttpRouter.toWebHandler(
      HttpApp.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(BetterAuth, {
              handler: async () => new Response("auth"),
              currentUser: () => Effect.succeed(Option.none()),
            }),
            DbTest,
            Layer.mock(SteamApi)({}),
            Layer.mock(ProtonDb)({}),
            Layer.mock(SteamStoreApi)({}),
            OwnGameCatalog.fromManifests([]),
            Layer.succeed(AppConfig, config),
          ),
        ),
        Layer.provide(BunHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );

  const get = (
    path: string,
    host: string,
    headers: Record<string, string> = {},
  ) =>
    app.handler(
      new Request(`http://localhost${path}`, { headers: { host, ...headers } }),
    );

  beforeAll(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "cg-web-"));
    await writeFile(join(webDistDir, "index.html"), template);
    await mkdir(join(webDistDir, "assets"));
    await writeFile(join(webDistDir, "assets", "app.js"), "console.log(1);");
    await mkdir(join(webDistDir, "brands", "beeline"), { recursive: true });
    await writeFile(
      join(webDistDir, "brands", "beeline", "favicon.svg"),
      "<svg/>",
    );
    app = makeHandler(
      await parseConfig({
        ...baseEnv,
        WEB_DIST_DIR: webDistDir,
        GOOGLE_CLIENT_ID: "g-id",
        GOOGLE_CLIENT_SECRET: "g-secret",
        OAUTH_HOSTS_GOOGLE: "game.x.ru,play.beeline.ru",
      }),
    );
  });
  afterAll(async () => {
    await app.dispose();
    await rm(webDistDir, { recursive: true, force: true });
  });

  it("deep link on a beeline host gets the beeline variant", async () => {
    const response = await get("/app/game/570", "play.beeline.ru");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("vary")).toBe("host, x-forwarded-host");
    const html = await response.text();
    expect(html).toContain('data-brand="beeline"');
    expect(html).toContain('data-oauth="google"');
    expect(html).toContain("<title>билайн — облачный гейминг</title>");
    expect(html).toContain('href="/brands/beeline/favicon.svg"');
    expect(html).not.toContain("GameCrate");
  });

  it("root on an unknown host gets gamecrate with template icons", async () => {
    const response = await get("/", "game.x.ru");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-brand="gamecrate"');
    expect(html).toContain('data-oauth="google pocket-id"');
    expect(html).toContain('href="/favicon-s1sq26pm.svg"');
    const other = await (await get("/", "unknown.example")).text();
    expect(other).toContain('data-brand="gamecrate"');
    expect(other).toContain('data-oauth=""');
  });

  it("x-forwarded-host wins over host", async () => {
    const response = await get("/", "127.0.0.1:3000", {
      "x-forwarded-host": "play.beeline.ru",
    });
    expect(await response.text()).toContain('data-brand="beeline"');
  });

  it("assets are served as files, not html", async () => {
    const response = await get("/assets/app.js", "play.beeline.ru");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toBe("console.log(1);");
  });

  it("brand icons are served as files", async () => {
    const response = await get(
      "/brands/beeline/favicon.svg",
      "play.beeline.ru",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<svg/>");
  });

  it("reserved prefixes are not swallowed by the index route", async () => {
    expect(await (await get("/healthz", "play.beeline.ru")).text()).toBe("ok");
    expect(await (await get("/api/auth/x", "play.beeline.ru")).text()).toBe(
      "auth",
    );
    const missing = await get("/api/unknown", "play.beeline.ru");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("data-brand");
  });

  it("raw template never leaks to a brand host", async () => {
    const index = await get("/index.html", "play.beeline.ru");
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('data-brand="beeline"');
    expect(html).not.toContain("GameCrate");
    const encoded = await (
      await get("/%69ndex.html", "play.beeline.ru")
    ).text();
    expect(encoded).toContain('data-brand="beeline"');
    const reserved = await get("/api/x", "play.beeline.ru", {
      accept: "text/html",
    });
    expect(reserved.status).toBe(404);
    expect(await reserved.text()).not.toContain("GameCrate");
  });

  it("missing asset with an extension is 404, not html", async () => {
    const response = await get("/assets/missing.js", "play.beeline.ru", {
      accept: "text/html",
    });
    expect(response.status).toBe(404);
  });
});

describe("index.html route without a built web app", () => {
  it("missing index.html does not crash the server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-web-"));
    const config = await parseConfig({ ...baseEnv, WEB_DIST_DIR: dir });
    const app = HttpRouter.toWebHandler(
      HttpApp.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(BetterAuth, {
              handler: async () => new Response("auth"),
              currentUser: () => Effect.succeed(Option.none()),
            }),
            DbTest,
            Layer.mock(SteamApi)({}),
            Layer.mock(ProtonDb)({}),
            Layer.mock(SteamStoreApi)({}),
            OwnGameCatalog.fromManifests([]),
            Layer.succeed(AppConfig, config),
          ),
        ),
        Layer.provide(BunHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );
    try {
      const response = await app.handler(
        new Request("http://localhost/", { headers: { host: "game.x.ru" } }),
      );
      expect(response.status).toBe(404);
    } finally {
      await app.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
