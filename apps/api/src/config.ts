// Конфигурация сервера из окружения (`.env`). Секреты — только Redacted.
import { fileURLToPath } from "node:url";
import { normalizeHost, parseBrandHosts } from "@cg/brands";
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";

/** Адрес с явной схемой `http://` или `https://` и хостом (как в apps/orchestrator/src/config.ts). */
const httpUrlPattern = /^https?:\/\/[^\s/?#]+/;

/**
 * Пара переменных окружения, которые должны быть заданы вместе (id/secret
 * OAuth-провайдера): `None`, если обе не заданы —
 * пустая строка (`${VAR:-}` в docker compose) и отсутствие переменной для
 * `ConfigProvider.fromEnv`/`fromUnknown` равнозначны, обе уже трактуются как
 * «нет значения» — и `ConfigError`, если задана только одна.
 */
const pairOrNone = <A, B>(
  a: Config.Config<A>,
  b: Config.Config<B>,
  label: string,
): Config.Config<Option.Option<readonly [A, B]>> =>
  Config.all([Config.option(a), Config.option(b)]).pipe(
    Config.mapEffect(([optA, optB]) => {
      if (Option.isSome(optA) && Option.isSome(optB))
        return Effect.succeed(Option.some([optA.value, optB.value] as const));
      if (Option.isNone(optA) && Option.isNone(optB))
        return Effect.succeed(Option.none());
      return Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `${label}: переменные должны быть заданы вместе или не заданы вовсе`,
          }),
        ),
      );
    }),
  );

const configError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

/**
 * Хосты, на которых провайдер входа принимает возврат (`OAUTH_HOSTS_*`, через запятую, без порта):
 * не задано или пустая строка — только хост `PUBLIC_URL`. Нормализуются (нижний регистр).
 */
const oauthHostsOf = (name: string): Config.Config<ReadonlySet<string>> =>
  Config.all([
    Config.String("PUBLIC_URL"),
    Config.option(Config.String(name)),
  ]).pipe(
    Config.mapEffect(([publicUrl, raw]) => {
      if (Option.isSome(raw))
        return Effect.succeed(
          new Set(
            raw.value
              .split(",")
              .map(normalizeHost)
              .filter((host) => host.length > 0),
          ),
        );
      return Effect.try({
        try: () => new Set([normalizeHost(new URL(publicUrl).host)]),
        catch: () =>
          configError("PUBLIC_URL: нужен адрес http(s)://host[:port]"),
      });
    }),
  );

