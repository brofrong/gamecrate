// Клиент Steam Web API: библиотека игр пользователя (`IPlayerService/GetOwnedGames`),
// схема достижений игры и достижения игрока (`ISteamUserStats`, спека 2026-10-27 §4.2).
import { SteamUnavailable } from "@cg/rpc";
import { Context, Duration, Effect, Layer, Option, Schema } from "effect";
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
const schemaForGameUrl =
  "https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/";
const playerAchievementsUrl =
  "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/";

const SchemaForGameResponse = Schema.Struct({
  game: Schema.optional(
    Schema.Struct({
      availableGameStats: Schema.optional(
        Schema.Struct({
          achievements: Schema.optional(
            Schema.Array(
              Schema.Struct({
                name: Schema.String,
                displayName: Schema.optional(Schema.String),
                description: Schema.optional(Schema.String),
                icon: Schema.optional(Schema.String),
                icongray: Schema.optional(Schema.String),
                hidden: Schema.optional(Schema.Number),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
});

const PlayerAchievementsResponse = Schema.Struct({
  playerstats: Schema.Struct({
    success: Schema.optional(Schema.Boolean),
    error: Schema.optional(Schema.String),
    achievements: Schema.optional(
      Schema.Array(
        Schema.Struct({
          apiname: Schema.String,
          achieved: Schema.Number,
          unlocktime: Schema.optional(Schema.Number),
        }),
      ),
    ),
  }),
});

/** Достижение из схемы игры (`GetSchemaForGame`). */
export type AchievementSchemaEntry = {
  readonly apiName: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly iconGray: string;
  readonly hidden: boolean;
};

/**
 * Достижения игрока: `Private` — профиль закрыт («Profile is not public»),
 * `None` — у игры нет статистики, Steam недоступен или ответ не разобрался.
 */
export type PlayerAchievements =
  | { readonly _tag: "Private" }
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Ready";
      readonly unlocked: ReadonlyArray<{
        readonly apiName: string;
        readonly unlockedAt: string;
      }>;
    };

/** Предел ожидания Steam (запрос + тело): `library.list` ждёт первую синхронизацию. */
const requestTimeout = Duration.seconds(10);

export class SteamApi extends Context.Service<
  SteamApi,
  {
    readonly getOwnedGames: (
      steamId: string,
    ) => Effect.Effect<OwnedGames, SteamUnavailable>;
    /** Схема достижений игры; `null` — нет данных, сеть или таймаут (5 с). */
    readonly getAchievementSchema: (
      appId: number,
    ) => Effect.Effect<ReadonlyArray<AchievementSchemaEntry> | null>;
    /** Открытые игроком достижения; никогда не падает (см. `PlayerAchievements`). */
    readonly getPlayerAchievements: (
      steamId: string,
      appId: number,
    ) => Effect.Effect<PlayerAchievements>;
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

      const getAchievementSchema = (appId: number) =>
        client
          .get(schemaForGameUrl, {
            urlParams: {
              key: config.steamApiKey,
              appid: String(appId),
              l: "russian",
            },
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(SchemaForGameResponse),
            ),
            Effect.map((body) => {
              const list = body.game?.availableGameStats?.achievements;
              if (list === undefined) return null;
              return list.map((entry): AchievementSchemaEntry => ({
                apiName: entry.name,
                name: entry.displayName ?? entry.name,
                description: entry.description ?? "",
                icon: entry.icon ?? "",
                iconGray: entry.icongray ?? "",
                hidden: entry.hidden === 1,
              }));
            }),
            Effect.catch(() => Effect.succeed(null)),
            Effect.timeoutOption("5 seconds"),
            Effect.map(Option.getOrElse(() => null)),
          );

      // Steam отвечает 400/403 с телом `{playerstats: {success: false, error}}` —
      // статус не фильтруем, читаем тело.
      const getPlayerAchievements = (steamId: string, appId: number) =>
        client
          .get(playerAchievementsUrl, {
            urlParams: {
              key: config.steamApiKey,
              steamid: steamId,
              appid: String(appId),
              l: "russian",
            },
          })
          .pipe(
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(PlayerAchievementsResponse),
            ),
            Effect.map(({ playerstats }): PlayerAchievements => {
              if (playerstats.error === "Profile is not public")
                return { _tag: "Private" };
              if (
                playerstats.success !== true ||
                playerstats.achievements === undefined
              )
                return { _tag: "None" };
              return {
                _tag: "Ready",
                unlocked: playerstats.achievements
                  .filter((entry) => entry.achieved === 1)
                  .map((entry) => ({
                    apiName: entry.apiname,
                    unlockedAt: new Date(
                      (entry.unlocktime ?? 0) * 1000,
                    ).toISOString(),
                  })),
              };
            }),
            Effect.catch(() =>
              Effect.succeed({ _tag: "None" } as PlayerAchievements),
            ),
            Effect.timeoutOption("5 seconds"),
            Effect.map(
              Option.getOrElse((): PlayerAchievements => ({ _tag: "None" })),
            ),
          );

      return SteamApi.of({
        getOwnedGames,
        getAchievementSchema,
        getPlayerAchievements,
      });
    }),
  );
}
