// График за последнюю минуту для отладочной плашки (спека §3): тонкая голубая линия, пунктир на
// p95, жёлтые точки над порогом; наведение — вертикальная черта у ближайшей точки и подпись
// «значение · N с назад». Ось x — время в окне `STATS_WINDOW_MS`, y — от 0 до максимума ряда.
import { type PointerEvent, useState } from "react";
import { percentiles, type Point, STATS_WINDOW_MS } from "@/lib/streamStats";

/** Число для плашки: до одного знака после запятой по-русски; нет значения/не число — «—». */
export function formatStat(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })
    : "—";
}

/** Размер графика в px (под ширину подробной плашки). */
const WIDTH = 328;
const HEIGHT = 32;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** x точки: левый край — `now − STATS_WINDOW_MS`, правый — `now`. */
const xAt = (at: number, now: number, width: number): number =>
  round2(((at - (now - STATS_WINDOW_MS)) / STATS_WINDOW_MS) * width);

/** y значения: низ — 0, верх — максимум ряда (ряд из нулей — по низу). */
const yAt = (value: number, max: number, height: number): number =>
  max > 0 ? round2(height - (value / max) * height) : height;

/**
 * Геометрия графика: ломаная по точкам ряда, высота пунктира p95 и точки строго выше `threshold`
 * (без порога — без точек). Пустой ряд — без линии и пунктира.
 */
export function sparklineGeometry(
  points: ReadonlyArray<Point>,
  now: number,
  size: { width: number; height: number },
  threshold?: number,
): {
  path: string;
  p95Y: number | null;
  dots: ReadonlyArray<{ x: number; y: number; point: Point }>;
} {
  const values = points.map((point) => point.value);
  const stats = percentiles(values);
  if (stats === null) return { path: "", p95Y: null, dots: [] };
  const { width, height } = size;
  const yOf = (value: number): number => yAt(value, stats.max, height);

  const path = points
    .map(
      (point, i) =>
        `${i === 0 ? "M" : "L"}${xAt(point.at, now, width)},${yOf(point.value)}`,
    )
    .join("");
  const dots =
    threshold === undefined
      ? []
      : points
          .filter((point) => point.value > threshold)
          .map((point) => ({
            x: xAt(point.at, now, width),
            y: yOf(point.value),
            point,
          }));
  return { path, p95Y: yOf(stats.p95), dots };
}

/** Ближайшая по времени к `at` точка ряда (ряд не пуст). */
const nearest = (points: ReadonlyArray<Point>, at: number): Point =>
  points.reduce((best, point) =>
    Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best,
  );

export function Sparkline({
  label,
  unit,
  points,
  now,
  threshold,
}: {
  label: string;
  unit: string;
  points: ReadonlyArray<Point>;
  /** Момент снимка на часах страницы — правый край графика. */
  now: number;
  /** Значения выше — жёлтые точки. */
  threshold?: number;
}) {
  // Доля ширины под указателем (0…1): ближайшая точка пересчитывается на каждом снимке —
  // ряд едет под неподвижным указателем, подпись остаётся честной.
  const [pointerShare, setPointerShare] = useState<number | null>(null);
  const geometry = sparklineGeometry(
    points,
    now,
    { width: WIDTH, height: HEIGHT },
    threshold,
  );
  const last = points.at(-1);
  const hovered =
    pointerShare === null || points.length === 0
      ? null
      : nearest(points, now - STATS_WINDOW_MS * (1 - pointerShare));

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const share = (event.clientX - rect.left) / rect.width;
    setPointerShare(Math.min(1, Math.max(0, share)));
  };

  const caption =
    hovered !== null
      ? `${formatStat(hovered.value)} ${unit} · ${Math.max(0, Math.round((now - hovered.at) / 1_000))} с назад`
      : `${formatStat(last?.value)} ${unit}`;
  const hoveredX = hovered === null ? null : xAt(hovered.at, now, WIDTH);
  const hoveredY =
    hovered === null
      ? null
      : yAt(
          hovered.value,
          Math.max(...points.map((point) => point.value)),
          HEIGHT,
        );

  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-brand-muted">{label}</span>
        <span>{caption}</span>
      </div>
      <svg
        role="img"
        aria-label={label}
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="pointer-events-auto block overflow-visible"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setPointerShare(null)}
      >
        <line
          x1={0}
          x2={WIDTH}
          y1={HEIGHT}
          y2={HEIGHT}
          className="stroke-brand-line"
          strokeWidth={1}
        />
        {geometry.p95Y !== null && (
          <line
            x1={0}
            x2={WIDTH}
            y1={geometry.p95Y}
            y2={geometry.p95Y}
            className="stroke-brand-muted"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        <path
          d={geometry.path}
          fill="none"
          className="stroke-brand-cyan"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {geometry.dots.map(({ x, y, point }) => (
          <circle
            key={point.at}
            cx={x}
            cy={y}
            r={2.5}
            className="fill-brand-warn stroke-black/70"
            strokeWidth={1}
          />
        ))}
        {hoveredX !== null && hoveredY !== null && (
          <>
            <line
              x1={hoveredX}
              x2={hoveredX}
              y1={0}
              y2={HEIGHT}
              className="stroke-brand-text/40"
              strokeWidth={1}
            />
            <circle
              cx={hoveredX}
              cy={hoveredY}
              r={3}
              className="fill-brand-cyan stroke-black/70"
              strokeWidth={1}
            />
          </>
        )}
      </svg>
    </div>
  );
}