/** Описание переменных окружения сервера. */
export const appConfig = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(3000)),
  /** Публичный адрес приложения, он же `baseURL` Better Auth. */
  publicUrl: Config.String("PUBLIC_URL"),
  databaseUrl: Config.Redacted("DATABASE_URL"),
  steamApiKey: Config.Redacted("STEAM_API_KEY"),
  authSecret: Config.Redacted("BETTER_AUTH_SECRET"),
  pocketIdUrl: Config.String("POCKET_ID_URL"),
  pocketIdClientId: Config.String("POCKET_ID_CLIENT_ID"),
  pocketIdClientSecret: Config.Redacted("POCKET_ID_CLIENT_SECRET"),
  /** Группа Pocket ID, члены которой получают роль admin. */
  pocketIdAdminGroup: Config.String("POCKET_ID_ADMIN_GROUP"),
  /**
   * Дополнительные Origin для WebSocket `/rpc`, через запятую (dev: `http://localhost:5173`).
   * Origin `PUBLIC_URL` разрешён всегда; без переменной — только он.
   */
  allowedOrigins: Config.String("ALLOWED_ORIGINS").pipe(
    Config.map((value) =>
      value
        .split(",")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter((origin) => origin.length > 0),
    ),
    Config.withDefault<ReadonlyArray<string>>([]),
  ),
  /**
   * Витрины партнёров: `host=бренд` через запятую (`play.beeline.ru=beeline`).
   * Хосты вне списка — основной бренд. Не задано или пустая строка — пустая карта;
   * неизвестный бренд или пара без `=` — ConfigError при старте.
   */
  brandHosts: Config.String("BRAND_HOSTS").pipe(
    Config.withDefault(""),
    Config.mapEffect((value) =>
      Effect.try({
        try: () => parseBrandHosts(value),
        catch: (cause) =>
          configError(
            `BRAND_HOSTS: нужен список host=бренд (${cause instanceof Error ? cause.message : String(cause)})`,
          ),
      }),
    ),
  ),
  /**
   * Хосты, на которых доступен вход через провайдера
   * (`OAUTH_HOSTS_GOOGLE/YANDEX/POCKET_ID/TELEGRAM`, через запятую): redirect URI
   * провайдера зарегистрирован только для них. По умолчанию — хост `PUBLIC_URL`.
   */
  oauthHosts: Config.all({
    google: oauthHostsOf("OAUTH_HOSTS_GOOGLE"),
    yandex: oauthHostsOf("OAUTH_HOSTS_YANDEX"),
    pocketId: oauthHostsOf("OAUTH_HOSTS_POCKET_ID"),
    telegram: oauthHostsOf("OAUTH_HOSTS_TELEGRAM"),
  }),
  /**
   * Адрес relay оркестратора (спека §4): прокси стрима (`/stream/<id>/…`,
   * `session/streamProxy.ts`) ходит сюда (`<orchestratorRelayUrl>/relay/<id>/…`),
   * а не в сеть `cg-sessions` напрямую — многосерверный деплой разносит api и
   * сессии по разным хостам. Без схемы `http(s)://` — ConfigError при старте;
   * завершающий `/` обрезается, иначе в пути апстрима вышел бы двойной слэш.
   */
  orchestratorRelayUrl: Config.String("ORCHESTRATOR_RELAY_URL").pipe(
    Config.withDefault("http://cg-orchestrator:3002"),
    Config.map((value) => value.replace(/\/+$/, "")),
    Config.mapEffect((value) =>
      httpUrlPattern.test(value)
        ? Effect.succeed(value)
        : Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message:
                  "ORCHESTRATOR_RELAY_URL: нужен адрес http(s)://host[:port]",
              }),
            ),
          ),
    ),
  ),
  /**
   * Общий секрет с relay оркестратора (`RELAY_SECRET`, не короче 32
   * символов, тот же, что у оркестратора): прокси стрима ставит его в
   * заголовок `x-cg-relay-secret` каждого запроса и открытия WebSocket к
   * relay, без него relay отвечает 403. Нет или короче — ConfigError без
   * значения.
   */
  relaySecret: Config.schema(
    Schema.Redacted(Schema.String.check(Schema.isMinLength(32))),
    "RELAY_SECRET",
  ),
  /** Папка собранной SPA (`apps/web/dist`). */
  webDistDir: Config.String("WEB_DIST_DIR"),
  /**
   * Каталог своих игр репозитория (`games/<slug>/game.json`, «Свои игры»);
   * по умолчанию — `games/` в корне репозитория (в образе — `/app/games`).
   */
  ownGamesDir: Config.String("OWN_GAMES_DIR").pipe(
    Config.withDefault(
      fileURLToPath(new URL("../../../games", import.meta.url)),
    ),
  ),
  /** SMTP для отправки писем (коды входа и т.п.); `log://` — см. `mail/Mailer.ts`. */
  smtpUrl: Config.Redacted("SMTP_URL"),
  /** Заголовок `From` писем, например `GameCrate <no-reply@brofrong.ru>`. */
  mailFrom: Config.String("MAIL_FROM"),
  /** OAuth-вход через Google: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. */
  google: pairOrNone(
    Config.String("GOOGLE_CLIENT_ID"),
    Config.Redacted("GOOGLE_CLIENT_SECRET"),
    "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET",
  ).pipe(
    Config.map(
      Option.map(([clientId, clientSecret]) => ({
        clientId,
        clientSecret,
      })),
    ),
  ),
  /** OAuth-вход через Яндекс: `YANDEX_CLIENT_ID`/`YANDEX_CLIENT_SECRET`. */
  yandex: pairOrNone(
    Config.String("YANDEX_CLIENT_ID"),
    Config.Redacted("YANDEX_CLIENT_SECRET"),
    "YANDEX_CLIENT_ID/YANDEX_CLIENT_SECRET",
  ).pipe(
    Config.map(
      Option.map(([clientId, clientSecret]) => ({
        clientId,
        clientSecret,
      })),
    ),
  ),
  /** OIDC-вход через Telegram: `TELEGRAM_CLIENT_ID`/`TELEGRAM_CLIENT_SECRET` (BotFather → Login Widget). */
  telegram: pairOrNone(
    Config.String("TELEGRAM_CLIENT_ID"),
    Config.Redacted("TELEGRAM_CLIENT_SECRET"),
    "TELEGRAM_CLIENT_ID/TELEGRAM_CLIENT_SECRET",
  ).pipe(
    Config.map(
      Option.map(([clientId, clientSecret]) => ({
        clientId,
        clientSecret,
      })),
    ),
  ),
});

