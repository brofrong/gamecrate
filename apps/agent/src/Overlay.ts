// Overlay-тома дома Steam: `client` (lower — чистый клиент Steam) монтируется на
// `~/.local/share/Steam`, `apps` (lower — общая библиотека) — на
// `~/.local/share/Steam/steamapps`. Запись контейнера попадает только в upper:
// `<root слоя>/<id>/{client,apps}/{upper,work}`. Тома собирает dockerd (`local`,
// `type=overlay`), sudo не нужен. Сессии — `sessionLayers` (оба слоя в
// `SCRATCH_DIR`), установщик — `installLayers` (клиент в
// `SCRATCH_DIR/.install`, apps в `INSTALL_SCRATCH_DIR`). Одноразовые слои
// монтируются с `volatile` (без fsync), кроме apps установщика.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
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
  /** Монтируется с `volatile` (см. `OverlayVolumeSpec`). */
  readonly volatile: boolean;
}

/** Каталог слоёв `id` под одним корнем scratch. */
export interface ScratchDir {
  /** Корень scratch (bind помощника очистки). */
  readonly root: string;
  /** Каталог слоёв этого `id`: ровно `<root>/<id>`. */
  readonly dir: string;
}

export interface Overlays {
  readonly id: string;
  readonly prefix: string;
  /** Метки томов (по ним агент находит осиротевшие тома). */
  readonly labels: Readonly<Record<string, string>>;
  /** Каталоги слоёв (без повторов): их удаляет `removeScratch`. */
  readonly scratch: ReadonlyArray<ScratchDir>;
  readonly client: Layer;
  readonly apps: Layer;
}

/**
 * Подкаталог `SCRATCH_DIR` со слоями клиента Steam установщиков:
 * `<SCRATCH_DIR>/.install/<jobId>/client`. Имя — не `isValidId` (точка), поэтому
 * уборка слоёв сессий, которая берёт из `SCRATCH_DIR` только каталоги-id, его
 * не видит; убирает его только Installer.
 */
export const INSTALL_CLIENT_DIR = ".install";

/** Цели монтирования слоёв в доме контейнера. */
export const STEAM_DIR = "/home/ubuntu/.local/share/Steam";
export const STEAMAPPS_DIR = `${STEAM_DIR}/steamapps`;

/**
 * Слои `id` с томами `<prefix>-<id>-client|apps`; слой `name` — в
 * `<roots[name]>/<id>/<name>/{upper,work}`. `id` и `prefix` — по правилу
 * `isValidId` (иначе исключение — ошибка вызывающего): из них строятся имена
 * томов и каталоги, которые `cleanup` удаляет от root.
 */
export const layers = (
  config: AgentConfigValues,
  options: {
    readonly roots: { readonly client: string; readonly apps: string };
    readonly prefix: string;
    readonly id: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly volatile: { readonly client: boolean; readonly apps: boolean };
  },
): Overlays => {
  if (!isValidId(options.id))
    throw new Error(`invalid overlay id: ${JSON.stringify(options.id)}`);
  if (!isValidId(options.prefix))
    throw new Error(
      `invalid overlay prefix: ${JSON.stringify(options.prefix)}`,
    );
  const layer = (name: "client" | "apps", lower: string): Layer => {
    const dir = join(options.roots[name], options.id);
    return {
      volume: `${options.prefix}-${options.id}-${name}`,
      lower,
      upper: join(dir, name, "upper"),
      work: join(dir, name, "work"),
      volatile: options.volatile[name],
    };
  };
  const scratch: Array<ScratchDir> = [];
  for (const root of [options.roots.client, options.roots.apps])
    if (!scratch.some((entry) => entry.root === root))
      scratch.push({ root, dir: join(root, options.id) });
  return {
    id: options.id,
    prefix: options.prefix,
    labels: options.labels,
    scratch,
    client: layer("client", config.steamClientDir),
    apps: layer("apps", join(config.libraryDir, "steamapps")),
  };
};

/** Слои сессии: тома `cg-s-<id>-*`, scratch `<SCRATCH_DIR>/<id>` (NVMe). */
export const sessionLayers = (config: AgentConfigValues, sessionId: string) =>
  layers(config, {
    roots: { client: config.scratchDir, apps: config.scratchDir },
    prefix: "cg-s",
    id: sessionId,
    labels: { "cg.session": sessionId },
    volatile: { client: true, apps: true },
  });

/**
 * Слои установки (роль `gamestore`): тома `cg-i-<jobId>-*`. Клиент Steam — в
 * `<SCRATCH_DIR>/.install/<jobId>` (NVMe: pressure-vessel при старте копирует в
 * upper клиента ~300 МБ рантайма мелкими файлами с fsync, на RAID это часы);
 * `steamapps` — в `<INSTALL_SCRATCH_DIR>/<jobId>` (ФС библиотеки: готовая игра
 * переносится `rename`). Без `INSTALL_SCRATCH_DIR` — исключение (конфиг роли
 * gamestore его требует). `apps` — без `volatile`: его upper уходит в общую
 * библиотеку, и после сбоя хоста без fsync там оказалась бы битая игра.
 */
export const installLayers = (config: AgentConfigValues, jobId: string) =>
  layers(config, {
    roots: {
      client: join(config.scratchDir, INSTALL_CLIENT_DIR),
      apps: Option.getOrThrowWith(
        config.installScratchDir,
        () => new Error("INSTALL_SCRATCH_DIR is not set"),
      ),
    },
    prefix: "cg-i",
    id: jobId,
    labels: { "cg.install": jobId },
    volatile: { client: true, apps: false },
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
          overlay: {
            lower: layer.lower,
            upper: layer.upper,
            work: layer.work,
            volatile: layer.volatile,
          },
        })
        .pipe(Effect.mapError(fromDocker("createVolume")));
    }
  });

