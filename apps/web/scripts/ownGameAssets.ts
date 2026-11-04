// Картинки своих игр для сайта (Global Constraints): `games/<slug>/site/*.jpg` из
// репозитория отдаются по `/own-games/<appId>/<file>` (`ownGameAssetUrl`). Общее для
// `build.ts` (копирует в `dist/own-games/<appId>/`) и `dev.ts` (отдаёт из `games/`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OwnGameManifest } from "@cg/rpc";
import { Schema } from "effect";

/** Каталог манифестов своих игр в корне репозитория. */
export const GAMES_DIR = new URL("../../../games/", import.meta.url).pathname;

/** Имя картинки своей игры — простое имя файла без каталогов (как `site.screenshots`). */
export const OWN_ASSET_FILE = /^[a-z0-9-]+\.jpg$/;

const decodeManifest = Schema.decodeUnknownSync(OwnGameManifest);

/**
 * `appId` → каталог `games/<slug>/site` для каждого `games/<каталог>/game.json`.
 * Манифест не декодируется или `slug` не равен имени каталога — исключение с путём
 * (сборка падает, а не выкладывает сайт без картинок).
 */
export function ownGameSiteDirs(
  gamesDir: string = GAMES_DIR,
): ReadonlyMap<number, string> {
  const dirs = new Map<number, string>();
  const names = readdirSync(gamesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of names) {
    const file = join(gamesDir, name, "game.json");
    if (!existsSync(file)) continue;
    const manifest = decodeManifest(JSON.parse(readFileSync(file, "utf8")));
    if (manifest.slug !== name)
      throw new Error(
        `${file}: slug "${manifest.slug}" не совпадает с именем каталога "${name}"`,
      );
    dirs.set(manifest.appId, join(gamesDir, name, "site"));
  }
  return dirs;
}
