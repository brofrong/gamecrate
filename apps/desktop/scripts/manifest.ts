// Манифест автообновления `latest.json` (формат updater Tauri v2) и CLI для джоба публикации
// (`.github/workflows/desktop.yml`). Манифест лежит в бакете `cg-desktop` и раздаётся API по
// `GET /download/desktop/latest.json`; файлы версии — `GET /download/desktop/<версия>/<файл>`.
//
// CLI (bun, без зависимостей):
//   bun apps/desktop/scripts/manifest.ts --tag desktop-v0.1.0 --dir artifacts --out latest.json \
//     --base-url https://gamecrate.srv5.wbrofrong.ru/download/desktop [--notes "Что нового"] \
//     [--notes-file notes.md] [--pub-date 2026-11-16T12:00:00Z] [--platforms darwin-universal,windows-x86_64]
// `--dir` — каталог со скачанными артефактами (ищется рекурсивно, как кладёт download-artifact);
// в stdout — пути файлов к загрузке (файл обновления с его `.sig`, установщик macOS `.dmg`), по
// одному в строке, относительно `--dir`. В манифест, кроме полей updater, кладётся `downloads` —
// ссылки и размеры установщиков для страницы «Скачать». Подписи читаются из `.sig` рядом с
// файлом. Любая неполнота (нет файла платформы, нет
// `.sig`, файлов несколько) — ненулевой код: лучше не опубликовать, чем выпустить манифест,
// на который updater упадёт у всех.
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

/** Файл обновления с платформы сборки: macOS — один универсальный архив на обе архитектуры. */
export type UpdaterPlatform =
  | "darwin-universal"
  | "windows-x86_64"
  | "linux-x86_64";

export type ManifestFile = {
  readonly platform: UpdaterPlatform;
  /** Имя файла в каталоге версии (без пути). */
  readonly file: string;
  /** Содержимое `.sig` (подпись minisign в base64). */
  readonly signature: string;
};

export type TauriPlatformEntry = {
  readonly signature: string;
  readonly url: string;
};

/** ОС со страницы «Скачать»: что человек скачивает и запускает сам. */
export type InstallerOs = "macos" | "windows" | "linux";

export type Installer = {
  readonly os: InstallerOs;
  /** Имя файла в каталоге версии (без пути). */
  readonly file: string;
  /** Размер, байт (для подписи на странице). */
  readonly size?: number;
};

export type DownloadEntry = { readonly url: string; readonly size?: number };

/**
 * `latest.json` updater Tauri v2. `downloads` — наше дополнение для страницы «Скачать»
 * (установщики: у macOS это `.dmg`, а в `platforms` — архив для updater); updater лишние поля
 * манифеста игнорирует.
 */
export type TauriManifest = {
  readonly version: string;
  readonly notes: string;
  readonly pub_date: string;
  readonly platforms: Readonly<Record<string, TauriPlatformEntry>>;
  readonly downloads?: Readonly<Partial<Record<InstallerOs, DownloadEntry>>>;
};

export type BuildManifestInput = {
  readonly version: string;
  readonly notes: string;
  /** Дата публикации, RFC 3339. */
  readonly pubDate: string;
  /** Откуда раздаются версии, без `/` в конце: `<baseUrl>/<версия>/<файл>`. */
  readonly baseUrl: string;
  readonly files: ReadonlyArray<ManifestFile>;
  /** Установщики для страницы «Скачать»; без них поля `downloads` в манифесте нет. */
  readonly installers?: ReadonlyArray<Installer>;
};

/** Ключи `platforms` в манифесте updater для каждой нашей платформы. */
const updaterKeys: Record<UpdaterPlatform, ReadonlyArray<string>> = {
  "darwin-universal": ["darwin-aarch64", "darwin-x86_64"],
  "windows-x86_64": ["windows-x86_64"],
  "linux-x86_64": ["linux-x86_64"],
};

