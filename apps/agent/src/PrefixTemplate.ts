// Шаблон префикса Proton на игру (план 4, Task 8.1). Proton при создании
// префикса дважды зовёт глобальный `sync()` (`setup_prefix`: после `copy_pfx` и
// `MachineGuid` и после `creation_sync_guard`), а он ждёт запись всех грязных
// страниц хоста: на свободном хосте ~6 с, на занятом — минуты, процесс в
// состоянии D не убить (пробы 2026-10-28, спека «Пробы ускорения»). С готовым
// префиксом своей версии Proton его не создаёт и `sync()` не зовёт.
//
// Где лежит: `<LIBRARY_DIR>/steamapps/compatdata/<appid>` — внутри lower тома
// `apps` каждой сессии, поэтому сессия видит шаблон без единой правки запуска и
// пишет только в свой upper (copy-up), файлы игрока из профиля ложатся сверху.
// Копия в upper сессии (375 МБ на каждый старт — те же грязные страницы) и
// отдельный overlay-том на шаблон отвергнуты. Цена: менять lower под живым
// overlay той же игры нельзя — перенос только без контейнеров `cg.app=<appid>`
// (иначе `deferred`, повтор при следующем поводе; проверка и до сборки, чтобы не
// собирать впустую, и перед переносом). Метка `cg-template` — сборка
// Proton (первая строка его `version`); другая — шаблон `stale`, его
// пересобирают, а до того сессии видят старый (Proton обновляет его в своём
// upper без создания префикса и без `sync()`).
//
// Как собирается: помощник из образа сессии без сети, GPU, входа в Steam и
// профиля (uid 1000) — те же слои, что у установщика (`installLayers`,
// `pfx-<appid>`), по тем же путям, что в сессии: пути Proton в `config_info`,
// ссылки на его dll и шрифты и диск `s:` совпадают с тем, что увидит сессия.
// Proton идёт через Steam Linux Runtime, как его зовёт Steam. Сам префикс —
// не в upper overlay (там просвечивал бы старый шаблон из lower), а в каталоге
// `build` рядом со слоями, смонтированном поверх `compatdata/<appid>`; оттуда он
// переносится в библиотеку `rename` (одна ФС). Сессия в библиотеку не пишет.
//
// Что внутри: весь префикс, который создал Proton, включая умолчания
// `pfx/user.reg` и `pfx/drive_c/users/steamuser` из `default_pfx`: игрока в
// помощнике нет, а без них новый игрок получил бы префикс без HKCU и
// `%USERPROFILE%` (при готовом `creation_sync_guard` Proton их не создаёт).
// Файлы игрока из профиля перекрывают умолчания. Найден `steam_autocloud.vdf` —
// шаблон не переносится. `MachineGuid` (`system.reg`) общий у всех игроков игры
// до пересборки (сегодня он новый на каждую сессию; с аккаунтом не связан).
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
} from "effect";
import { AgentConfig, type AgentConfigValues } from "./config";
import { type ContainerSpec, DockerClient } from "./DockerClient";
import { FreeSpace, hasFreeSpace } from "./DiskSpace";
import { helperSpec, runHelper } from "./Helper";
import {
  cleanup,
  installLayers,
  mountsFor,
  type Overlays,
  prepare,
  removeVolumes,
  STEAM_DIR,
  STEAMAPPS_DIR,
} from "./Overlay";
import { getPath, isInstallDir, parseAppManifest, parseVdf } from "./steam/vdf";

/** Каким Proton собирается шаблон (им шли обе игры проб). */
export const TEMPLATE_PROTON_DIR = "Proton - Experimental";
/** Метка шаблона: сборка Proton, из которой он сделан. */
export const TEMPLATE_MARKER = "cg-template";
/** Сколько установка ждёт шаблон до `InstallFinished`; дольше — сборка идёт в фоне. */
export const TEMPLATE_INSTALL_WAIT = Duration.minutes(2);
/**
 * Код выхода помощника, когда префикс создан: Proton после `setup_prefix`
 * запускает команду через `steam.exe`, а тот без клиента Steam падает на
 * `steamclient_init` (`abort()` — 3). Готовность проверяется по файлам.
 */
const PROTON_WITHOUT_STEAM_EXIT = 3;
/**
 * Копия рантайма pressure-vessel (~609 МБ) — в tmpfs помощника: не грязные
 * страницы на диске хоста перед `sync()` Proton. `exec` — оттуда запускается
 * `pv-adverb`.
 */
