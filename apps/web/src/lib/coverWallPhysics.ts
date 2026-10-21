// Физика стены обложек (чистые функции): ряды едут сами с базовой скоростью, ряд под
// курсором тормозит до полной остановки, отпущенный — плавно разгоняется обратно.
// Позиция ряда заворачивается по половине его ширины (ряд продублирован для петли).

export type RowMotion = { x: number; v: number; base: number };

/** Торможение ряда под курсором, 1/с. */
export const BRAKE_RATE = 3.5;
/** Разгон отпущенного ряда, 1/с. */
export const RESUME_RATE = 1.2;

/** Базовая скорость ряда `i`, px/с: нечётные едут вправо, чётные — влево. */
export const rowBaseSpeed = (i: number): number =>
  (i % 2 ? 1 : -1) * (26 + 5 * i);

export const initialRows = (count: number): RowMotion[] =>
  Array.from({ length: count }, (_, i) => ({
    x: 0,
    v: rowBaseSpeed(i),
    base: rowBaseSpeed(i),
  }));

/**
 * Один шаг: `held` — индекс ряда под курсором (или null), `dt` — секунды,
 * `halfWidth(i)` — половина ширины ряда в px (0, если ещё не измерен).
 */
export const stepRows = (
  rows: ReadonlyArray<RowMotion>,
  held: number | null,
  dt: number,
  halfWidth: (i: number) => number,
): RowMotion[] =>
  rows.map((row, i) => {
    const holding = held === i;
    const target = holding ? 0 : row.base;
    const k = holding ? BRAKE_RATE : RESUME_RATE;
    const v = row.v + (target - row.v) * Math.min(1, dt * k);
    let x = row.x + v * dt;
    const half = halfWidth(i);
    if (half > 0) {
      if (x <= -half) x += half;
      if (x > 0) x -= half;
    }
    return { x, v, base: row.base };
  });