const versionPattern = /^\d+\.\d+\.\d+$/;
/** Как в `apps/api/src/download/routes.ts`: API отдаёт только такие имена. */
const filePattern = /^[A-Za-z0-9._-]+$/;

const checkFileName = (file: string): void => {
  if (!filePattern.test(file) || file === "." || file === "..")
    throw new Error(`недопустимое имя файла «${file}»`);
};

export const buildManifest = (input: BuildManifestInput): TauriManifest => {
  if (!versionPattern.test(input.version))
    throw new Error(`версия должна быть вида X.Y.Z, а не «${input.version}»`);
  if (input.files.length === 0) throw new Error("нет ни одного файла обновления");
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const platforms: Record<string, TauriPlatformEntry> = {};
  const seen = new Set<UpdaterPlatform>();
  for (const { platform, file, signature } of input.files) {
    if (!(platform in updaterKeys))
      throw new Error(`неизвестная платформа «${platform}»`);
    if (seen.has(platform)) throw new Error(`платформа ${platform} повторяется`);
    seen.add(platform);
    checkFileName(file);
    if (signature.trim() === "")
      throw new Error(`пустая подпись у ${file}`);
    const entry = {
      signature: signature.trim(),
      url: `${baseUrl}/${input.version}/${file}`,
    };
    for (const key of updaterKeys[platform]) platforms[key] = entry;
  }
  const manifest = {
    version: input.version,
    notes: input.notes,
    pub_date: input.pubDate,
    platforms,
  };
  if (input.installers === undefined || input.installers.length === 0)
    return manifest;
  const downloads: Partial<Record<InstallerOs, DownloadEntry>> = {};
  for (const { os, file, size } of input.installers) {
    if (os in downloads) throw new Error(`установщик ${os} повторяется`);
    checkFileName(file);
    downloads[os] = {
      url: `${baseUrl}/${input.version}/${file}`,
      ...(size === undefined ? {} : { size }),
    };
  }
  return { ...manifest, downloads };
};

/** Каким файлом обновляется каждая ОС (по имени артефакта сборки Tauri). */
const updaterSuffix: Record<UpdaterPlatform, string> = {
  "darwin-universal": ".app.tar.gz",
  "windows-x86_64": "-setup.exe",
  "linux-x86_64": ".AppImage",
};

const allPlatforms = Object.keys(updaterSuffix) as UpdaterPlatform[];

export type FoundUpdaterFile = {
  readonly platform: UpdaterPlatform;
  readonly path: string;
  readonly sigPath: string;
};

/**
 * Файлы обновления среди путей артефактов: по одному на платформу (`platforms` — подмножество,
 * по умолчанию все), у каждого рядом `<файл>.sig`. Нет файла, нет подписи или кандидатов
 * несколько — ошибка.
 */
export const findUpdaterFiles = (
  paths: ReadonlyArray<string>,
  platforms: ReadonlyArray<UpdaterPlatform> = allPlatforms,
): ReadonlyArray<FoundUpdaterFile> => {
  const all = new Set(paths);
  return allPlatforms
    .filter((platform) => platforms.includes(platform))
    .map((platform) => {
      const candidates = paths.filter((p) => p.endsWith(updaterSuffix[platform]));
      if (candidates.length !== 1)
        throw new Error(
          `${platform}: ожидался один файл *${updaterSuffix[platform]}, найдено ${candidates.length}`,
        );
      const path = candidates[0] as string;
      const sigPath = `${path}.sig`;
      if (!all.has(sigPath)) throw new Error(`${platform}: нет ${sigPath}`);
      return { platform, path, sigPath };
    });
};

/** Установщики для страницы: у macOS — `.dmg`, у Windows и Linux — те же файлы, что у updater. */
const installerSuffix: Record<InstallerOs, string> = {
  macos: ".dmg",
  windows: "-setup.exe",
  linux: ".AppImage",
};

export type FoundInstaller = { readonly os: InstallerOs; readonly path: string };