const RUNTIME_COPY_DIR = "/tmp/cg-pv";
/** Глубина поиска `.exe` в каталоге игры. */
const EXE_DEPTH = 4;

export interface ProtonTool {
  /** Каталог Proton в `common/`. */
  readonly dirName: string;
  /** Первая строка его `version`, напр. `1791989105 experimental-11.0-20261014`. */
  readonly build: string;
  /** Каталог Steam Linux Runtime в `common/` (`require_tool_appid`). */
  readonly runtimeDirName: string;
}

export type TemplateOutcome =
  "fresh" | "built" | "deferred" | "skipped" | "failed";

const lstat = (path: string) => lstatSync(path, { throwIfNoEntry: false });

const readText = (path: string) => {
  try {
    return lstat(path)?.isFile() === true
      ? readFileSync(path, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
};

const firstLine = (text: string | undefined) =>
  text?.split("\n")[0]?.trim() || undefined;

/** `installdir` приложения из манифеста библиотеки; нет или не имя — `undefined`. */
const installDirOf = (steamapps: string, appId: number) => {
  const fields = parseAppManifest(
    readText(join(steamapps, `appmanifest_${appId}.acf`)) ?? "",
  );
  const dir = fields?.installdir;
  return isInstallDir(dir) ? dir : undefined;
};

/**
 * Proton библиотеки `steamapps`: сборка — первая строка
 * `common/<TEMPLATE_PROTON_DIR>/version`, рантайм — `installdir` манифеста его
 * `require_tool_appid` (`toolmanifest.vdf`) с `_v2-entry-point`. Чего-то нет —
 * `undefined`.
 */
export const readProtonTool = (steamapps: string): ProtonTool | undefined => {
  const proton = join(steamapps, "common", TEMPLATE_PROTON_DIR);
  const build = firstLine(readText(join(proton, "version")));
  if (build === undefined || lstat(join(proton, "proton"))?.isFile() !== true)
    return undefined;
  const toolAppId = getPath(
    parseVdf(readText(join(proton, "toolmanifest.vdf")) ?? ""),
    ["manifest", "require_tool_appid"],
  );
  if (typeof toolAppId !== "string" || !/^[1-9]\d{0,9}$/.test(toolAppId))
    return undefined;
  const runtimeDirName = installDirOf(steamapps, Number(toolAppId));
  if (
    runtimeDirName === undefined ||
    lstat(
      join(steamapps, "common", runtimeDirName, "_v2-entry-point"),
    )?.isFile() !== true
  )
    return undefined;
  return { dirName: TEMPLATE_PROTON_DIR, build, runtimeDirName };
};

/** Шаблон игры в библиотеке: `<LIBRARY_DIR>/steamapps/compatdata/<appId>`. */
export const templateDir = (config: AgentConfigValues, appId: number) =>
  join(config.libraryDir, "steamapps", "compatdata", String(appId));

/** Нет каталога или метки — `missing`; метка другой сборки — `stale`. */
export const templateState = (
  dir: string,
  tool: ProtonTool,
): "fresh" | "missing" | "stale" => {
  const marker = readText(join(dir, TEMPLATE_MARKER));
  if (marker === undefined) return "missing";
  return firstLine(marker) === tool.build ? "fresh" : "stale";
};

/** Каталоги `dir` до глубины `depth` (ссылки не разыменовываются); не читается — пусто. */
const walk = (
  dir: string,
  depth: number,
  visit: (path: string, name: string) => boolean,
): boolean => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && visit(path, entry.name)) return true;
    if (entry.isDirectory() && depth > 1 && walk(path, depth - 1, visit))
      return true;
  }
  return false;
};

/** Есть ли `*.exe` в `dir` на глубине до `depth`: нативным Linux-играм Proton не нужен. */
export const hasWindowsExe = (dir: string, depth = EXE_DEPTH) =>
  walk(dir, depth, (_path, name) => name.toLowerCase().endsWith(".exe"));

/** Относительные пути `steam_autocloud.vdf` (файлы игрока) под `dir`. */
export const playerDataIn = (dir: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  walk(dir, Number.POSITIVE_INFINITY, (path, name) => {
    if (name.toLowerCase() === "steam_autocloud.vdf")
      found.push(relative(dir, path));
    return false;
  });
  return found.sort();
};

/**
 * Слои сборки: как у установщика (`cg.install=pfx-<appId>`, остатки после
 * падения агента убирает `Installer.reconcile`).
 */
