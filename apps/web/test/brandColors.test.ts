import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readBrandPalette } from "../src/lib/brandColors";

const SRC = new URL("../src", import.meta.url).pathname;
const css = await Bun.file(
  new URL("../src/styles.css", import.meta.url),
).text();

// Логотип GameCrate, ассеты бренда, данные витрин, сами токены и запасная палитра
// `readBrandPalette` (без DOM) — единственные места, где цвета GameCrate остаются литералами.
const SKIP = [
  "components/brand",
  "assets/brand",
  "brands",
  "styles.css",
  "lib/brandColors.ts",
];

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? walk(path) : [path];
  });

const sources = walk(SRC).filter((f) => {
  const rel = relative(SRC, f);
  return !SKIP.some((s) => rel === s || rel.startsWith(`${s}/`));
});

const HEX = /#3cc2ff|#3a6cff|#5b2fff/i;
// rgb()/rgba() и голые тройки `[60, 194, 255]` с цветами GameCrate.
const TRIPLE =
  /\b(60\s*,\s*194\s*,\s*255|58\s*,\s*108\s*,\s*255|91\s*,\s*47\s*,\s*255)\b/;

describe("brand colours", () => {
  it("no GameCrate accent literals outside tokens and logo", () => {
    expect(sources.length).toBeGreaterThan(50);
    const offenders = sources.filter((f) => {
      const text = readFileSync(f, "utf8");
      return HEX.test(text) || TRIPLE.test(text);
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("styles.css has the Beeline token block", () => {
    const block = css.match(/\[data-brand="beeline"\]\s*\{([^}]*)\}/);
    expect(block).not.toBeNull();
    expect(block?.[1]).toContain("--brand-accent: #ffc800");
    expect(block?.[1]).toContain("--brand-glow-rgb: 255 200 0");
    expect(block?.[1]).toContain("--brand-on-accent: #14161c");
  });

  it("styles.css keeps GameCrate values in :root", () => {
    expect(css).toContain("--brand-accent: #3cc2ff");
    expect(css).toContain("--brand-accent-2: #3a6cff");
    expect(css).toContain("--brand-accent-3: #5b2fff");
    expect(css).toContain("--brand-glow-rgb: 60 194 255");
    expect(css).toContain("--brand-on-accent: #ffffff");
  });
});

describe("readBrandPalette", () => {
  const props = [
    "--brand-accent",
    "--brand-accent-2",
    "--brand-accent-3",
    "--brand-glow-rgb",
    "--brand-accent-2-rgb",
    "--brand-accent-3-rgb",
  ];
  afterEach(() => {
    for (const p of props) document.documentElement.style.removeProperty(p);
  });

  it("falls back to the GameCrate palette without tokens", () => {
    const p = readBrandPalette();
    expect(p.accent).toBe("#3cc2ff");
    expect(p.accent2).toBe("#3a6cff");
    expect(p.accent3).toBe("#5b2fff");
    expect(p.glowRgb).toEqual([60, 194, 255]);
  });

  it("reads tokens from the document element", () => {
    const style = document.documentElement.style;
    style.setProperty("--brand-accent", "#ffc800");
    style.setProperty("--brand-glow-rgb", "255 200 0");
    style.setProperty("--brand-accent-2-rgb", "255 179 0");
    const p = readBrandPalette();
    expect(p.accent).toBe("#ffc800");
    expect(p.glowRgb).toEqual([255, 200, 0]);
    expect(p.accent2Rgb).toEqual([255, 179, 0]);
    // Не заданное остаётся значением GameCrate.
    expect(p.accent2).toBe("#3a6cff");
  });

  it("ignores a malformed rgb triple", () => {
    document.documentElement.style.setProperty("--brand-glow-rgb", "oops");
    expect(readBrandPalette().glowRgb).toEqual([60, 194, 255]);
  });
});
