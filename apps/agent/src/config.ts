// Конфигурация агента воркера из окружения. Секреты — только Redacted.
import { Config, Context, Layer, Schema } from "effect";

/** Минимальная длина `AGENT_TOKEN` — та же, что проверяет оркестратор. */
export const agentTokenMinLength = 32;

/** Описание переменных окружения агента. */
export const agentConfig = Config.all({
  /** Имя воркера (`workers.id` в БД оркестратора). */
  workerId: Config.NonEmptyString("WORKER_ID"),
  /** Полный адрес WebSocket оркестратора, напр. `ws://cg-orchestrator:3001/agent`. */
  orchestratorUrl: Config.schema(
    Schema.String.check(Schema.isPattern(/^wss?:\/\/\S+$/)),
    "ORCHESTRATOR_URL",
  ),
  /** Общий секрет агентов: `Authorization: Bearer <AGENT_TOKEN>`. */
  agentToken: Config.schema(
    Schema.Redacted(
      Schema.String.check(Schema.isMinLength(agentTokenMinLength)),
    ),
    "AGENT_TOKEN",
  ),
  /** Публичный IP воркера: кандидат WebRTC (`SELKIES_WEBRTC_PUBLIC_IP`). */
  publicIp: Config.NonEmptyString("WORKER_PUBLIC_IP"),
  /** Число слотов (один слот — одна GPU целиком). */
  slots: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
    "SLOTS",
  ).pipe(Config.withDefault(1)),
  /** Слот `i` — UDP-порт `udpPortBase + i`. */
  udpPortBase: Config.Port("UDP_PORT_BASE").pipe(Config.withDefault(59000)),
  /** Образ сессии, напр. `cg-session:550.163.01`. */
  sessionImage: Config.NonEmptyString("SESSION_IMAGE"),
  /** Docker-сеть контейнеров сессий. */
  sessionNetwork: Config.NonEmptyString("SESSION_NETWORK").pipe(
    Config.withDefault("cg-sessions"),
  ),
  /**
   * Путь к `libnvidia-allocator.so.<ver>` на хосте (Debian:
   * `/usr/lib/x86_64-linux-gnu/nvidia/current/…`); задан — пробрасывается в
   * контейнер как GBM-бэкенд NVIDIA.
   */
  gbmAllocatorPath: Config.option(Config.NonEmptyString("GBM_ALLOCATOR_PATH")),
  /** Unix-сокет Docker Engine API. */
  dockerSocket: Config.NonEmptyString("DOCKER_SOCKET").pipe(
    Config.withDefault("/var/run/docker.sock"),
  ),
});

export type AgentConfigValues = Config.Success<typeof agentConfig>;

/** Сервис с прочитанной конфигурацией. */
export class AgentConfig extends Context.Service<
  AgentConfig,
  AgentConfigValues
>()("@cg/agent/AgentConfig") {
  static readonly layer: Layer.Layer<AgentConfig, Config.ConfigError> =
    Layer.effect(AgentConfig, agentConfig);
}