export const templateLayers = (config: AgentConfigValues, appId: number) =>
  installLayers(config, `pfx-${appId}`);

/** Корень scratch сборки на ФС библиотеки: `<INSTALL_SCRATCH_DIR>/pfx-<appId>`. */
const scratchOf = (config: AgentConfigValues, appId: number) =>
  join(
    Option.getOrThrowWith(
      config.installScratchDir,
      () => new Error("INSTALL_SCRATCH_DIR is not set"),
    ),
    `pfx-${appId}`,
  );

/** Куда помощник пишет префикс (смонтирован на `compatdata/<appId>`). */
const buildDirOf = (config: AgentConfigValues, appId: number) =>
  join(scratchOf(config, appId), "build");

/**
 * Помощник сборки: Proton через Steam Linux Runtime, как его запускает Steam
 * (`waitforexitandrun`), с командой, которой нужен только префикс.
 * `BWRAP` — `proot-bwrap` (в контейнере нет user namespaces, как у
 * `/usr/bin/steam` образа); `DBUS_SYSTEM_BUS_ADDRESS` пуст — системной шины в
 * помощнике нет, а адрес из образа pressure-vessel пробросил бы как bind.
 */
export const templateBuildSpec = (
  config: AgentConfigValues,
  appId: number,
  installDir: string,
  tool: ProtonTool,
): ContainerSpec => {
  const id = String(appId);
  const compatData = `${STEAMAPPS_DIR}/compatdata/${id}`;
  const runtime = `${STEAMAPPS_DIR}/common/${tool.runtimeDirName}`;
  const proton = `${STEAMAPPS_DIR}/common/${tool.dirName}`;
  return helperSpec(config, {
    name: `cg-i-pfx-${id}-build`,
    kind: "prefix-template",
    user: "1000",
    mounts: mountsFor(templateLayers(config, appId)),
    binds: [`${buildDirOf(config, appId)}:${compatData}`],
    tmpfs: { [RUNTIME_COPY_DIR]: "exec,size=1g" },
    env: {
      HOME: "/home/ubuntu",
      SteamAppId: id,
      SteamGameId: id,
      STEAM_COMPAT_APP_ID: id,
      STEAM_COMPAT_DATA_PATH: compatData,
      STEAM_COMPAT_CLIENT_INSTALL_PATH: STEAM_DIR,
      STEAM_COMPAT_INSTALL_PATH: `${STEAMAPPS_DIR}/common/${installDir}`,
      STEAM_COMPAT_LIBRARY_PATHS: STEAMAPPS_DIR,
      STEAM_COMPAT_TOOL_PATHS: `${proton}:${runtime}`,
      PRESSURE_VESSEL_VARIABLE_DIR: RUNTIME_COPY_DIR,
      BWRAP: "/usr/local/bin/proot-bwrap",
      DBUS_SYSTEM_BUS_ADDRESS: "",
    },
    entrypoint: [
      `${runtime}/_v2-entry-point`,
      "--verb=waitforexitandrun",
      "--",
      `${proton}/proton`,
      "waitforexitandrun",
      "C:\\windows\\system32\\cmd.exe",
      "/c",
      "exit",
      "0",
    ],
  });
};

/**
 * Перенос готового шаблона `built` в `target` (одна ФС): родитель создаётся,
 * прежний шаблон уходит в `trash`, затем `rename(built, target)`.
 */
export const promoteTemplate = (
  built: string,
  target: string,
  trash: string,
) => {
  mkdirSync(dirname(target), { recursive: true });
  if (lstat(target) !== undefined) renameSync(target, trash);
  renameSync(built, target);
};

export interface PrefixTemplatesShape {
  /** Шаблон игры `appId` на месте и свежий; никогда не падает (сбой — `failed` и лог). */
  readonly ensure: (appId: number) => Effect.Effect<TemplateOutcome>;
  /**
   * Для `appId` сейчас идёт `ensure` (сборка или ожидание чужой сборки —
   * запись в `inFlight`): удалять шаблон, в который пишет Proton, нельзя.
   */
  readonly building: (appId: number) => boolean;
}

/** Шаблоны префикса (по умолчанию — ничего не делает: тесты и агент без слоя). */
export const PrefixTemplates = Context.Reference<PrefixTemplatesShape>(
  "@cg/agent/PrefixTemplates",
  {
    defaultValue: () => ({
      ensure: () => Effect.succeed("skipped"),
      building: () => false,
    }),
  },
);

