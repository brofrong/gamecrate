/**
 * Данные партнёрских витрин (брендов) и выбор бренда по хосту запроса.
 * Используется и в apps/api, и в apps/web — без зависимостей.
 */

export type BrandId = "gamecrate" | "beeline";

export const BRAND_IDS: readonly BrandId[] = ["gamecrate", "beeline"];

export const DEFAULT_BRAND: BrandId = "gamecrate";

export type BrandMeta = {
  readonly id: BrandId;
  /** Название бренда — в тексты и письма. */
  readonly name: string;
  /** <title> и og:title. */
  readonly title: string;
  /** meta description и og:description. */
  readonly description: string;
  /** meta theme-color. */
  readonly themeColor: string;
  /** Пути favicon/apple-touch-icon в dist; `null` — оставить из шаблона index.html. */
  readonly icons: { readonly favicon: string; readonly appleTouchIcon: string } | null;
};

const DESCRIPTION =
  "Твоя библиотека Steam на облачной видеокарте. В браузере, на ПК или с телефона — без установки и без мощного железа.";

export const BRANDS: Readonly<Record<BrandId, BrandMeta>> = {
  gamecrate: {
    id: "gamecrate",
    name: "GameCrate",
    title: "GameCrate — облачный гейминг",
    description: DESCRIPTION,
    themeColor: "#05060f",
    icons: null,
  },
  beeline: {
    id: "beeline",
    name: "билайн",
    title: "билайн — облачный гейминг",
    description: DESCRIPTION,
    themeColor: "#28303f",
    icons: {
      favicon: "/brands/beeline/favicon.svg",
      appleTouchIcon: "/brands/beeline/apple-touch-icon.png",
    },
  },
};

export const isBrandId = (value: string): value is BrandId =>
  (BRAND_IDS as readonly string[]).includes(value);

/**
 * `"a.ru=beeline, b.ru=gamecrate"` → Map(host→id); хосты в нижнем регистре;
 * неизвестный id или строка без `=` — ошибка (Error с текстом пары), пустая строка — пустая Map.
 */
export const parseBrandHosts = (value: string): ReadonlyMap<string, BrandId> => {
  const map = new Map<string, BrandId>();
  const trimmed = value.trim();
  if (trimmed === "") {
    return map;
  }
  for (const rawPair of trimmed.split(",")) {
    const pair = rawPair.trim();
    if (pair === "") {
      continue;
    }
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(pair);
    }
    const host = pair.slice(0, eqIndex).trim().toLowerCase();
    const id = pair.slice(eqIndex + 1).trim();
    if (!isBrandId(id)) {
      throw new Error(pair);
    }
    map.set(host, id);
  }
  return map;
};

/** Хост без порта, в нижнем регистре (`"Play.X.ru:443"` → `"play.x.ru"`). */
export const normalizeHost = (host: string): string => host.trim().toLowerCase().split(":")[0] ?? "";

/** Хост без порта; `<id>.localhost` → id; иначе по карте; иначе DEFAULT_BRAND. */
export const brandForHost = (
  host: string | undefined,
  hosts: ReadonlyMap<string, BrandId>,
): BrandId => {
  if (host === undefined) {
    return DEFAULT_BRAND;
  }
  const normalized = normalizeHost(host);
  const localhostMatch = normalized.match(/^([^.]+)\.localhost$/);
  if (localhostMatch) {
    const [, candidate] = localhostMatch;
    if (candidate !== undefined && isBrandId(candidate)) {
      return candidate;
    }
  }
  return hosts.get(normalized) ?? DEFAULT_BRAND;
};
