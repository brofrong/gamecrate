// Палитра витрины для canvas/WebGL-кода: CSS-токены `--brand-*` (`:root` = GameCrate,
// `[data-brand="beeline"]` переопределяет) читаются один раз при монтировании.
// Без DOM (тесты, SSR) — палитра GameCrate.

type Rgb = [number, number, number];

export type BrandPalette = {
  accent: string;
  accent2: string;
  accent3: string;
  /** Акцент как `r g b` — для свечений с альфой. */
  glowRgb: Rgb;
  accent2Rgb: Rgb;
  accent3Rgb: Rgb;
  /** Промежуточные оттенки для кубиков и частиц (между акцентами). */
  mixRgb: [Rgb, Rgb, Rgb];
};

/** Значения `:root` из `styles.css`. */
const GAMECRATE: BrandPalette = {
  accent: "#3cc2ff",
  accent2: "#3a6cff",
  accent3: "#5b2fff",
  glowRgb: [60, 194, 255],
  accent2Rgb: [58, 108, 255],
  accent3Rgb: [91, 47, 255],
  mixRgb: [
    [80, 70, 230],
    [140, 90, 255],
    [40, 160, 240],
  ],
};

const parseRgb = (value: string, fallback: Rgb): Rgb => {
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [r, g, b] = parts;
  const ok =
    parts.length === 3 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  return ok ? [r as number, g as number, b as number] : fallback;
};

/** Читает токены из `getComputedStyle(document.documentElement)`; без DOM — палитра GameCrate. */
export const readBrandPalette = (): BrandPalette => {
  if (typeof document === "undefined") return GAMECRATE;
  const style = getComputedStyle(document.documentElement);
  const get = (name: string) => style.getPropertyValue(name).trim();
  const color = (name: string, fallback: string) => get(name) || fallback;
  const rgb = (name: string, fallback: Rgb) => parseRgb(get(name), fallback);
  return {
    accent: color("--brand-accent", GAMECRATE.accent),
    accent2: color("--brand-accent-2", GAMECRATE.accent2),
    accent3: color("--brand-accent-3", GAMECRATE.accent3),
    glowRgb: rgb("--brand-glow-rgb", GAMECRATE.glowRgb),
    accent2Rgb: rgb("--brand-accent-2-rgb", GAMECRATE.accent2Rgb),
    accent3Rgb: rgb("--brand-accent-3-rgb", GAMECRATE.accent3Rgb),
    mixRgb: [
      rgb("--brand-mix-1-rgb", GAMECRATE.mixRgb[0]),
      rgb("--brand-mix-2-rgb", GAMECRATE.mixRgb[1]),
      rgb("--brand-mix-3-rgb", GAMECRATE.mixRgb[2]),
    ],
  };
};