/** `rm -rf` от root: только ровно `<root>/<id>` с допустимыми id и префиксом. */
const ownDir = (overlays: Overlays) =>
  isValidId(overlays.id) &&
  isValidId(overlays.prefix) &&
  overlays.scratch.length > 0 &&
  overlays.scratch.every(
    ({ root, dir }) =>
      root.startsWith("/") && root !== "/" && dir === join(root, overlays.id),
  )
    ? Effect.void
    : Effect.fail(
        new OverlayError({
          operation: "cleanup",
          message: `refusing to clean ${JSON.stringify(overlays.scratch.map((entry) => entry.dir))}`,
        }),
      );

/**
 * Удаляет оба тома: контейнер, который их монтирует, должен быть уже удалён
 * (иначе 409). После успеха overlay размонтирован — upper можно читать и менять.
 */
export const removeVolumes = (overlays: Overlays) =>
  Effect.gen(function* () {
    const docker = yield* DockerClient;
    for (const layer of [overlays.client, overlays.apps])
      yield* docker
        .removeVolume(layer.volume)
        .pipe(Effect.mapError(fromDocker("removeVolume")));
  });

/**
 * Удаляет каталоги `<root>/<id>` (тома уже удалены) — одним помощником от
 * root: `work/work` ядро создаёт от root с правами 000, агенту (uid 1000) его
 * не удалить. Монтируются корни целиком, а не `<root>/<id>`: точку монтирования
 * `rm` не удалил бы. Каталогов нет — помощник не запускается.
 */
export const removeScratch = (overlays: Overlays) =>
  Effect.gen(function* () {
    yield* ownDir(overlays);
    const config = yield* AgentConfig;
    const present = overlays.scratch.filter(({ dir }) => existsSync(dir));
    if (present.length === 0) return;
    yield* runHelper(
      helperSpec(config, {
        name: `${overlays.prefix}-${overlays.id}-cleanup`,
        kind: "cleanup",
        user: "0",
        entrypoint: ["rm", "-rf", ...present.map(({ dir }) => dir)],
        binds: present.map(({ root }) => `${root}:${root}`),
      }),
      Effect.void,
    ).pipe(Effect.mapError(fromDocker("removeScratch")));
  });

/**
 * Держит тома слоёв смонтированными до закрытия scope: помощник `sleep`
 * монтирует их первым, а `local` монтирует том один раз, пока его держит хоть
 * один контейнер. Нужен до старта контейнера с `volatile`-слоями: каждое
 * монтирование такого тома (в том числе `putArchive`/`getArchive` в ещё не
 * запущенный контейнер) оставляет метку ядра `incompat`, и следующее падает с
 * `invalid argument`. Закрывать scope — после `docker start`: тогда тома
 * держит уже сам контейнер.
 */
export const holdVolumes = (overlays: Overlays) =>
  Effect.gen(function* () {
    const config = yield* AgentConfig;
    const docker = yield* DockerClient;
    const name = `${overlays.prefix}-${overlays.id}-hold`;
    yield* Effect.acquireRelease(
      docker.remove(name).pipe(
        Effect.andThen(
          docker.create(
            helperSpec(config, {
              name,
              kind: "hold",
              user: "1000",
              entrypoint: ["sleep", "infinity"],
              mounts: mountsFor(overlays),
            }),
          ),
        ),
      ),
      () =>
        docker.remove(name).pipe(
          Effect.catchTag("DockerError", (error) =>
            Effect.logWarning("Removing helper container failed", {
              name,
              error: error.message,
            }),
          ),
        ),
    );
    yield* docker.start(name);
  }).pipe(Effect.mapError(fromDocker("holdVolumes")));

/**
 * Слои оставленного остановленного контейнера (`profile-unsaved`) снова можно
 * смонтировать: одним помощником от root — `sync` ФС scratch (без fsync
 * `volatile` upper мог быть ещё не на диске) и удаление меток ядра
 * `<work>/work/incompat` у слоёв с `volatile` (пока метка есть, `docker start`
 * падает с `invalid argument`). Тома должны быть размонтированы — контейнер
 * остановлен. Каталогов или таких слоёв нет — помощник не запускается.
 */
export const unmarkVolatile = (overlays: Overlays) =>
  Effect.gen(function* () {
    yield* ownDir(overlays);
    const config = yield* AgentConfig;
    const present = overlays.scratch.filter(({ dir }) => existsSync(dir));
    const markers = [overlays.client, overlays.apps]
      .filter((layer) => layer.volatile)
      .map((layer) => join(layer.work, "work", "incompat"));
    const first = present[0];
    if (first === undefined || markers.length === 0) return;
    yield* runHelper(
      helperSpec(config, {
        name: `${overlays.prefix}-${overlays.id}-unmark`,
        kind: "unmark",
        user: "0",
        // `sync -f` — по одному каталогу: слои с `volatile` лежат на одной ФС.
        entrypoint: [
          "sh",
          "-c",
          'sync -f "$1" && shift && rm -rf -- "$@"',
          "unmark",
          first.dir,
          ...markers,
        ],
        binds: present.map(({ root }) => `${root}:${root}`),
      }),
      Effect.void,
    ).pipe(Effect.mapError(fromDocker("unmarkVolatile")));
  });

/** Тома, затем scratch (`removeVolumes` → `removeScratch`); каталоги проверяются до любых вызовов. */
export const cleanup = (overlays: Overlays) =>
  Effect.gen(function* () {
    yield* ownDir(overlays);
    yield* removeVolumes(overlays);
    yield* removeScratch(overlays);
  });
