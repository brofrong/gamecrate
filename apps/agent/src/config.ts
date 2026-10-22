// Конфигурация агента воркера из окружения. Секреты — только Redacted.
import { Config, Context, Layer, Schema } from "effect";

/** Минимальная длина `AGENT_TOKEN` — та же, что проверяет оркестратор. */
export const agentTokenMinLength = 32;

/**
 * Абсолютный путь каталога хоста. Без `,` и `:`: пути попадают в опцию `o=`
 * overlay-тома (`lowerdir=…,upperdir=…`) и в bind `источник:цель`.
 */
const HostDir = (name: string) =>
  Config.schema(Schema.String.check(Schema.isPattern(/^\/[^,:\s]*$/)), name);

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
  /** Endpoint S3-совместимого хранилища профилей (RustFS), напр. `http://cg-rustfs:9000`. */
  s3Endpoint: Config.NonEmptyString("S3_ENDPOINT"),
  /** Бакет с зашифрованными профилями. */
  s3Bucket: Config.NonEmptyString("S3_BUCKET").pipe(
    Config.withDefault("cg-profiles"),
  ),
  /** Ключ доступа S3. */
  s3AccessKey: Config.Redacted("S3_ACCESS_KEY"),
  /** Секретный ключ S3. */
  s3SecretKey: Config.Redacted("S3_SECRET_KEY"),
  /**
   * Ключ шифрования профилей: base64 ровно 32 байт (AES-256-GCM, см.
   * `profile/codec.ts`). Видит только агент — никогда в логи/отчёты.
   */
  profileKey: Config.Redacted("PROFILE_KEY"),
  /** Общая библиотека игр на хосте (внутри — `steamapps/`): lower для `steamapps` сессий. */
  libraryDir: HostDir("LIBRARY_DIR"),
  /** Чистый клиент Steam на хосте: lower для `~/.local/share/Steam` сессий. */
  steamClientDir: HostDir("STEAM_CLIENT_DIR"),
  /** Scratch сессий: upper/work их overlay-слоёв, `<SCRATCH_DIR>/<sessionId>/…`. */
  scratchDir: HostDir("SCRATCH_DIR"),
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