/** Сборка не удалась: причина для лога. */
class BuildFailed extends Data.TaggedError("PrefixTemplateBuildFailed")<{
  readonly error: string;
}> {}

const make = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const docker = yield* DockerClient;
  const freeSpace = yield* FreeSpace;
  const scope = yield* Effect.scope;
  const services = yield* Effect.context<AgentConfig | DockerClient>();
  const inFlight = new Map<number, Deferred.Deferred<TemplateOutcome>>();

  const skipped = (appId: number, why: string) =>
    Effect.logInfo("Prefix template skipped", { appId, why }).pipe(
      Effect.as<TemplateOutcome>("skipped"),
    );

  const fail = (error: string) => Effect.fail(new BuildFailed({ error }));

  const sync = <A>(what: string, f: () => A) =>
    Effect.try({
      try: f,
      catch: (cause) => new BuildFailed({ error: `${what}: ${String(cause)}` }),
    });

  /** Слои сборки убрать; не вышло — только лог (уберёт старт агента). */
  const cleanupLogged = (overlays: Overlays, appId: number) =>
    cleanup(overlays).pipe(
      Effect.provideContext(services),
      Effect.catchTag("OverlayError", (error) =>
        Effect.logWarning("Removing prefix template layers failed", {
          appId,
          operation: error.operation,
          error: error.message,
        }),
      ),
    );

  /** Есть контейнер `cg.app=<appId>` (сессия, установщик): lower игры менять нельзя. */
  const appInUse = (appId: number) =>
    docker.listByLabel("cg.app").pipe(
      Effect.map((containers) =>
        containers.some(
          (container) => container.labels["cg.app"] === String(appId),
        ),
      ),
      Effect.mapError((error) => new BuildFailed({ error: error.message })),
    );

  const deferredInUse = (appId: number) =>
    Effect.logInfo("Prefix template deferred: app in use", { appId }).pipe(
      Effect.as("deferred" as const),
    );

  /** Шаги 3–7: собрать, проверить, пометить, перенести. Слои убирает вызывающий. */
  const buildAndPromote = (
    appId: number,
    overlays: Overlays,
    installDir: string,
    tool: ProtonTool,
  ) =>
    Effect.gen(function* () {
      const built = buildDirOf(config, appId);
      yield* cleanup(overlays).pipe(
        Effect.provideContext(services),
        Effect.mapError(
          (error) => new BuildFailed({ error: `cleanup: ${error.message}` }),
        ),
      );
      yield* prepare(overlays).pipe(
        Effect.provideContext(services),
        Effect.mapError(
          (error) => new BuildFailed({ error: `prepare: ${error.message}` }),
        ),
      );
      yield* sync("mkdir", () => mkdirSync(built, { recursive: true }));
      yield* runHelper(
        templateBuildSpec(config, appId, installDir, tool),
        Effect.void,
        [0, PROTON_WITHOUT_STEAM_EXIT],
      ).pipe(
        Effect.provideService(DockerClient, docker),
        Effect.mapError((error) => new BuildFailed({ error: error.message })),
      );
      yield* removeVolumes(overlays).pipe(
        Effect.provideContext(services),
        Effect.mapError(
          (error) =>
            new BuildFailed({ error: `removeVolumes: ${error.message}` }),
        ),
      );
      if (
        lstat(join(built, "version"))?.isFile() !== true ||
        lstat(join(built, "pfx", "creation_sync_guard")) === undefined
      )
        return yield* fail("Proton did not create the prefix");
      const playerData = playerDataIn(built);
      if (playerData.length > 0) {
        yield* Effect.logError("Prefix template has player data", {
          appId,
          paths: playerData,
        });
        return "failed" as const;
      }
      yield* sync("marker", () =>
        writeFileSync(join(built, TEMPLATE_MARKER), `${tool.build}\n`),
      );
      // Ещё раз: сессия игры могла стартовать, пока шла сборка.
      if (yield* appInUse(appId)) return yield* deferredInUse(appId);
      // И ещё раз: игру могли удалить, пока шла сборка — `GameRemoval` увёл
      // её `appmanifest_<appId>.acf` в trash, а `building(appId)` админское
      // удаление не видит вовсе (CLI — отдельный процесс) или видит только
      // частично (гонка `ensure`/`moveToTrash` в одном процессе). Переносить
      // шаблон в библиотеку удалённой игры незачем — это осиротевший каталог,
      // который никто не уберёт; собранный каталог убирает вызывающий как
      // обычно.
      if (
        installDirOf(join(config.libraryDir, "steamapps"), appId) === undefined
      )
        return yield* skipped(appId, "game was removed during the build");
      yield* sync("promote", () =>
        promoteTemplate(
          built,
          templateDir(config, appId),
          join(scratchOf(config, appId), "old"),
        ),
      );
      yield* Effect.logInfo("Prefix template built", {
        appId,
        build: tool.build,
      });
      return "built" as const;
    });

  /** `ensure` без single-flight: проверки, сборка, уборка. */
  const build = (appId: number): Effect.Effect<TemplateOutcome> =>
    Effect.gen(function* () {
      if (Option.isNone(config.installScratchDir))
        return yield* skipped(appId, "no INSTALL_SCRATCH_DIR");
      const steamapps = join(config.libraryDir, "steamapps");
      const tool = readProtonTool(steamapps);
      if (tool === undefined)
        return yield* skipped(
          appId,
          `no ${TEMPLATE_PROTON_DIR} in the library`,
        );
      const installDir = installDirOf(steamapps, appId);
      if (installDir === undefined)
        return yield* skipped(appId, "app is not in the library");
      if (!hasWindowsExe(join(steamapps, "common", installDir)))
        return yield* skipped(appId, "no Windows executable");
      if (templateState(templateDir(config, appId), tool) === "fresh")
        return "fresh" as const;
      if (
        !(yield* hasFreeSpace(
          freeSpace,
          config.installScratchDir.value,
          config.minFreeGb,
        ))
      )
        return yield* skipped(appId, "not enough free disk space");
      // Игра занята — не собирать впустую: перенести шаблон всё равно нельзя.
      const inUse = yield* appInUse(appId).pipe(
        Effect.catchTag("PrefixTemplateBuildFailed", (error) =>
          Effect.logError("Prefix template build failed", {
            appId,
            error: error.error,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (inUse === undefined) return "failed" as const;
      if (inUse) return yield* deferredInUse(appId);
      const overlays = templateLayers(config, appId);
      return yield* buildAndPromote(appId, overlays, installDir, tool).pipe(
        Effect.catchTag("PrefixTemplateBuildFailed", (error) =>
          Effect.logError("Prefix template build failed", {
            appId,
            error: error.error,
          }).pipe(Effect.as<TemplateOutcome>("failed")),
        ),
        Effect.ensuring(cleanupLogged(overlays, appId)),
      );
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("Prefix template build failed", {
          appId,
          error: String(defect),
        }).pipe(Effect.as<TemplateOutcome>("failed")),
      ),
    );

  const ensure = (appId: number): Effect.Effect<TemplateOutcome> =>
    Effect.suspend(() => {
      if (!Number.isSafeInteger(appId) || appId <= 0)
        return Effect.logError("Prefix template for an invalid appId", {
          appId,
        }).pipe(Effect.as<TemplateOutcome>("failed"));
      const running = inFlight.get(appId);
      if (running !== undefined) return Deferred.await(running);
      // Синхронно до первого `yield`: второй `ensure` той же игры увидит запись.
      const deferred = Deferred.makeUnsafe<TemplateOutcome>();
      inFlight.set(appId, deferred);
      // Сборка — в scope сервиса: прерывание ожидающего (таймаут установщика) её не прерывает.
      return Effect.forkIn(
        build(appId).pipe(
          Effect.flatMap((outcome) => Deferred.succeed(deferred, outcome)),
          Effect.ensuring(
            Effect.suspend(() => {
              inFlight.delete(appId);
              return Deferred.succeed(deferred, "failed");
            }),
          ),
        ),
        scope,
      ).pipe(Effect.andThen(Deferred.await(deferred)));
    });

  const building = (appId: number) => inFlight.has(appId);

  return { ensure, building } satisfies PrefixTemplatesShape;
});

/**
 * Сервис шаблонов агента: сборки идут в scope слоя, по одной на игру.
 * `PrefixTemplates` — `Context.Reference` (у него есть значение по умолчанию),
 * поэтому в типе слоя он не виден (`never`), но в контекст слой его кладёт.
 */
export const prefixTemplatesLayer: Layer.Layer<
  never,
  never,
  AgentConfig | DockerClient
> = Layer.effect(PrefixTemplates, make);
