// Конфигурация сервера из окружения (`.env`). Секреты — только Redacted.
import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect";

/**
 * Пара переменных окружения, которые должны быть заданы вместе (id/secret
 * OAuth-провайдера, токен/имя бота Telegram): `None`, если обе не заданы —
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
  /** Папка собранной SPA (`apps/web/dist`). */
  webDistDir: Config.String("WEB_DIST_DIR"),
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
  /** Вход через Telegram: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_USERNAME`. */
  telegram: pairOrNone(
    Config.Redacted("TELEGRAM_BOT_TOKEN"),
    Config.String("TELEGRAM_BOT_USERNAME"),
    "TELEGRAM_BOT_TOKEN/TELEGRAM_BOT_USERNAME",
  ).pipe(
    Config.map(
      Option.map(([botToken, botUsername]) => ({
        botToken,
        botUsername,
      })),
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

/**
 * Origin, которым разрешены WebSocket `/rpc` и прокси стрима (WS-апгрейд и
 * небезопасные методы): origin `PUBLIC_URL` + `ALLOWED_ORIGINS`.
 */
export const rpcAllowedOrigins = (
  config: AppConfigValues,
): ReadonlySet<string> =>
  new Set([new URL(config.publicUrl).origin, ...config.allowedOrigins]);
