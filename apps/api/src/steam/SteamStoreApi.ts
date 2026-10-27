// Клиент Steam Store (`appdetails`) — описание, скриншоты, трейлеры, факты об игре для
// страницы игры (спека 2026-10-27 §4.1). Никогда не падает: `success: false` → NotFound
// (Steam не знает игру — инструмент, удалённая), сеть/не-JSON/не-2xx/таймаут 5 с →
// Unavailable. Поля декодируются мягко: чего нет — пустая строка/массив/null.
import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

export type StoreDetails = {
  readonly shortDescription: string;
  readonly aboutTheGame: string;
  readonly developers: ReadonlyArray<string>;
  readonly publishers: ReadonlyArray<string>;
  readonly genres: ReadonlyArray<string>;
  readonly releaseDate: string | null;
  readonly metacriticScore: number | null;
  readonly metacriticUrl: string | null;
  readonly controllerSupport: "full" | "partial" | null;
  readonly linux: boolean;
  readonly achievementsTotal: number;
  readonly screenshots: ReadonlyArray<{
    readonly thumb: string;
    readonly full: string;
  }>;
  readonly movies: ReadonlyArray<{
    readonly name: string;
    readonly thumbnail: string;
    readonly hls: string;
    readonly highlight: boolean;
  }>;
};

export type StoreLookup =
  | { readonly _tag: "Found"; readonly details: StoreDetails }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unavailable" };

const AppData = Schema.Struct({
  short_description: Schema.optional(Schema.String),
  about_the_game: Schema.optional(Schema.String),
  developers: Schema.optional(Schema.Array(Schema.String)),
  publishers: Schema.optional(Schema.Array(Schema.String)),
  genres: Schema.optional(
    Schema.Array(Schema.Struct({ description: Schema.String })),
  ),
  release_date: Schema.optional(
    Schema.Struct({ date: Schema.optional(Schema.String) }),
  ),
  metacritic: Schema.optional(
    Schema.Struct({
      score: Schema.optional(Schema.Number),
      url: Schema.optional(Schema.String),
    }),
  ),
  controller_support: Schema.optional(Schema.String),
  platforms: Schema.optional(
    Schema.Struct({ linux: Schema.optional(Schema.Boolean) }),
  ),
  achievements: Schema.optional(
    Schema.Struct({ total: Schema.optional(Schema.Number) }),
  ),
  screenshots: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path_thumbnail: Schema.String,
        path_full: Schema.String,
      }),
    ),
  ),
  movies: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        thumbnail: Schema.optional(Schema.String),
        hls_h264: Schema.optional(Schema.String),
        highlight: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});

/** Ответ — объект с одним ключом `<appId>`: `{success, data?}`. */
const AppDetailsResponse = Schema.Record(
  Schema.String,
  Schema.Struct({
    success: Schema.Boolean,
    data: Schema.optional(AppData),
  }),
);

const toDetails = (data: typeof AppData.Type): StoreDetails => ({
  shortDescription: data.short_description ?? "",
  aboutTheGame: data.about_the_game ?? "",
  developers: data.developers ?? [],
  publishers: data.publishers ?? [],
  genres: (data.genres ?? []).map((genre) => genre.description),
  releaseDate: data.release_date?.date ?? null,
  metacriticScore: data.metacritic?.score ?? null,
  metacriticUrl: data.metacritic?.url ?? null,
  controllerSupport:
    data.controller_support === "full" || data.controller_support === "partial"
      ? data.controller_support
      : null,
  linux: data.platforms?.linux ?? false,
  achievementsTotal: data.achievements?.total ?? 0,
  screenshots: (data.screenshots ?? []).map((shot) => ({
    thumb: shot.path_thumbnail,
    full: shot.path_full,
  })),
  movies: (data.movies ?? []).flatMap((movie) =>
    movie.hls_h264 === undefined
      ? []
      : [
          {
            name: movie.name ?? "",
            thumbnail: movie.thumbnail ?? "",
            hls: movie.hls_h264,
            highlight: movie.highlight ?? false,
          },
        ],
  ),
});

export class SteamStoreApi extends Context.Service<
  SteamStoreApi,
  {
    readonly fetchDetails: (appId: number) => Effect.Effect<StoreLookup>;
  }
>()("@cg/api/SteamStoreApi") {
  static readonly layer: Layer.Layer<
    SteamStoreApi,
    never,
    HttpClient.HttpClient
  > = Layer.effect(
    SteamStoreApi,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const fetchDetails = (appId: number): Effect.Effect<StoreLookup> =>
        client
          .get("https://store.steampowered.com/api/appdetails", {
            urlParams: { appids: String(appId), l: "russian" },
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(AppDetailsResponse),
            ),
            Effect.map((body): StoreLookup => {
              const entry = body[String(appId)];
              if (entry === undefined) return { _tag: "Unavailable" };
              if (!entry.success || entry.data === undefined)
                return { _tag: "NotFound" };
              return { _tag: "Found", details: toDetails(entry.data) };
            }),
            Effect.catch(() =>
              Effect.succeed({ _tag: "Unavailable" } as const),
            ),
            Effect.timeoutOption("5 seconds"),
            Effect.map(
              Option.getOrElse((): StoreLookup => ({ _tag: "Unavailable" })),
            ),
          );

      return SteamStoreApi.of({ fetchDetails });
    }),
  );
}
