// Удаление игры из общей библиотеки (роль gamestore, команда `DeleteGame`) и
// список библиотеки для снимка `WorkerStats`. Игра уходит из `steamapps`
// переносом `rename` в корзину `<LIBRARY_DIR>/.trash` (та же ФС, мгновенно;
// вне `steamapps` — сессии её не видят), корзина затем чистится: `fs.rm` от
// uid 1000, а что агенту удалить не дали — помощником от root.
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LibraryApp } from "@cg/rpc";
import { Data, Effect } from "effect";
import { AgentConfig } from "./config";
import type { DockerClient } from "./DockerClient";
import { helperSpec, runHelper } from "./Helper";
import { isInstallDir, parseAppManifest } from "./steam/vdf";

/** Корзина удалённых игр: `<LIBRARY_DIR>/.trash`. */
export const TRASH_DIR = ".trash";

/** Помощник от root, дочищающий корзину. */
export const TRASH_HELPER = "cg-delete-game";

/** Манифест приложения в `steamapps`: `appmanifest_<id>.acf`. */
export const MANIFEST_FILE = /^appmanifest_([1-9]\d{0,9})\.acf$/;

const lstat = (path: string) => lstatSync(path, { throwIfNoEntry: false });

/** Поля манифеста; файла нет, это не файл или он не разбирается — `undefined`. */
const readManifest = (path: string) => {
  try {
    return parseAppManifest(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Приложения библиотеки по `appmanifest_<id>.acf` в `steamapps` (по `appId`):
 * `appid` манифеста (должен совпадать с именем файла), `name`, `SizeOnDisk`
 * (нет или не число — 0). Битые манифесты и не-файлы пропускаются; каталога
 * нет — пустой список.
 */
export const scanLibrary = (steamapps: string): Array<LibraryApp> => {
  let entries;
  try {
    entries = readdirSync(steamapps, { withFileTypes: true });
  } catch {
    return [];
  }
  const apps: Array<LibraryApp> = [];
  for (const entry of entries) {
    const match = MANIFEST_FILE.exec(entry.name);
    if (match === null || !entry.isFile()) continue;
    const fields = readManifest(join(steamapps, entry.name));
    if (fields === undefined || fields.appid !== match[1]) continue;
    const size = fields.SizeOnDisk;
    apps.push({
      appId: Number(match[1]),
      name: fields.name ?? "",
      sizeBytes:
        size !== undefined && /^\d{1,15}$/.test(size) ? Number(size) : 0,
    });
  }
  return apps.sort((a, b) => a.appId - b.appId);
};

export interface RemovalPlan {
  /** `steamapps/appmanifest_<appId>.acf`. */
  readonly manifest: string;
  /** Существующие `common/<installdir>` и `shadercache/<appId>`. */
  readonly dirs: ReadonlyArray<string>;
}

/**
 * Что убрать из библиотеки для `appId`: манифест и существующие каталоги
 * `common/<installdir>` (только если `installdir` — один компонент пути) и
 * `shadercache/<appId>`. Манифеста нет — `undefined` (игры уже нет).
 */
export const planRemoval = (
  steamapps: string,
  appId: number,
): RemovalPlan | undefined => {
  const manifest = join(steamapps, `appmanifest_${appId}.acf`);
  if (lstat(manifest) === undefined) return undefined;
  const installDir = readManifest(manifest)?.installdir;
  const candidates = [
    ...(isInstallDir(installDir)
      ? [join(steamapps, "common", installDir)]
      : []),
    join(steamapps, "shadercache", String(appId)),
  ];
  return {
    manifest,
    dirs: candidates.filter((dir) => lstat(dir) !== undefined),
  };
};

/**
 * Переносит план `rename` в корзину: манифест первым (Steam сразу перестаёт
 * считать игру установленной), затем каталоги — каждый в свой
 * `<LIBRARY_DIR>/.trash/<appId>-<stamp>[-<n>]` (первое свободное имя).
 * Возвращает пути в корзине по порядку переноса.
 */
export const moveToTrash = (
  plan: RemovalPlan,
  libraryDir: string,
  stamp: string,
): Array<string> => {
  const trash = join(libraryDir, TRASH_DIR);
  mkdirSync(trash, { recursive: true });
  const appId = MANIFEST_FILE.exec(basename(plan.manifest))?.[1] ?? "app";
  const base = `${appId}-${stamp}`;
  const moved: Array<string> = [];
  let n = 0;
  for (const from of [plan.manifest, ...plan.dirs]) {
    let to = join(trash, base);
    while (lstat(to) !== undefined) to = join(trash, `${base}-${++n}`);
    renameSync(from, to);
    moved.push(to);
  }
  return moved;
};

/** Игру не удалось перенести в корзину или корзину — очистить. */
export class GameRemovalError extends Data.TaggedError("GameRemovalError")<{
  readonly message: string;
}> {}

/** Ошибка файловой системы (или Docker) — `GameRemovalError` с её текстом. */
export const removalError = (error: unknown) =>
  new GameRemovalError({
    message: error instanceof Error ? error.message : String(error),
  });

const codeOf = (error: unknown) =>
  (error as { code?: unknown } | undefined)?.code;

/**
 * Агенту (uid 1000) не дали удалить: каталог от root или без прав записи.
 * `ENOTEMPTY` — тоже: рекурсивный `fs.rm` Bun молча пропускает вложенную
 * запись, которую не смог удалить (`EACCES`), и падает уже на `rmdir` её
 * родителя (проверено на Bun 1.4).
 */
const isAccessDenied = (error: unknown) =>
  codeOf(error) === "EACCES" ||
  codeOf(error) === "EPERM" ||
  codeOf(error) === "ENOTEMPTY";

/**
 * Очищает корзину: каждую запись — `fs.rm` (асинхронно: удаление игры на
 * десятки ГБ не должно блокировать event loop агента с живыми сессиями), а
 * записи, где агенту отказано в доступе, — одним помощником от root (`rm -rf`,
 * bind самой корзины: её записи — не точки монтирования). Корзины нет — ничего.
 */
export const emptyTrash: Effect.Effect<
  void,
  GameRemovalError,
  AgentConfig | DockerClient
> = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const trash = join(config.libraryDir, TRASH_DIR);
  const names = yield* Effect.tryPromise({
    try: () => readdir(trash),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      codeOf(error) === "ENOENT"
        ? Effect.succeed<Array<string>>([])
        : Effect.fail(removalError(error)),
    ),
  );
  const denied: Array<string> = [];
  for (const name of names.sort()) {
    const path = join(trash, name);
    yield* Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        isAccessDenied(error)
          ? Effect.sync(() => void denied.push(path))
          : Effect.fail(removalError(error)),
      ),
    );
  }
  if (denied.length === 0) return;
  yield* Effect.logInfo("Removing trash entries as root", { paths: denied });
  yield* runHelper(
    helperSpec(config, {
      name: TRASH_HELPER,
      kind: "delete-game",
      user: "0",
      entrypoint: ["rm", "-rf", ...denied],
      binds: [`${trash}:${trash}`],
    }),
    Effect.void,
  ).pipe(Effect.mapError(removalError));
});
