// Статические версии логотипа из компонента `Logo`: SVG-лок-апы, SVG-знак, фавиконка и
// PNG-иконки (apple-touch-icon 180, icon-512). Запуск: `bun run brand-assets`.
// Шрифт в автономных SVG — `Inter` по имени (CSS-переменной там нет); PNG рендерятся
// только из знака (без текста), поэтому шрифты resvg не нужны.
import { mkdir } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { renderToStaticMarkup } from "react-dom/server";
import { Logo, type LogoProps } from "../src/components/brand/Logo";
import {
  BOX_HEIGHT,
  DEFAULT_METRICS,
  MARK_WIDTH,
} from "../src/components/brand/logo-geometry";

const outDir = new URL("../src/assets/brand/", import.meta.url);
const BG = "#05060f";
const PADDING = 0.12;

/** Автономный SVG: xmlns, шрифт по имени, id без символов React (`«r0»`). */
const standalone = (props: LogoProps): string =>
  renderToStaticMarkup(
    <Logo height={BOX_HEIGHT} metrics={DEFAULT_METRICS} {...props} />,
  )
    .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')
    .replace(/font-family:var\(--font-sans\)/g, "font-family:Inter,sans-serif")
    .replace(
      /(id="|url\(#)([^")]+)/g,
      (_, p, id: string) => `${p}${id.replace(/[^A-Za-z0-9_-]/g, "")}`,
    );

/** Знак на тёмном квадрате `size`×`size` с отступом 12 %. */
const squareIcon = (mark: string, size: number): string => {
  const inner = mark.slice(mark.indexOf(">") + 1, mark.lastIndexOf("</svg>"));
  const pad = size * PADDING;
  const k = (size - 2 * pad) / BOX_HEIGHT;
  const x = (size - MARK_WIDTH * k) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${BG}"/>` +
    `<g transform="translate(${x.toFixed(2)} ${pad.toFixed(2)}) scale(${k.toFixed(4)})">${inner}</g></svg>`
  );
};

const png = (svg: string): Uint8Array =>
  new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng();

await mkdir(outDir, { recursive: true });

const mark = standalone({ progress: 1, iconOnly: true });
const files: Record<string, string | Uint8Array> = {
  "logo-full.svg": standalone({ progress: 0 }),
  "logo-full-light.svg": standalone({ progress: 0, light: true }),
  "logo-mark.svg": mark,
  "favicon.svg": standalone({ progress: 0, iconOnly: true }),
  "apple-touch-icon.png": png(squareIcon(mark, 180)),
  "icon-512.png": png(squareIcon(mark, 512)),
};

for (const [name, data] of Object.entries(files)) {
  await Bun.write(new URL(name, outDir), data);
  console.log(`${name}  ${(data.length / 1024).toFixed(1)} KB`);
}
