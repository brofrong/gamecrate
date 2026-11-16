// ОС посетителя для страницы «Скачать». Приложение есть для Windows, macOS и Linux; телефоны
// и всё неопознанное — `null` (страница тогда показывает все три сборки равноправно).

export type DesktopOs = "windows" | "macos" | "linux";

export type NavigatorLike = {
  readonly userAgent: string;
  /** Client Hints (Chromium): надёжнее User-Agent, который браузеры замораживают. */
  readonly userAgentData?: { readonly platform?: string };
};

const fromPlatform = (platform: string): DesktopOs | null => {
  const name = platform.trim().toLowerCase();
  if (name === "windows") return "windows";
  if (name === "macos") return "macos";
  if (name === "linux") return "linux";
  return null;
};

export const detectOs = (
  nav: NavigatorLike | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): DesktopOs | null => {
  if (nav === undefined) return null;
  const platform = nav.userAgentData?.platform;
  if (typeof platform === "string" && platform !== "") return fromPlatform(platform);
  const agent = nav.userAgent;
  // Android и ChromeOS в User-Agent тоже «Linux», а iOS — «like Mac OS X».
  if (/android|iphone|ipad|ipod|cros/i.test(agent)) return null;
  if (/windows/i.test(agent)) return "windows";
  if (/macintosh|mac os x/i.test(agent)) return "macos";
  if (/linux/i.test(agent)) return "linux";
  return null;
};
