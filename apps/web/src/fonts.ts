// Шрифты бренда из @fontsource-variable, только нужные подмножества (latin + cyrillic у Inter,
// latin у моноширинного): `@import` пакета в CSS тянет все подмножества, а url() Bun инлайнит
// base64 прямо в CSS (~0.5 МБ, блокирует первую отрисовку). Импорт woff2 здесь даёт отдельный
// файл с хэшем и в dev, и в сборке; регистрируем через FontFace до первого рендера.
import interCyrillic from "@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2";
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2";
import monoLatin from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2";

const latin =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const cyrillic = "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116";

/** Имена семейств — те же, что в `--font-sans` / `--font-mono` в styles.css. */
export const brandFonts: ReadonlyArray<{
  family: string;
  url: string;
  unicodeRange: string;
  weight: string;
}> = [
  {
    family: "Inter Variable",
    url: interLatin,
    unicodeRange: latin,
    weight: "100 900",
  },
  {
    family: "Inter Variable",
    url: interCyrillic,
    unicodeRange: cyrillic,
    weight: "100 900",
  },
  {
    family: "JetBrains Mono Variable",
    url: monoLatin,
    unicodeRange: latin,
    weight: "100 800",
  },
];

/** Регистрирует шрифты бренда; без FontFace API (тесты, старые браузеры) — системный шрифт. */
export function loadBrandFonts(): void {
  if (typeof FontFace === "undefined" || typeof document === "undefined")
    return;
  for (const font of brandFonts) {
    const face = new FontFace(
      font.family,
      `url(${font.url}) format("woff2-variations")`,
      {
        unicodeRange: font.unicodeRange,
        weight: font.weight,
        display: "swap",
      },
    );
    document.fonts.add(face);
    void face.load().catch(() => {});
  }
}
