// Overlay-тома дома Steam: `client` (lower — чистый клиент Steam) монтируется на
// `~/.local/share/Steam`, `apps` (lower — общая библиотека) — на
// `~/.local/share/Steam/steamapps`. Запись контейнера попадает только в upper:
// `<root>/<id>/{client,apps}/{upper,work}`. Тома собирает dockerd (`local`,
// `type=overlay`), sudo не нужен. Сессии — `sessionLayers`; установщик (Task 4)
// строит свои слои тем же `layers`.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { AgentConfig, type AgentConfigValues } from "./config";
import { DockerClient, type DockerError } from "./DockerClient";
import { helperSpec, runHelper } from "./Helper";
import { isValidId } from "./ids";

/** Не удалось подготовить или убрать слои. */
export class OverlayError extends Schema.TaggedError<OverlayError>()(
  "OverlayError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface Layer {
  /** Имя тома: `<prefix>-<id>-client|apps`. */
  readonly volume: string;
  readonly lower: string;
  readonly upper: string;
  readonly work: string;
}

export interface Overlays {
  readonly id: string;
  readonly prefix: string;
  /** Корень scratch (bind помощника очистки). */
  readonly root: string;
  /** Каталог слоёв этого `id`: `<root>/<id>`. */
  readonly dir: string;
  /** Метки томов (по ним агент находит осиротевшие тома). */
  readonly labels: Readonly<Record<string, string>>;
  readonly client: Layer;
  readonly apps: Layer;
}

/** Цели монтирования слоёв в доме контейнера. */
export const STEAM_DIR = "/home/ubuntu/.local/share/Steam";
export const STEAMAPPS_DIR = `${STEAM_DIR}/steamapps`;

/**
 * Слои `id` под `root` с томами `<prefix>-<id>-client|apps`. `id` и `prefix` —
 * по правилу `isValidId` (иначе исключение — ошибка вызывающего): из них
 * строятся имена томов и каталог, который `cleanup` удаляет от root.
 */
export const layers = (
  config: AgentConfigValues,
  options: {
    readonly root: string;
    readonly prefix: string;
    readonly id: string;
    readonly labels: Readonly<Record<string, string>>;
  },
): Overlays => {
  if (!isValidId(options.id))
    throw new Error(`invalid overlay id: ${JSON.stringify(options.id)}`);
  if (!isValidId(options.prefix))
    throw new Error(
      `invalid overlay prefix: ${JSON.stringify(options.prefix)}`,
    );
  const dir = join(options.root, options.id);
  const layer = (name: "client" | "apps", lower: string): Layer => ({
    volume: `${options.prefix}-${options.id}-${name}`,
    lower,
    upper: join(dir, name, "upper"),
    work: join(dir, name, "work"),
  });
  return {
    id: options.id,
    prefix: options.prefix,
    root: options.root,
    dir,
    labels: options.labels,
    client: layer("client", config.steamClientDir),
    apps: layer("apps", join(config.libraryDir, "steamapps")),
  };
};

/** Слои сессии: тома `cg-s-<id>-*`, scratch `<SCRATCH_DIR>/<id>`. */
export const sessionLayers = (config: AgentConfigValues, sessionId: string) =>
  layers(config, {
    root: config.scratchDir,
    prefix: "cg-s",
    id: sessionId,
    labels: { "cg.session": sessionId },
  });

/** Тома слоёв для `ContainerSpec.mounts`. */
export const mountsFor = (overlays: Overlays) => [
  { volume: overlays.client.volume, target: STEAM_DIR },
  { volume: overlays.apps.volume, target: STEAMAPPS_DIR },
];

const fromDocker = (operation: string) => (error: DockerError) =>
  new OverlayError({ operation, message: error.message });

/**
 * Каталоги upper/work (агент, uid 1000 — владелец тот же, что у процессов
 * контейнера) и overlay-тома с метками слоёв.
 */
export const prepare = (overlays: Overlays) =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    for (const layer of [overlays.client, overlays.apps]) {
      yield* Effect.try({
        try: () => {
          mkdirSync(layer.upper, { recursive: true });
          mkdirSync(layer.work, { recursive: true });
        },
        catch: (cause) =>
          new OverlayError({ operation: "mkdir", message: String(cause) }),
      });
      yield* docker
        .createVolume({
          name: layer.volume,
          labels: overlays.labels,
          overlay: { lower: layer.lower, upper: layer.upper, work: layer.work },
        })
        .pipe(Effect.mapError(fromDocker("createVolume")));
    }
  });

/**
 * Удаляет тома (контейнер, который их монтирует, должен быть уже удалён), затем
 * каталог `<root>/<id>` — помощником от root: `work/work` ядро создаёт от root с
 * правами 000, агенту (uid 1000) его не удалить. Монтируется весь `root`, а не
 * `<root>/<id>`: точку монтирования `rm` не удалил бы.
 */
export const cleanup = (overlays: Overlays) =>
  Effect.gen(function* () {
    // `rm -rf` от root: только ровно `<root>/<id>` с допустимым id.
    if (
      !isValidId(overlays.id) ||
      !isValidId(overlays.prefix) ||
      overlays.dir !== join(overlays.root, overlays.id)
    )
      return yield* new OverlayError({
        operation: "cleanup",
        message: `refusing to clean ${JSON.stringify(overlays.dir)}`,
      });
    const docker = yield* DockerClient;
    const config = yield* AgentConfig;
    for (const layer of [overlays.client, overlays.apps])
      yield* docker
        .removeVolume(layer.volume)
        .pipe(Effect.mapError(fromDocker("removeVolume")));
    if (!existsSync(overlays.dir)) return;
    yield* runHelper(
      helperSpec(config, {
        name: `${overlays.prefix}-${overlays.id}-cleanup`,
        kind: "cleanup",
        user: "0",
        entrypoint: ["rm", "-rf", overlays.dir],
        binds: [`${overlays.root}:${overlays.root}`],
      }),
      Effect.void,
    ).pipe(Effect.mapError(fromDocker("removeScratch")));
  });
