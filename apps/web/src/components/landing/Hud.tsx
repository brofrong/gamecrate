// Геймерский HUD в секции «Технология»: FPS / FRAMETIME / LATENCY / BITRATE с мини-графиками.
// Цифры — иллюстрация (случайные в правдоподобных пределах), не чаще раза в 120 мс.
// В `driven`-режиме тики приходят от canvas-цикла секции (`ref.tick(time, boost)`), так что
// HUD живёт только пока секция видна и без reduced motion; сам по себе — своим интервалом.
// Без 2D-контекста (тесты) обновляется только текст.
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";

export type HudHandle = {
  /** Один тик цикла: `time` в мс, `boost` — добавка к задержке (курсор у вершины дуги). */
  tick: (time: number, boost?: number) => void;
};

const TICK_MS = 120;
const POINTS = 60;
const W = 220;
const H = 44;

type Key = "fps" | "ft" | "lat" | "br";
type Stat = {
  key: Key;
  label: string;
  color: string;
  min: number;
  max: number;
  format: (v: number) => string;
};

const STATS: ReadonlyArray<Stat> = [
  {
    key: "fps",
    label: "FPS",
    color: "#3ddc97",
    min: 40,
    max: 70,
    format: (v) => `${v}`,
  },
  {
    key: "ft",
    label: "FRAMETIME",
    color: "#3cc2ff",
    min: 10,
    max: 25,
    format: (v) => `${v.toFixed(1)} ms`,
  },
  {
    key: "lat",
    label: "LATENCY",
    color: "#3cc2ff",
    min: 0,
    max: 40,
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    key: "br",
    label: "BITRATE",
    color: "#ffd166",
    min: 0,
    max: 60,
    format: (v) => `${Math.round(v)} Mbps`,
  },
];

const sample = (boost: number): Record<Key, number> => {
  const fps = 58 + Math.round(Math.random() * 2.4);
  return {
    fps,
    ft: 1000 / fps + (Math.random() - 0.5),
    lat: 12 + Math.random() * 4 + boost,
    br: 34 + Math.random() * 7,
  };
};

const drawSeries = (
  canvas: HTMLCanvasElement | null,
  series: ReadonlyArray<number>,
  stat: Stat,
) => {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = (i / (POINTS - 1)) * W;
    const y = H - ((v - stat.min) / (stat.max - stat.min)) * (H - 4) - 2;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.strokeStyle = stat.color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(((series.length - 1) / (POINTS - 1)) * W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = `${stat.color}22`;
  ctx.fill();
};

export function Hud({
  driven = false,
  ref,
}: {
  /** Тики приходят снаружи через `ref.tick`; своего интервала нет. */
  driven?: boolean;
  ref?: Ref<HudHandle>;
}) {
  const reduced = usePrefersReducedMotion();
  const [values, setValues] = useState(() => sample(0));
  const lastTick = useRef(-Infinity);
  const seriesRef = useRef<Record<Key, number[]>>({
    fps: [],
    ft: [],
    lat: [],
    br: [],
  });
  const canvasRefs = useRef<Record<Key, HTMLCanvasElement | null>>({
    fps: null,
    ft: null,
    lat: null,
    br: null,
  });

  const tick = (time: number, boost = 0) => {
    if (time - lastTick.current < TICK_MS) return;
    lastTick.current = time;
    const next = sample(boost);
    for (const stat of STATS) {
      const s = seriesRef.current[stat.key];
      s.push(next[stat.key]);
      if (s.length > POINTS) s.shift();
      drawSeries(canvasRefs.current[stat.key], s, stat);
    }
    setValues(next);
  };
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useImperativeHandle(
    ref,
    () => ({ tick: (t, b) => tickRef.current(t, b) }),
    [],
  );

  useEffect(() => {
    if (driven || reduced) return;
    const timer = setInterval(
      () => tickRef.current(performance.now()),
      TICK_MS,
    );
    return () => clearInterval(timer);
  }, [driven, reduced]);

  return (
    <div className="pointer-events-none absolute top-0 left-0 grid gap-2 font-mono text-xs min-[860px]:min-w-[250px]">
      {STATS.map((stat) => (
        <div
          key={stat.key}
          className="grid grid-cols-[64px_54px_1fr] items-center gap-2.5 text-[#c9cdf0] min-[860px]:grid-cols-[78px_64px_1fr]"
        >
          <span className="text-[10px] tracking-[0.08em] text-brand-dim">
            {stat.label}
          </span>
          <span
            className="font-bold tabular-nums"
            style={{ color: stat.color }}
          >
            {stat.format(values[stat.key])}
          </span>
          <canvas
            ref={(el) => {
              canvasRefs.current[stat.key] = el;
            }}
            width={W}
            height={H}
            aria-hidden="true"
            className="block h-[22px] w-[70px] min-[860px]:w-[110px]"
          />
        </div>
      ))}
      <span className="text-[11px] text-brand-dim">иллюстрация</span>
    </div>
  );
}
