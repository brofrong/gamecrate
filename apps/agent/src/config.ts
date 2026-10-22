// Конфигурация агента воркера из окружения. Секреты — только Redacted.
import { relative } from "node:path";
import type { AgentRoles } from "@cg/rpc";
import { Config, Context, Layer, Option, Schema, SchemaIssue } from "effect";

/** Минимальная длина `AGENT_TOKEN` — та же, что проверяет оркестратор. */
export const agentTokenMinLength = 32;

/**
 * Абсолютный путь каталога хоста. Без `,` и `:`: пути попадают в опцию `o=`
 * overlay-тома (`lowerdir=…,upperdir=…`) и в bind `источник:цель`.
 */
const HostDir = (name: string) =>
  Config.schema(Schema.String.check(Schema.isPattern(/^\/[^,:\s]*$/)), name);

const configError = (message: string) =>
  Config.fail(
    new Schema.SchemaError(new SchemaIssue.InvalidValue({ message })),
  );

type Role = AgentRoles[number];
const isRole = (name: string): name is Role =>
  name === "worker" || name === "gamestore";

/** `ROLES`: роли через запятую (пробелы вокруг и повторы не важны). */
const roles = Config.String("ROLES").pipe(
  Config.withDefault("worker"),
  Config.flatMap((text) => {
    const names = [
      ...new Set(
        text
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      ),
    ];
    const unknown = names.filter((name) => !isRole(name));
    if (unknown.length > 0)
      return configError(`ROLES: unknown role(s) ${unknown.join(", ")}`);
    const valid = names.filter(isRole);
    if (valid.length === 0) return configError("ROLES: no roles given");
    return Config.succeed<AgentRoles>(valid);
  }),
);

/** `a` и `b` — один каталог или один внутри другого. */
const overlapping = (a: string, b: string) => {
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || !(path === ".." || path.startsWith("../"));
  };
  return inside(a, b) || inside(b, a);
};

/** Описание переменных окружения агента. */
const fields = Config.all({
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
  /** `worker` — сессии, `gamestore` — установка игр в общую библиотеку. */
  roles,
  /**
   * Scratch установок (роль `gamestore`): `<INSTALL_SCRATCH_DIR>/<jobId>/…`. Та
   * же ФС, что `LIBRARY_DIR`: готовая игра переносится в библиотеку `rename`.
   */
  installScratchDir: Config.option(HostDir("INSTALL_SCRATCH_DIR")),
  /**
   * Минимум свободного места (ГиБ) на ФС `SCRATCH_DIR`/`INSTALL_SCRATCH_DIR`:
   * меньше — `StartSession`/`InstallGame` отклоняются («На сервере закончилось
   * место»), чтобы upper-слои не заполнили общий диск хоста.
   */
  minFreeGb: Config.schema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    "MIN_FREE_GB",
  ).pipe(Config.withDefault(20)),
});

/** Первая пара из `pairs`, где каталоги совпадают или вложены один в другой. */
const firstOverlap = (
  pairs: ReadonlyArray<readonly [string, string, string, string]>,
) => pairs.find(([, a, , b]) => overlapping(a, b));

/**
 * Каталоги scratch агент при старте чистит от «чужих» подкаталогов (`rm -rf`
 * от root), поэтому `SCRATCH_DIR` и `INSTALL_SCRATCH_DIR` не должны совпадать
 * или быть вложены (в любую сторону) ни друг с другом, ни с `LIBRARY_DIR` и
 * `STEAM_CLIENT_DIR` — иначе уборка удалит библиотеку или клиент Steam. Роль
 * `gamestore` требует `INSTALL_SCRATCH_DIR` (`LIBRARY_DIR` обязателен всегда).
 */
export const agentConfig = fields.pipe(
  Config.flatMap((values) => {
    const scratch = ["SCRATCH_DIR", values.scratchDir] as const;
    const shared = [
      ["LIBRARY_DIR", values.libraryDir],
      ["STEAM_CLIENT_DIR", values.steamClientDir],
    ] as const;
    const pairs: Array<readonly [string, string, string, string]> = shared.map(
      ([name, dir]) => [...scratch, name, dir] as const,
    );
    if (values.roles.includes("gamestore")) {
      if (Option.isNone(values.installScratchDir))
        return configError(
          "INSTALL_SCRATCH_DIR is required for role gamestore",
        );
      const install = [
        "INSTALL_SCRATCH_DIR",
        values.installScratchDir.value,
      ] as const;
      pairs.push(
        [...install, ...scratch],
        ...shared.map(([name, dir]) => [...install, name, dir] as const),
      );
    }
    const overlap = firstOverlap(pairs);
    if (overlap !== undefined)
      return configError(
        `${overlap[0]} must not be ${overlap[2]} or nested with it`,
      );
    return Config.succeed(values);
  }),
);

export type AgentConfigValues = Config.Success<typeof agentConfig>;

/** Сервис с прочитанной конфигурацией. */
export class AgentConfig extends Context.Service<
  AgentConfig,
  AgentConfigValues
>()("@cg/agent/AgentConfig") {
  static readonly layer: Layer.Layer<AgentConfig, Config.ConfigError> =
    Layer.effect(AgentConfig, agentConfig);
}
