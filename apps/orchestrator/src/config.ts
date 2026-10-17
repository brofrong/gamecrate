// Конфигурация оркестратора из окружения (`.env`). Секреты — только Redacted.
import { Config, Context, Layer } from "effect";

/** Описание переменных окружения оркестратора. */
export const orchestratorConfig = Config.all({
  port: Config.Port("ORCHESTRATOR_PORT").pipe(Config.withDefault(3001)),
  databaseUrl: Config.Redacted("DATABASE_URL"),
  /** Общий секрет агентов: `Authorization: Bearer <AGENT_TOKEN>` на `GET /agent`. */
  agentToken: Config.Redacted("AGENT_TOKEN"),
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
