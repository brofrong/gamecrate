// Геометрия логотипа GameCrate — чистые функции без DOM.
// Источник чисел: docs/brand/prototypes/logo-morph.html (buildLogo). Координаты в боксе
// 200×220 (знак) и шире (лок-ап, ширина viewBox зависит от прогресса). Прогресс 0 — полный
// лок-ап (шестигранное кольцо + «GameCrate»), 1 — компактный GC-куб.

export type Matrix = readonly [number, number, number, number, number, number];
export type Point = readonly [number, number];
export type LogoMetrics = { ameWidth: number; rateWidth: number };

/** Изометрические грани: локальные координаты 0..100 → бокс знака. */
export const LEFT_FACE: Matrix = [0.866, 0.5, 0, 1, 13.4, 60];
export const RIGHT_FACE: Matrix = [0.866, -0.5, 0, 1, 100, 110];

/** Блочные буквы в боксе 100×100, штрих 24 — те же фигуры стоят и в названии, и на гранях. */
export const G_POINTS: ReadonlyArray<Point> = [
  [0, 0],
  [100, 0],
  [100, 24],
  [24, 24],
  [24, 76],
  [76, 76],
  [76, 62],
  [50, 62],
  [50, 40],
  [100, 40],
  [100, 100],
  [0, 100],
];
export const C_POINTS: ReadonlyArray<Point> = [
  [0, 0],
  [100, 0],
  [100, 24],
  [24, 24],
  [24, 76],
  [100, 76],
  [100, 100],
  [0, 100],
];

/** Верхняя полоса: кольцо (полный лок-ап) → «крыша» над буквами (компакт). Вершины попарно. */
export const TOP_RING: ReadonlyArray<Point> = [
  [13.4, 60],
  [100, 10],
  [186.6, 60],
  [166.9, 71.4],
  [100, 32.75],
  [33.1, 71.4],
];
export const TOP_ROOF: ReadonlyArray<Point> = [
  [13.4, 60],
  [100, 10],
  [186.6, 60],
  [166.0, 70.9],
  [100, 32.8],
  [34.0, 70.9],
];
/** Боковые полосы кольца; растворяются, когда буквы встают на грани. */
export const LEFT_BAND =
  "13.4,60 33.1,71.4 33.1,148.6 100,187.25 100,210 13.4,160";
export const RIGHT_BAND =
  "186.6,60 186.6,160 100,210 100,187.25 166.9,148.6 166.9,71.4";
/** Швы между гранями (рисуются чёрным в маске). */
export const SEAMS = "M100 110L13.4 60M100 110L186.6 60M100 110L100 210";

export const MARK_WIDTH = 200;
export const BOX_HEIGHT = 220;
export const WORD_X = 232;
export const BASELINE_Y = 146;
export const CAP_HEIGHT = 70;
export const LETTER_GAP = 5;
export const C_WIDTH = 0.86;
export const FONT_SIZE = 96;
export const TAG_FONT_SIZE = 30;
export const TAG_Y = 190;

/** Ширины «ame» и «rate» (Inter 800, 96px) до измерения шрифта. */
export const DEFAULT_METRICS: LogoMetrics = { ameWidth: 166, rateWidth: 188 };

export const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scale = (k: number): Matrix => [k, 0, 0, k, 0, 0];
export const lerpMatrix = (a: Matrix, b: Matrix, t: number): Matrix => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
  a[3] + (b[3] - a[3]) * t,
  a[4] + (b[4] - a[4]) * t,
  a[5] + (b[5] - a[5]) * t,
];
export const matrixString = (m: Matrix): string =>
  `matrix(${m.map((v) => v.toFixed(4)).join(" ")})`;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const easeInOut = (p: number): number =>
  p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;

export const polygonPath = (points: ReadonlyArray<Point>): string =>
  `${points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("")}Z`;

export const fullWidth = (m: LogoMetrics): number =>
  WORD_X +
  CAP_HEIGHT +
  LETTER_GAP +
  m.ameWidth +
  LETTER_GAP +
  CAP_HEIGHT * C_WIDTH +
  LETTER_GAP +
  m.rateWidth +
  8;

export type LogoFrame = {
  viewBoxWidth: number;
  gTransform: string;
  cTransform: string;
  gPath: string;
  cPath: string;
  topPoints: string;
  topSeamPath: string;
  bandOpacity: number;
  ame: { x: number; y: number; opacity: number };
  rate: { x: number; y: number; opacity: number };
  tag: { x: number; y: number; opacity: number };
};

/** Положение буквы на грани: отступ 2.5 от края, масштаб 0.95 — чтобы остался шов. */
const onFace = (face: Matrix) =>
  multiply(face, multiply(translate(2.5, 2.5), scale(0.95)));

/** Кадр логотипа для прогресса 0..1 (0 — полный лок-ап, 1 — компактный знак). */
export const logoFrame = (
  progress: number,
  metrics: LogoMetrics,
): LogoFrame => {
  const e = easeInOut(clamp01(progress));
  const k = CAP_HEIGHT / 100;
  const xG = WORD_X;
  const xAme = xG + CAP_HEIGHT + LETTER_GAP;
  const xC = xAme + metrics.ameWidth + LETTER_GAP;
  const xRate = xC + CAP_HEIGHT * C_WIDTH + LETTER_GAP;
  const top = BASELINE_Y - CAP_HEIGHT;

  const gText = multiply(translate(xG, top), scale(k));
  const cText = multiply(translate(xC, top), [k * C_WIDTH, 0, 0, k, 0, 0]);
  const topPoints = TOP_RING.map(([x, y], i) => {
    const [rx, ry] = TOP_ROOF[i] as Point;
    return [x + (rx - x) * e, y + (ry - y) * e] as const;
  });
  const [seamX, seamY] = topPoints[4] as Point;
  const wordOpacity = clamp01(1 - e * 1.6);

  return {
    viewBoxWidth: MARK_WIDTH + (fullWidth(metrics) - MARK_WIDTH) * (1 - e),
    gTransform: matrixString(lerpMatrix(gText, onFace(LEFT_FACE), e)),
    cTransform: matrixString(lerpMatrix(cText, onFace(RIGHT_FACE), e)),
    gPath: polygonPath(G_POINTS),
    cPath: polygonPath(C_POINTS),
    topPoints: topPoints
      .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
      .join(" "),
    topSeamPath: `M100 10L${seamX.toFixed(2)} ${seamY.toFixed(2)}`,
    bandOpacity: 1 - clamp01((e - 0.45) / 0.45),
    ame: { x: xAme - 60 * e, y: BASELINE_Y, opacity: wordOpacity },
    rate: { x: xRate - 60 * e, y: BASELINE_Y, opacity: wordOpacity },
    tag: { x: WORD_X - 60 * e, y: TAG_Y, opacity: wordOpacity },
  };
};
