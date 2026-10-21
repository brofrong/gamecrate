// Конфигурация сервера из окружения (`.env`). Секреты — только Redacted.
import { Config, Context, Layer } from "effect";

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
