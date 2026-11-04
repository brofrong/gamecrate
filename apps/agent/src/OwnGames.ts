// Пакеты своих игр на воркере (`GAMES_DIR`, спека 2026-11-03 «Свои игры»).
// Пакет собирает deploy/add-game.sh: `<GAMES_DIR>/<slug>/<version>/` с
// исполняемым `run` и бинарником игры внутри. Недособранная версия лежит в
// `<GAMES_DIR>/<slug>/.build-<version>` — такое имя не проходит схему
// `OwnGameVersion` (начинается не с `[A-Za-z0-9]`), поэтому отдельно её не
// отфильтровываем, схема делает это сама.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type OwnGamePackage, OwnGameSlug, OwnGameVersion } from "@cg/rpc";
import { Schema } from "effect";

/** Куда монтируется пакет в контейнере сессии — только для чтения. */
export const OWN_GAME_MOUNT = "/opt/cg-game";

/** Запуск пакета внутри сессии. */
export const OWN_GAME_RUN = `${OWN_GAME_MOUNT}/run`;

/** Метка контейнера сессии своей игры: значение — `<slug>/<version>`. */
export const OWN_GAME_LABEL = "cg.own-game";

/** Путь к пакету на хосте: `<GAMES_DIR>/<slug>/<version>/`. */
export const ownGameDir = (gamesDir: string, pkg: OwnGamePackage): string =>
  join(gamesDir, pkg.slug, pkg.version);

/** Имена подкаталогов `dir` по алфавиту; каталога нет — пустой список. */
const subdirNames = (dir: string): Array<string> => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/** `path` существует, это файл и у кого-то есть право на исполнение. */
const isExecutableFile = (path: string): boolean => {
  try {
    const info = statSync(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * Пакеты своих игр на воркере: каталоги `<gamesDir>/<slug>/<version>/` с
 * исполняемым `run`, чьи `slug` и `version` проходят схемы `OwnGameSlug` и
 * `OwnGameVersion` — недособранные `.build-<version>` и прочие скрытые или
 * плохие имена схему не проходят (не начинаются с `[a-z0-9]`/`[A-Za-z0-9]`).
 * Сортировка — по `slug`, затем по `version`. Нет каталога `gamesDir` —
 * пустой список.
 */
export const scanOwnGames = (gamesDir: string): Array<OwnGamePackage> => {
  const packages: Array<OwnGamePackage> = [];
  for (const slug of subdirNames(gamesDir)) {
    if (!Schema.is(OwnGameSlug)(slug)) continue;
    for (const version of subdirNames(join(gamesDir, slug))) {
      if (!Schema.is(OwnGameVersion)(version)) continue;
      if (!isExecutableFile(join(gamesDir, slug, version, "run"))) continue;
      packages.push({ slug, version });
    }
  }
  return packages.sort(
    (a, b) =>
      a.slug.localeCompare(b.slug) || a.version.localeCompare(b.version),
  );
};
