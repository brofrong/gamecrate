// Каталог своих игр (спека 2026-11-03 «Свои игры»): манифесты
// `games/<slug>/game.json` из репозитория. При старте api читает их,
// синхронизирует в БД (`syncOwnGames`) и держит в памяти — для страницы игры
// (описание, управление, скриншоты), которой в БД нет.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, syncOwnGames } from "@cg/db";
import { OwnGameManifest } from "@cg/rpc";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { AppConfig } from "../config";

const decodeManifest = Schema.decodeUnknownSync(OwnGameManifest);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Манифесты `<dir>/<каталог>/game.json` по имени каталога; каталоги без
 * `game.json` пропускаются. Не декодируется по `OwnGameManifest`, `slug` не равен имени
 * каталога, повтор `appId` или `slug` — исключение с путём к файлу (api с
 * таким каталогом не стартует). Нет самого `dir` — тоже исключение.
 */
export const loadOwnGameManifests = (
  dir: string,
): ReadonlyArray<OwnGameManifest> => {
  const manifests: Array<OwnGameManifest> = [];
  const fileByAppId = new Map<number, string>();
  const fileBySlug = new Map<string, string>();
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const name of names) {
    const file = join(dir, name, "game.json");
    if (!existsSync(file)) continue;
    let manifest: OwnGameManifest;
    try {
      manifest = decodeManifest(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`${file}: ${messageOf(error)}`, { cause: error });
    }
    if (manifest.slug !== name)
      throw new Error(
        `${file}: slug "${manifest.slug}" не совпадает с именем каталога "${name}"`,
      );
    const sameAppId = fileByAppId.get(manifest.appId);
    if (sameAppId !== undefined)
      throw new Error(
        `${file}: appId ${manifest.appId} уже занят в ${sameAppId}`,
      );
    const sameSlug = fileBySlug.get(manifest.slug);
    if (sameSlug !== undefined)
      throw new Error(
        `${file}: slug "${manifest.slug}" уже занят в ${sameSlug}`,
      );
    fileByAppId.set(manifest.appId, file);
    fileBySlug.set(manifest.slug, file);
    manifests.push(manifest);
  }
  return manifests;
};

/** Каталог своих игр не загрузился: `message` — с путём к файлу. */
export class OwnGameCatalogError extends Data.TaggedError(
  "OwnGameCatalogError",
)<{ readonly message: string }> {}

const make = (list: ReadonlyArray<OwnGameManifest>) => {
  const byAppId = new Map(list.map((manifest) => [manifest.appId, manifest]));
  return {
    all: list,
    byAppId: (appId: number) => byAppId.get(appId),
  };
};

/** Манифесты своих игр, загруженные при старте api. */
export class OwnGameCatalog extends Context.Service<
  OwnGameCatalog,
  {
    readonly all: ReadonlyArray<OwnGameManifest>;
    readonly byAppId: (appId: number) => OwnGameManifest | undefined;
  }
>()("@cg/api/OwnGameCatalog") {
  /**
   * Загрузка из `ownGamesDir` и `syncOwnGames` (имя, пакет, требования — в
   * БД; `published` не трогается). Строится после миграций (main.ts); сбой
   * загрузки — ошибка слоя, api не стартует.
   */
  static readonly layer: Layer.Layer<
    OwnGameCatalog,
    OwnGameCatalogError,
    AppConfig | Db
  > = Layer.effect(
    OwnGameCatalog,
    Effect.gen(function* () {
      const { ownGamesDir } = yield* AppConfig;
      const list = yield* Effect.try({
        try: () => loadOwnGameManifests(ownGamesDir),
        catch: (error) =>
          new OwnGameCatalogError({ message: messageOf(error) }),
      });
      yield* syncOwnGames(list);
      yield* Effect.logInfo("Own game catalog loaded", {
        dir: ownGamesDir,
        games: list.map((manifest) => manifest.slug),
      });
      return make(list);
    }),
  );

  /** Каталог из готового списка, без файлов и БД (тесты). */
  static readonly fromManifests = (
    list: ReadonlyArray<OwnGameManifest>,
  ): Layer.Layer<OwnGameCatalog> => Layer.succeed(OwnGameCatalog, make(list));
}
