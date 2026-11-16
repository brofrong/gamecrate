// Разбор `latest.json` (манифест updater Tauri, его раздаёт API: `/download/desktop/latest.json`)
// для страницы «Скачать»: версия и ссылки на установщики по ОС. Установщики лежат в нашем поле
// `downloads` (у macOS это `.dmg`); нет его — берём ссылки updater из `platforms`.
import type { DesktopOs } from "./detectOs";

export type DesktopDownload = { readonly url: string; readonly size?: number };

export type Release = {
  readonly version: string;
  readonly downloads: Readonly<Partial<Record<DesktopOs, DesktopDownload>>>;
};

/** Ключи `platforms` updater, откуда берётся ссылка, если `downloads` её не дал. */
const updaterKeys: Record<DesktopOs, ReadonlyArray<string>> = {
  windows: ["windows-x86_64"],
  macos: ["darwin-aarch64", "darwin-x86_64"],
  linux: ["linux-x86_64"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Только путь на нашем сайте или http(s): `javascript:` и прочее в `href` не попадает. */
const safeUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : null;
  } catch {
    return null;
  }
};

const entry = (value: unknown): DesktopDownload | null => {
  if (!isRecord(value)) return null;
  const url = safeUrl(value.url);
  if (url === null) return null;
  const size = value.size;
  return typeof size === "number" && Number.isFinite(size) && size > 0
    ? { url, size }
    : { url };
};

export const parseRelease = (json: unknown): Release | null => {
  if (!isRecord(json) || typeof json.version !== "string" || json.version === "")
    return null;
  const downloads = isRecord(json.downloads) ? json.downloads : {};
  const platforms = isRecord(json.platforms) ? json.platforms : {};
  const result: Partial<Record<DesktopOs, DesktopDownload>> = {};
  for (const os of ["windows", "macos", "linux"] as const) {
    const found =
      entry(downloads[os]) ??
      updaterKeys[os].map((key) => entry(platforms[key])).find((e) => e !== null) ??
      null;
    if (found !== null) result[os] = found;
  }
  return { version: json.version, downloads: result };
};

/** «80 МБ», «1,2 ГБ» (двоичные приставки, как показывают файловые менеджеры). */
export const formatSize = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "меньше 1 МБ";
  if (mb < 1024) return `${Math.round(mb)} МБ`;
  return `${(mb / 1024).toFixed(1).replace(".", ",")} ГБ`;
};
