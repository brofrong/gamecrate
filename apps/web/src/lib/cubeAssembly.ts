// Чистая модель сборки изометрического куба 3×3×3 для сцены на странице входа: без
// DOM/canvas — только уровень сборки по состоянию формы, 27 кубиков с детерминированным
// порядком и их целевые позиции (дома или в дрейфе).
import { type BrandPalette, readBrandPalette } from "./brandColors";

export type Level = 0 | 1 | 2;

export interface FormState {
  readonly email: string;
  readonly codeLength: number;
  readonly submitted: boolean;
}

export const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Уровень сборки: 2 — код введён/отправлено, 1 — похоже на почту, иначе 0. */
export const assemblyLevel = (s: FormState): Level => {
  if (s.submitted || s.codeLength >= 6) return 2;
  if (EMAIL_LIKE.test(s.email)) return 1;
  return 0;
};

/** Сколько кубиков стоят «дома» на каждом уровне сборки. */
export const HOME_COUNT: Record<Level, number> = { 0: 9, 1: 18, 2: 27 };

export interface Cube {
  readonly i: number;
  readonly j: number;
  readonly k: number;
  readonly fx: number;
  readonly fy: number;
  readonly phase: number;
  readonly color: readonly [number, number, number];
  x: number;
  y: number;
}

/** Цвета кубиков — палитра витрины (`readBrandPalette()`), четыре оттенка по кругу. */
export const cubePalette = (
  p: BrandPalette,
): ReadonlyArray<readonly [number, number, number]> => [
  p.glowRgb,
  p.accent2Rgb,
  p.accent3Rgb,
  p.mixRgb[0],
];

/** 27 кубиков 3×3×3, порядок — по возрастанию `i+j+k` (нижний слой первым). */
export const makeCubes = (
  random: () => number,
  palette: BrandPalette = readBrandPalette(),
): Cube[] => {
  const colors = cubePalette(palette);
  const cubes: Cube[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        cubes.push({
          i,
          j,
          k,
          fx: (random() - 0.5) * 520,
          fy: (random() - 0.5) * 420,
          phase: random() * 6,
          color: colors[(i + j + k) % 4] as readonly [number, number, number],
          x: 0,
          y: 0,
        });
  return cubes.sort(
    (a, b) =>
      a.i + a.j + a.k - (b.i + b.j + b.k) ||
      a.i - b.i ||
      a.j - b.j ||
      a.k - b.k,
  );
};

/** Позиция «дома» — изометрическая проекция (i,j,k) вокруг центра (cx,cy). */
export const homePosition = (
  c: Cube,
  cx: number,
  cy: number,
  s: number,
): { x: number; y: number } => ({
  x: cx + (c.i - c.j) * s,
  y: cy + (c.i + c.j) * (s / 2) - c.k * s,
});

/**
 * Целевая позиция кубика `index` (в отсортированном порядке `makeCubes`) на уровне
 * `level`: «дома» по `homePosition`, иначе — в дрейфующем облаке (±fx/±fy от центра,
 * со смещением по синусоиде, если `drift`).
 */
export const targetPosition = (
  c: Cube,
  index: number,
  level: Level,
  cx: number,
  cy: number,
  s: number,
  t: number,
  drift: boolean,
): { x: number; y: number; home: boolean } => {
  const home = index < HOME_COUNT[level];
  if (home) {
    const { x, y } = homePosition(c, cx, cy, s);
    return { x, y, home };
  }
  const x = cx + c.fx + (drift ? Math.sin(t / 900 + c.phase) * 14 : 0);
  const y = cy - 60 + c.fy + (drift ? Math.cos(t / 1100 + c.phase) * 14 : 0);
  return { x, y, home };
};

/** Шаг плавного приближения `cur` к `target` на долю `k` (по умолчанию 6%). */
export const approach = (cur: number, target: number, k = 0.06): number =>
  cur + (target - cur) * k;

export const PROVIDER_TINT: Record<
  "yandex" | "google" | "telegram",
  readonly [number, number, number]
> = {
  yandex: [252, 63, 29],
  google: [66, 133, 244],
  telegram: [41, 169, 235],
};

export const STEP_LABELS = ["учётка", "код", "облако"] as const;

export const CAPTIONS: Record<Level, string> = {
  0: "Твоё облако собирается",
  1: "Почти готово…",
  2: "Облако собрано. Поехали!",
};
