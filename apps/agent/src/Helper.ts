// Контейнеры-помощники: одноразовые контейнеры образа сессии без GPU и сети
// (удаление scratch от root, упаковка профиля из старого тома дома). Метка
// `cg.helper=<вид>`; забытые помощники агент убирает при старте.
import { Effect } from "effect";
import type { AgentConfigValues } from "./config";
import { type ContainerSpec, DockerClient, DockerError } from "./DockerClient";

export const HELPER_LABEL = "cg.helper";
const HELPER_SHM_BYTES = 64 * 1024 * 1024;

/** Спецификация помощника: образ сессии, сеть `none`, `runc`, без портов и GPU. */
export const helperSpec = (
  config: AgentConfigValues,
  fields: {
    readonly name: string;
    readonly kind: string;
    readonly user: string;
    readonly entrypoint: ReadonlyArray<string>;
  } & Partial<Pick<ContainerSpec, "env" | "binds" | "mounts" | "tmpfs">>,
): ContainerSpec => ({
  name: fields.name,
  image: config.sessionImage,
  env: fields.env ?? {},
  labels: { [HELPER_LABEL]: fields.kind },
  network: "none",
  udpPorts: [],
  binds: fields.binds ?? [],
  mounts: fields.mounts ?? [],
  runtime: "runc",
  gpus: false,
  shmSizeBytes: HELPER_SHM_BYTES,
  securityOpt: ["no-new-privileges:true"],
  tmpfs: fields.tmpfs ?? {},
  user: fields.user,
  entrypoint: fields.entrypoint,
});

/**
 * Запускает помощника до выхода; код выхода из `okExit` (по умолчанию только 0)
 * — `afterExit` (контейнер ещё есть: можно `getArchive`), иначе `DockerError`.
 * Одноимённый остаток прошлого запуска удаляется до создания, сам помощник —
 * всегда после.
 */
export const runHelper = <A, E, R>(
  spec: ContainerSpec,
  afterExit: Effect.Effect<A, E, R>,
  okExit: ReadonlyArray<number> = [0],
): Effect.Effect<A, E | DockerError, R | DockerClient> =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    return yield* Effect.acquireUseRelease(
      docker.remove(spec.name).pipe(Effect.andThen(docker.create(spec))),
      () =>
        Effect.gen(function* () {
          yield* docker.start(spec.name);
          const exitCode = yield* docker.wait(spec.name);
          if (!okExit.includes(exitCode))
            return yield* new DockerError({
              operation: "helper",
              message: `${spec.name} exited with ${exitCode}`,
            });
          return yield* afterExit;
        }),
      () =>
        docker.remove(spec.name).pipe(
          Effect.catchTag("DockerError", (error) =>
            Effect.logWarning("Removing helper container failed", {
              name: spec.name,
              error: error.message,
            }),
          ),
        ),
    );
  });
