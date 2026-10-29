// Конфигурация оркестратора из окружения (`.env`). Секреты — только Redacted.
import { Config, Context, Layer, Schema } from "effect";

/** Минимальная длина `AGENT_TOKEN` (32 символа, напр. `openssl rand -hex 32` — 64). */
export const agentTokenMinLength = 32;

/**
 * base64 ровно 32 байт (AES-256): 43 символа и один `=` — после декодирования
 * всегда 32 байта (та же проверка, что `base64_32` в `deploy/deploy.sh`).
 */
const seedKeyPattern = /^[A-Za-z0-9+/]{43}=$/;

/** Описание переменных окружения оркестратора. */
export const orchestratorConfig = Config.all({
  port: Config.Port("ORCHESTRATOR_PORT").pipe(Config.withDefault(3001)),
  databaseUrl: Config.Redacted("DATABASE_URL"),
  /**
   * Общий секрет агентов: `Authorization: Bearer <AGENT_TOKEN>` на `GET /agent`.
   * Короче `agentTokenMinLength` (или пустой) — ConfigError при старте; значение
   * в ошибку не попадает.
   */
  agentToken: Config.schema(
    Schema.Redacted(
      Schema.String.check(Schema.isMinLength(agentTokenMinLength)),
    ),
    "AGENT_TOKEN",
  ),
  /**
   * Ключ шифрования посеянных входов Steam в БД (`steam_login_seeds`,
   * AES-256-GCM): base64 ровно 32 байт (`openssl rand -base64 32`). Нет или не
   * тот формат — ConfigError при старте; значение в ошибку не попадает.
   */
  seedKey: Config.schema(
    Schema.Redacted(Schema.String.check(Schema.isPattern(seedKeyPattern))),
    "SEED_KEY",
  ),
});

export type OrchestratorConfigValues = Config.Success<
  typeof orchestratorConfig
>;

/** Сервис с прочитанной конфигурацией. */
export class OrchestratorConfig extends Context.Service<
  OrchestratorConfig,
  OrchestratorConfigValues
>()("@cg/orchestrator/OrchestratorConfig") {
  static readonly layer: Layer.Layer<OrchestratorConfig, Config.ConfigError> =
    Layer.effect(OrchestratorConfig, orchestratorConfig);
}
