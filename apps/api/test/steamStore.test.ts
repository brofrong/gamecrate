// Клиент Steam Store (`appdetails`) для страницы игры: мягкое декодирование ответа,
// `success: false` → NotFound, сеть/не-JSON/таймаут → Unavailable. Никогда не падает.
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { SteamStoreApi } from "../src/steam/SteamStoreApi";

/** Фейковый `HttpClient`: `respond` строит ответ (или сетевую ошибку) на любой запрос. */
const fakeHttpClient = (
  respond: () => { status: number; body: string } | "network-error",
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const result = respond();
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
          new Response(result.body, { status: result.status }),
        ),
      );
    }),
  );

const run = (
  respond: () => { status: number; body: string } | "network-error",
) =>
  Effect.runPromise(
    SteamStoreApi.use((store) => store.fetchDetails(1086940)).pipe(
      Effect.provide(SteamStoreApi.layer),
      Effect.provide(fakeHttpClient(respond)),
    ),
  );

const json = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

const fullData = {
  short_description: "Собери отряд.",
  about_the_game: "<p>Вернись в Забытые Королевства.</p>",
  developers: ["Larian Studios"],
  publishers: ["Larian Studios"],
  genres: [
    { id: "25", description: "Приключенческие игры" },
    { id: "3", description: "Ролевые игры" },
  ],
  release_date: { coming_soon: false, date: "3 авг. 2023 г." },
  metacritic: {
    score: 96,
    url: "https://www.metacritic.com/game/pc/baldurs-gate-3",
  },
  controller_support: "full",
  platforms: { windows: true, mac: true, linux: true },
  achievements: { total: 54, highlighted: [] },
  screenshots: [
    {
      id: 0,
      path_thumbnail: "https://shared.akamai.steamstatic.com/ss_1.600x338.jpg",
      path_full: "https://shared.akamai.steamstatic.com/ss_1.1920x1080.jpg",
    },
  ],
  movies: [
    {
      id: 1,
      name: "Трейлер",
      thumbnail: "https://shared.akamai.steamstatic.com/movie.jpg",
      hls_h264: "https://video.akamai.steamstatic.com/hls_264_master.m3u8",
      dash_h264: "https://video.akamai.steamstatic.com/dash_h264.mpd",
      highlight: true,
    },
    {
      id: 2,
      name: "Без HLS",
      thumbnail: "https://shared.akamai.steamstatic.com/movie2.jpg",
      dash_h264: "https://video.akamai.steamstatic.com/dash2.mpd",
      highlight: false,
    },
  ],
};

describe("SteamStoreApi.fetchDetails", () => {
  it("maps a full appdetails response", async () => {
    const result = await run(() =>
      json({ "1086940": { success: true, data: fullData } }),
    );
    expect(result._tag).toBe("Found");
    if (result._tag !== "Found") return;
    expect(result.details).toEqual({
      shortDescription: "Собери отряд.",
      aboutTheGame: "<p>Вернись в Забытые Королевства.</p>",
      developers: ["Larian Studios"],
      publishers: ["Larian Studios"],
      genres: ["Приключенческие игры", "Ролевые игры"],
      releaseDate: "3 авг. 2023 г.",
      metacriticScore: 96,
      metacriticUrl: "https://www.metacritic.com/game/pc/baldurs-gate-3",
      controllerSupport: "full",
      linux: true,
      achievementsTotal: 54,
      screenshots: [
        {
          thumb: "https://shared.akamai.steamstatic.com/ss_1.600x338.jpg",
          full: "https://shared.akamai.steamstatic.com/ss_1.1920x1080.jpg",
        },
      ],
      // Фильм без `hls_h264` пропущен.
      movies: [
        {
          name: "Трейлер",
          thumbnail: "https://shared.akamai.steamstatic.com/movie.jpg",
          hls: "https://video.akamai.steamstatic.com/hls_264_master.m3u8",
          highlight: true,
        },
      ],
    });
  });

  it("success:false → NotFound", async () => {
    const result = await run(() => json({ "1086940": { success: false } }));
    expect(result).toEqual({ _tag: "NotFound" });
  });

  it("network error → Unavailable", async () => {
    expect(await run(() => "network-error")).toEqual({ _tag: "Unavailable" });
  });

  it("non-JSON body → Unavailable", async () => {
    expect(
      await run(() => ({ status: 429, body: "<html>rate limited</html>" })),
    ).toEqual({
      _tag: "Unavailable",
    });
  });

  it("missing fields → defaults", async () => {
    const result = await run(() =>
      json({ "1086940": { success: true, data: { name: "Tool" } } }),
    );
    expect(result._tag).toBe("Found");
    if (result._tag !== "Found") return;
    expect(result.details).toEqual({
      shortDescription: "",
      aboutTheGame: "",
      developers: [],
      publishers: [],
      genres: [],
      releaseDate: null,
      metacriticScore: null,
      metacriticUrl: null,
      controllerSupport: null,
      linux: false,
      achievementsTotal: 0,
      screenshots: [],
      movies: [],
    });
  });
});