/** Установщики среди путей артефактов: нет — ОС пропускается (страница возьмёт ссылку updater), несколько — ошибка. */
export const findInstallers = (
  paths: ReadonlyArray<string>,
): ReadonlyArray<FoundInstaller> =>
  (Object.keys(installerSuffix) as InstallerOs[]).flatMap((os) => {
    const candidates = paths.filter((p) => p.endsWith(installerSuffix[os]));
    if (candidates.length > 1)
      throw new Error(
        `${os}: ожидался один файл *${installerSuffix[os]}, найдено ${candidates.length}`,
      );
    return candidates[0] === undefined ? [] : [{ os, path: candidates[0] }];
  });

const isPlatform = (value: string): value is UpdaterPlatform =>
  allPlatforms.includes(value as UpdaterPlatform);

/** Рекурсивный список файлов каталога, пути относительно него, с `/`. */
const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"),
    )
    .sort();
};

const usage = `Использование: bun manifest.ts --tag desktop-vX.Y.Z (или --version X.Y.Z) --dir <артефакты> --out <latest.json> --base-url <адрес> [--notes <текст> | --notes-file <файл>] [--pub-date <RFC 3339>] [--platforms <список через запятую>]`;

const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: "string" },
      version: { type: "string" },
      dir: { type: "string" },
      out: { type: "string" },
      "base-url": { type: "string" },
      notes: { type: "string" },
      "notes-file": { type: "string" },
      "pub-date": { type: "string" },
      platforms: { type: "string" },
    },
    strict: true,
  });
  const version = (values.version ?? values.tag)?.replace(/^desktop-v|^v/, "");
  const missing = [
    version === undefined ? "--tag или --version" : null,
    values.dir === undefined ? "--dir" : null,
    values.out === undefined ? "--out" : null,
    values["base-url"] === undefined ? "--base-url" : null,
  ].filter((name) => name !== null);
  if (
    missing.length > 0 ||
    version === undefined ||
    values.dir === undefined ||
    values.out === undefined ||
    values["base-url"] === undefined
  )
    throw new Error(`не хватает аргументов: ${missing.join(", ")}\n${usage}`);

  const platforms =
    values.platforms === undefined
      ? allPlatforms
      : values.platforms.split(",").map((p) => p.trim());
  const unknown = platforms.filter((p) => !isPlatform(p));
  if (unknown.length > 0)
    throw new Error(`неизвестные платформы: ${unknown.join(", ")}`);

  const allFiles = await listFiles(values.dir);
  const found = findUpdaterFiles(allFiles, platforms.filter(isPlatform));
  // Установщики — только ОС, чьи файлы обновления вошли в манифест.
  const osOf: Record<UpdaterPlatform, InstallerOs> = {
    "darwin-universal": "macos",
    "windows-x86_64": "windows",
    "linux-x86_64": "linux",
  };
  const published = new Set(found.map((f) => osOf[f.platform]));
  const installerFiles = findInstallers(allFiles).filter((i) =>
    published.has(i.os),
  );
  const installers: Installer[] = installerFiles.map(({ os, path }) => ({
    os,
    file: path.split("/").pop() as string,
    size: Bun.file(join(values.dir as string, path)).size,
  }));
  const files: ManifestFile[] = [];
  for (const { platform, path, sigPath } of found)
    files.push({
      platform,
      file: path.split("/").pop() as string,
      signature: await Bun.file(join(values.dir, sigPath)).text(),
    });

  const notes =
    values["notes-file"] !== undefined
      ? await Bun.file(values["notes-file"]).text()
      : (values.notes ?? "");
  const manifest = buildManifest({
    version,
    notes: notes.trim(),
    pubDate: values["pub-date"] ?? new Date().toISOString(),
    baseUrl: values["base-url"],
    files,
    installers,
  });
  await Bun.write(values.out, `${JSON.stringify(manifest, null, 2)}\n`);
  const uploads = new Set(
    found.flatMap(({ path, sigPath }) => [path, sigPath]),
  );
  for (const { path } of installerFiles) uploads.add(path);
  for (const path of uploads) console.log(path);
};

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
