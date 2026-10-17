// Клиент Steam Web API: библиотека игр пользователя (`IPlayerService/GetOwnedGames`).
import { SteamUnavailable } from "@cg/rpc";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AppConfig } from "../config";

const GetOwnedGamesResponse = Schema.Struct({
  response: Schema.Struct({
    game_count: Schema.optional(Schema.Int),
    games: Schema.optional(
      Schema.Array(
        Schema.Struct({
          appid: Schema.Int,
          // Steam иногда отдаёт запись без имени/времени: одна такая игра не должна
          // ломать декодирование всей библиотеки (см. фолбэки в `getOwnedGames`).
          name: Schema.optional(Schema.String),
          playtime_forever: Schema.optional(Schema.Int),
        }),
      ),
    ),
  }),
});

/** Библиотека игр пользователя Steam. `Private` — профиль не открыл «Сведения об играх». */
export type OwnedGames =
  | { readonly _tag: "Private" }
  | {
      readonly _tag: "Games";
      readonly games: ReadonlyArray<{
        readonly appId: number;
        readonly name: string;
        readonly playtimeMinutes: number;
      }>;
    };

const ownedGamesUrl =
  "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";

/** Предел ожидания Steam (запрос + тело): `library.list` ждёт первую синхронизацию. */
const requestTimeout = Duration.seconds(10);

export class SteamApi extends Context.Service<
  SteamApi,
  {
    readonly getOwnedGames: (
      steamId: string,
    ) => Effect.Effect<OwnedGames, SteamUnavailable>;
  }
>()("@cg/api/SteamApi") {
  static readonly layer: Layer.Layer<
    SteamApi,
    never,
    HttpClient.HttpClient | AppConfig
  > = Layer.effect(
    SteamApi,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const config = yield* AppConfig;

      const getOwnedGames = (steamId: string) =>
        Effect.gen(function* () {
          const response = yield* client
            .get(ownedGamesUrl, {
              urlParams: {
                // Redacted: ключ не попадает в сообщения ошибок и трассировку.
                key: config.steamApiKey,
                steamid: steamId,
                include_appinfo: "1",
                include_played_free_games: "1",
                format: "json",
              },
            })
            .pipe(
              Effect.mapError(
                () => new SteamUnavailable({ reason: "unavailable" }),
              ),
            );

          if (response.status === 403)
            return yield* Effect.fail(
              new SteamUnavailable({ reason: "unauthorized" }),
            );
          if (response.status === 429)
            return yield* Effect.fail(
              new SteamUnavailable({ reason: "rate_limited" }),
            );
          if (response.status < 200 || response.status >= 300)
            return yield* Effect.fail(
              new SteamUnavailable({ reason: "unavailable" }),
            );

          const body = yield* HttpClientResponse.schemaBodyJson(
            GetOwnedGamesResponse,
          )(response).pipe(
            Effect.mapError(
              () => new SteamUnavailable({ reason: "unavailable" }),
            ),
          );

          // Закрытый профиль — пустой `response`; `{game_count: 0}` — просто нет игр.
          if (
            body.response.games === undefined &&
            body.response.game_count === undefined
          )
            return { _tag: "Private" } as const;

          return {
            _tag: "Games",
            games: (body.response.games ?? []).map((game) => ({
              appId: game.appid,
              // games.name в БД NOT NULL и непустое.
              name: game.name || `App ${game.appid}`,
              playtimeMinutes: game.playtime_forever ?? 0,
            })),
          } as const;
        }).pipe(
          Effect.timeoutOrElse({
            duration: requestTimeout,
            orElse: () =>
              Effect.fail(new SteamUnavailable({ reason: "unavailable" })),
          }),
        );

      return SteamApi.of({ getOwnedGames });
    }),
  );
}
