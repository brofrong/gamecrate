import { describe, expect, it } from "bun:test";
import { SteamUnavailable } from "@cg/rpc";
import { Effect, Fiber, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { AppConfig } from "../src/config";
import type { OwnedGames } from "../src/steam/SteamApi";
import { SteamApi } from "../src/steam/SteamApi";

const dummyApiKey = "test-dummy-steam-key-0000000000";

/** Фейковый `HttpClient`: `respond` строит ответ (или сетевую ошибку) на любой запрос. */
const fakeHttpClient = (
  respond: () =>
    { status: number; body: unknown } | "network-error" | "never-responds",
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const result = respond();
      if (result === "never-responds") return Effect.never;
      if (result === "network-error")
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("network down"),
            }),
          }),
        );
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(result.body), {
            status: result.status,
          }),
        ),
      );
    }),
  );

const fakeConfig = Layer.succeed(AppConfig, {
  port: 0,
  publicUrl: "http://localhost:3000",
  databaseUrl: Redacted.make("postgres://unused"),
  steamApiKey: Redacted.make(dummyApiKey),
  authSecret: Redacted.make("unused"),
  pocketIdUrl: "https://sso.example.invalid",
  pocketIdClientId: "unused",
  pocketIdClientSecret: Redacted.make("unused"),
  pocketIdAdminGroup: "cloud_gaming_admins",
  allowedOrigins: [],
  webDistDir: "unused",
  smtpUrl: Redacted.make("log://"),
  mailFrom: "GameCrate <test@example.com>",
  google: Option.none(),
  yandex: Option.none(),
  telegram: Option.none(),
});

const run = (
  respond: () => { status: number; body: unknown } | "network-error",
  steamId = "76561197960287930",
) =>
  Effect.runPromise(
    SteamApi.use((api) => api.getOwnedGames(steamId)).pipe(
      Effect.result,
      Effect.provide(SteamApi.layer),
      Effect.provide(fakeHttpClient(respond)),
      Effect.provide(fakeConfig),
    ),
  );

/** Успешный ответ Steam с заданным `response`. */
const ok = (response: unknown) => () => ({ status: 200, body: { response } });

describe("SteamApi.getOwnedGames", () => {
  it("parses games", async () => {
    const result = await run(() => ({
      status: 200,
      body: {
        response: {
          game_count: 2,
          games: [
            {
              appid: 1794680,
              name: "Vampire Survivors",
              playtime_forever: 125,
            },
            { appid: 730, name: "Counter-Strike 2", playtime_forever: 4000 },
          ],
        },
      },
    }));
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const games: OwnedGames = result.success;
    expect(games._tag).toBe("Games");
    if (games._tag !== "Games") return;
    expect(games.games[0]).toEqual({
      appId: 1794680,
      name: "Vampire Survivors",
      playtimeMinutes: 125,
    });
    expect(games.games).toHaveLength(2);
  });

  it("returns Private for empty response", async () => {
    const result = await run(() => ({
      status: 200,
      body: { response: {} },
    }));
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success).toEqual({ _tag: "Private" });
  });

  it("maps 403 to unauthorized and hides key", async () => {
    const result = await run(() => ({ status: 403, body: {} }));
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure).toBeInstanceOf(SteamUnavailable);
    expect((result.failure as SteamUnavailable).reason).toBe("unauthorized");
    expect(String(result.failure)).not.toContain(dummyApiKey);
    expect(JSON.stringify(result.failure)).not.toContain(dummyApiKey);
  });

  it("maps 429 to rate_limited", async () => {
    const result = await run(() => ({ status: 429, body: {} }));
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect((result.failure as SteamUnavailable).reason).toBe("rate_limited");
  });

  it("maps network error to unavailable and hides key", async () => {
    const result = await run(() => "network-error");
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect((result.failure as SteamUnavailable).reason).toBe("unavailable");
    expect(String(result.failure)).not.toContain(dummyApiKey);
  });

  it("game without name or playtime decodes with fallbacks, others intact", async () => {
    const result = await run(
      ok({
        game_count: 3,
        games: [
          { appid: 730, name: "Counter-Strike 2", playtime_forever: 4000 },
          { appid: 999001 },
          { appid: 999002, name: "", playtime_forever: 5 },
        ],
      }),
    );
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success).toEqual({
      _tag: "Games",
      games: [
        { appId: 730, name: "Counter-Strike 2", playtimeMinutes: 4000 },
        { appId: 999001, name: "App 999001", playtimeMinutes: 0 },
        { appId: 999002, name: "App 999002", playtimeMinutes: 5 },
      ],
    });
  });

  it("game_count 0 without games is an empty library, not Private", async () => {
    const result = await run(ok({ game_count: 0 }));
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success).toEqual({ _tag: "Games", games: [] });
  });

  it("game_count 0 with empty games is an empty library", async () => {
    const result = await run(ok({ game_count: 0, games: [] }));
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success).toEqual({ _tag: "Games", games: [] });
  });

  it("times out after 10 s as unavailable", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* SteamApi.use((api) =>
          api.getOwnedGames("76561197960287930"),
        ).pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("9 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(SteamApi.layer),
        Effect.provide(fakeHttpClient(() => "never-responds")),
        Effect.provide(fakeConfig),
        Effect.provide(TestClock.layer()),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure).toBeInstanceOf(SteamUnavailable);
    expect((result.failure as SteamUnavailable).reason).toBe("unavailable");
  });
});