/**
 * Раздача десктоп-сборок (`download/`): бакет `cg-desktop` в `cg-rustfs`, доступ только на чтение.
 * Отдельно от `appConfig`: переменные необязательные — на деплое без ключей API стартует как
 * раньше, а `/download/desktop/*` отвечает 404 (`DesktopReleases.disabled`). Ключи — парой:
 * `Some` только если заданы оба, одиночный ключ — ConfigError (как у OAuth-провайдеров).
 */
export const desktopConfig = Config.all({
  endpoint: Config.String("DESKTOP_S3_ENDPOINT").pipe(
    Config.withDefault("http://cg-rustfs:9000"),
  ),
  bucket: Config.String("DESKTOP_S3_BUCKET").pipe(
    Config.withDefault("cg-desktop"),
  ),
  credentials: pairOrNone(
    Config.Redacted("DESKTOP_S3_ACCESS_KEY"),
    Config.Redacted("DESKTOP_S3_SECRET_KEY"),
    "DESKTOP_S3_ACCESS_KEY/DESKTOP_S3_SECRET_KEY",
  ).pipe(
    Config.map(
      Option.map(([accessKey, secretKey]) => ({ accessKey, secretKey })),
    ),
  ),
});

export type AppConfigValues = Config.Success<typeof appConfig>;

/** Сервис с прочитанной конфигурацией. */
export class AppConfig extends Context.Service<AppConfig, AppConfigValues>()(
  "@cg/api/AppConfig",
) {
  static readonly layer: Layer.Layer<AppConfig, Config.ConfigError> =
    Layer.effect(AppConfig, appConfig);
}

/** Хост `PUBLIC_URL` и все хосты `BRAND_HOSTS` (без порта, в нижнем регистре, без повторов). */
export const appHosts = (config: AppConfigValues): ReadonlyArray<string> => [
  ...new Set([
    normalizeHost(new URL(config.publicUrl).host),
    ...config.brandHosts.keys(),
  ]),
];

/**
 * Origin, которым разрешены WebSocket `/rpc` и прокси стрима (WS-апгрейд и
 * небезопасные методы), а также `trustedOrigins` Better Auth: origin `PUBLIC_URL`,
 * `ALLOWED_ORIGINS` и домены витрин `BRAND_HOSTS` (со схемой `PUBLIC_URL`).
 */
export const rpcAllowedOrigins = (
  config: AppConfigValues,
): ReadonlySet<string> => {
  const { protocol, origin } = new URL(config.publicUrl);
  return new Set([
    origin,
    ...config.allowedOrigins,
    ...[...config.brandHosts.keys()].map((host) => `${protocol}//${host}`),
  ]);
};
