// Конфигурация оркестратора из окружения (`.env`). Секреты — только Redacted.
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  type Redacted,
  Schema,
} from "effect";

/**
 * base64 ровно 32 байт (AES-256): 43 символа и один `=` — после декодирования
 * всегда 32 байта (та же проверка, что `base64_32` в `deploy/deploy.sh`).
 */
const base64Key32Pattern = /^[A-Za-z0-9+/]{43}=$/;

/** Ключ AES-256 из переменной `name`: нет или не тот формат — ConfigError без значения. */
const base64Key32 = (name: string) =>
  Config.schema(
    Schema.Redacted(Schema.String.check(Schema.isPattern(base64Key32Pattern))),
    name,
  );

/** Адрес с явной схемой `http://` или `https://` и хостом. */
const httpUrlPattern = /^https?:\/\/[^\s/?#]+/;

/** Учётные данные реестра образов (только на чтение), которые получают агенты. */
export interface RegistryCredentials {
  readonly server: string;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
}

/**
 * Три переменные реестра, которые задаются все вместе (по образцу `pairOrNone`
 * в `apps/api/src/config.ts`): `None`, если не задана ни одна (пустая строка
 * `${VAR:-}` в docker compose и отсутствие переменной равнозначны), и
 * `ConfigError`, если задана только часть.
 */
const registryOrNone: Config.Config<Option.Option<RegistryCredentials>> =
  Config.all([
    Config.option(Config.String("REGISTRY_SERVER")),
    Config.option(Config.String("REGISTRY_USERNAME")),
    Config.option(Config.Redacted("REGISTRY_PASSWORD")),
  ]).pipe(
    Config.mapEffect(([server, username, password]) => {
      if (
        Option.isSome(server) &&
        Option.isSome(username) &&
        Option.isSome(password)
      )
        return Effect.succeed(
          Option.some({
            server: server.value,
            username: username.value,
            password: password.value,
          }),
        );
      if (
        Option.isNone(server) &&
        Option.isNone(username) &&
        Option.isNone(password)
      )
        return Effect.succeed(Option.none());
      return Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message:
              "REGISTRY_SERVER/REGISTRY_USERNAME/REGISTRY_PASSWORD: переменные должны быть заданы вместе или не заданы вовсе",
          }),
        ),
      );
    }),
  );

/** Описание переменных окружения оркестратора. */
export const orchestratorConfig = Config.all({
  port: Config.Port("ORCHESTRATOR_PORT").pipe(Config.withDefault(3001)),
  databaseUrl: Config.Redacted("DATABASE_URL"),
  /**
   * Публичный адрес главного сервера (`https://game.example.ru`): отсюда
   * `orchestratorUrl` агента в ответе обмена кода (`wss://…/agent`, см.
   * `agentWebsocketUrl`). Без схемы `http(s)://` — ConfigError при старте.
   */
  publicUrl: Config.schema(
    Schema.String.check(Schema.isPattern(httpUrlPattern)),
    "ORCHESTRATOR_PUBLIC_URL",
  ),
  /** Внутренний порт тоннеля стрима для api (`/relay/<sessionId>/…`, спека §4); наружу не публикуется. */
  relayPort: Config.Port("RELAY_PORT").pipe(Config.withDefault(3002)),
  /**
   * Хранилище профилей, как его видят игровые серверы (`/agent/config`):
   * публичный адрес S3 главного (`S3_PUBLIC_ENDPOINT`), бакет и ключи.
   */
  s3PublicEndpoint: Config.String("S3_PUBLIC_ENDPOINT"),
  s3Bucket: Config.String("S3_BUCKET").pipe(Config.withDefault("cg-profiles")),
  s3AccessKey: Config.Redacted("S3_ACCESS_KEY"),
  s3SecretKey: Config.Redacted("S3_SECRET_KEY"),
  /**
   * Ключ шифрования профилей (`PROFILE_KEY`), который агенты получают через
   * `/agent/config`: base64 ровно 32 байт, как `SEED_KEY`. Нет или не тот
   * формат — ConfigError при старте; значение в ошибку не попадает.
   */
  profileKey: base64Key32("PROFILE_KEY"),
  /** Версия релиза (тег образов): агент после обмена кода ставит эту же. */
  cgVersion: Config.String("CG_VERSION").pipe(Config.withDefault("dev")),
  /** Реестр образов для агентов: все три `REGISTRY_*` или ни одной (тогда `None`). */
  registry: registryOrNone,
  /**
   * Ключ шифрования посеянных входов Steam в БД (`steam_login_seeds`,
   * AES-256-GCM): base64 ровно 32 байт (`openssl rand -base64 32`). Нет или не
   * тот формат — ConfigError при старте; значение в ошибку не попадает.
   */
  seedKey: base64Key32("SEED_KEY"),
});

export type OrchestratorConfigValues = Config.Success<
  typeof orchestratorConfig
>;

/**
 * Адрес WebSocket агентов по публичному адресу главного: схема `http` →
 * `ws`, `https` → `wss`, плюс `/agent` (`https://g.example` →
 * `wss://g.example/agent`); хвостовые `/` публичного адреса отбрасываются.
 */
export const agentWebsocketUrl = (publicUrl: string): string =>
  `${publicUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/agent`;

/** Сервис с прочитанной конфигурацией. */
export class OrchestratorConfig extends Context.Service<
  OrchestratorConfig,
  OrchestratorConfigValues
>()("@cg/orchestrator/OrchestratorConfig") {
  static readonly layer: Layer.Layer<OrchestratorConfig, Config.ConfigError> =
    Layer.effect(OrchestratorConfig, orchestratorConfig);
}
