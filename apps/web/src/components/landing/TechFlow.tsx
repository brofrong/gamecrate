// Секция «Технология»: сцена на canvas без рамки — слева дата-центр (стопки изометрических
// контейнеров), справа устройство с «игрой», между ними поток частиц по дуге. Частицы
// тянутся к курсору, сама дуга не двигается. Сверху слева — HUD, снизу — три заметки.
import { useCallback, useRef, useState } from "react";
import {
  type CanvasSize,
  type DrawFrame,
  useCanvasLoop,
} from "@/lib/useCanvasLoop";
import { techNotes } from "./data";
import { Hud, type HudHandle } from "./Hud";

type Rgb = readonly [number, number, number];
type Particle = {
  p: number;
  off: number;
  sp: number;
  col: Rgb;
  sz: number;
  tw: number;
  dx: number;
  dy: number;
};
type Cursor = { x: number; y: number; inside: boolean };
type Anchors = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  labelA: number;
  labelB: number;
};

const PALETTE: ReadonlyArray<Rgb> = [
  [60, 194, 255],
  [58, 108, 255],
  [91, 47, 255],
  [140, 90, 255],
  [40, 160, 240],
];
const PARTICLES = 600;
const ATTRACT_RADIUS = 220;
const GLOW_RADIUS = 120;

const makeParticles = (): Particle[] =>
  Array.from({ length: PARTICLES }, (_, i) => ({
    p: Math.random(),
    off: (Math.random() - 0.5) * 120,
    sp: 0.0016 + Math.random() * 0.0022,
    col: PALETTE[i % PALETTE.length] as Rgb,
    sz: 1.5 + Math.random() * 2.5,
    tw: Math.random() * 6,
    dx: 0,
    dy: 0,
  }));

const rgb = (c: Rgb, k = 1) =>
  `rgb(${(c[0] * k) | 0},${(c[1] * k) | 0},${(c[2] * k) | 0})`;

/** Изометрический кубик: верх, левая и правая грани, рёбра. */
const cube = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  col: Rgb,
  alpha: number,
) => {
  const h = s * 0.5;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(x, y - h);
  ctx.lineTo(x + s, y - h * 1.5);
  ctx.lineTo(x, y - h * 2);
  ctx.lineTo(x - s, y - h * 1.5);
  ctx.closePath();
  ctx.fillStyle = rgb(col);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - s, y - h * 1.5);
  ctx.lineTo(x, y - h);
  ctx.lineTo(x, y);
  ctx.lineTo(x - s, y - h * 0.5);
  ctx.closePath();
  ctx.fillStyle = `rgb(${(col[0] * 0.6) | 0},${(col[1] * 0.6) | 0},${(col[2] * 0.7) | 0})`;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + s, y - h * 1.5);
  ctx.lineTo(x, y - h);
  ctx.lineTo(x, y);
  ctx.lineTo(x + s, y - h * 0.5);
  ctx.closePath();
  ctx.fillStyle = `rgb(${(col[0] * 0.4) | 0},${(col[1] * 0.4) | 0},${(col[2] * 0.55) | 0})`;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - s, y - h * 1.5);
  ctx.lineTo(x, y - h);
  ctx.lineTo(x + s, y - h * 1.5);
  ctx.moveTo(x, y - h);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
};

const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

const anchorsFor = ({ width: W, height: H }: CanvasSize): Anchors => {
  const narrow = W < 760;
  const ax = narrow ? W * 0.2 : W * 0.22;
  const ay = H * 0.56;
  const s = narrow ? 24 * (2 / 3) : 24;
  const bh = narrow ? 112 : 188;
  return {
    ax,
    ay,
    bx: W * 0.72,
    by: ay,
    labelA: ay + s * 1.1 + s * 3.2,
    labelB: ay + bh / 2 + 30,
  };
};

export const drawTechFlow = (
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  t: number,
  cursor: Cursor,
  parts: Particle[],
): number => {
  const { width: W, height: H } = size;
  const narrow = W < 760;
  const { ax, ay, bx, by } = anchorsFor(size);
  const cx = (ax + bx) / 2;
  const cy = ay - 120;
  ctx.clearRect(0, 0, W, H);

  // Луч.
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cx, cy, bx, by);
  ctx.strokeStyle = "rgba(60,120,255,0.06)";
  ctx.lineWidth = 110;
  ctx.stroke();

  // Частицы на дуге + притяжение к курсору.
  for (const p of parts) {
    p.p += p.sp;
    if (p.p > 1) {
      p.p -= 1;
      p.dx = 0;
      p.dy = 0;
    }
    const u = p.p;
    const x = (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * cx + u * u * bx;
    const y = (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * cy + u * u * by;
    const tx = 2 * (1 - u) * (cx - ax) + 2 * u * (bx - cx);
    const ty = 2 * (1 - u) * (cy - ay) + 2 * u * (by - cy);
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const spread = Math.sin(u * Math.PI);
    let px = x + nx * p.off * spread;
    let py = y + ny * p.off * spread;
    if (cursor.inside) {
      const ddx = cursor.x - (px + p.dx);
      const ddy = cursor.y - (py + p.dy);
      const d = Math.hypot(ddx, ddy);
      if (d < ATTRACT_RADIUS && d > 0) {
        const f = (1 - d / ATTRACT_RADIUS) * 0.9;
        p.dx += (ddx / d) * f * 3;
        p.dy += (ddy / d) * f * 3;
      }
    }
    p.dx *= 0.93;
    p.dy *= 0.93;
    px += p.dx;
    py += p.dy;
    const near = cursor.inside
      ? Math.max(0, 1 - Math.hypot(cursor.x - px, cursor.y - py) / GLOW_RADIUS)
      : 0;
    const a = (0.2 + spread * 0.8) * (0.6 + 0.4 * Math.sin(t / 300 + p.tw));
    ctx.fillStyle = `rgba(${(p.col[0] + near * 120) | 0},${(p.col[1] + near * 60) | 0},255,${Math.min(1, a + near * 0.5)})`;
    ctx.fillRect(px, py, p.sz + near * 1.5, p.sz + near * 1.5);
  }

  // Дата-центр: стопки контейнеров.
  const s = narrow ? 16 : 24;
  const base = ay + s * 1.1;
  const stackColors: ReadonlyArray<Rgb> = [
    [60, 194, 255],
    [58, 108, 255],
    [91, 47, 255],
    [80, 70, 230],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const x = ax + (i - j) * s;
      const y = base + (i + j) * s * 0.5;
      const height = 1 + ((i * 3 + j) % 3);
      for (let k = 0; k < height; k++) {
        const pulse = 0.75 + 0.25 * Math.sin(t / 600 + i + j + k);
        cube(ctx, x, y - k * s, s, stackColors[(i + j + k) % 4] as Rgb, pulse);
      }
    }
  }
  const glow = ctx.createRadialGradient(ax, ay, 0, ax, ay, 200);
  glow.addColorStop(0, "rgba(60,194,255,0.18)");
  glow.addColorStop(1, "rgba(60,194,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(ax - 200, ay - 200, 400, 400);

  // Устройство: ноутбук с «игрой» и телефон рядом.
  const bw = narrow ? 180 : 300;
  const bh = narrow ? 112 : 188;
  ctx.save();
  ctx.translate(bx - bw / 2, by - bh / 2);
  const tilt = cursor.inside
    ? ((cursor.x - bx) / W) * 0.06
    : Math.sin(t / 2000) * 0.015;
  ctx.transform(1, tilt * 0.25, -tilt, 1, 0, 0);
  ctx.shadowColor = "rgba(58,108,255,0.35)";
  ctx.shadowBlur = 40;
  roundRect(ctx, 0, 0, bw, bh, 12);
  ctx.fillStyle = "#10132a";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.stroke();
  const screen = ctx.createLinearGradient(0, 0, bw, bh);
  screen.addColorStop(0, `hsl(${(t / 50) % 360},70%,42%)`);
  screen.addColorStop(1, `hsl(${(t / 50 + 80) % 360},75%,22%)`);
  ctx.fillStyle = screen;
  roundRect(ctx, 8, 8, bw - 16, bh - 16, 8);
  ctx.fill();
  ctx.save();
  roundRect(ctx, 8, 8, bw - 16, bh - 16, 8);
  ctx.clip();
  for (let i = 0; i < 7; i++) {
    const x = 8 + ((t / 10 + i * 55) % (bw - 16));
    const y = 24 + Math.sin(t / 280 + i) * 22 + i * 12;
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillRect(x, y, 12, 12);
  }
  ctx.restore();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  roundRect(ctx, 14, 14, 74, 18, 4);
  ctx.fill();
  ctx.fillStyle = "#3ddc97";
  ctx.font = '700 10px "JetBrains Mono Variable", monospace';
  ctx.fillText("60 FPS · 14 ms", 19, 27);
  ctx.fillStyle = "#1a1f40";
  roundRect(ctx, -14, bh, bw + 28, 8, 4);
  ctx.fill();
  ctx.fillStyle = "#10132a";
  roundRect(ctx, bw + 22, bh * 0.3, bw * 0.2, bh * 0.75, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.stroke();
  ctx.fillStyle = screen;
  roundRect(ctx, bw + 26, bh * 0.3 + 6, bw * 0.2 - 8, bh * 0.75 - 12, 5);
  ctx.fill();
  ctx.restore();

  // Насколько курсор близко к вершине дуги — добавка к «задержке» в HUD (0..6).
  return cursor.inside
    ? Math.max(0, 1 - Math.hypot(cursor.x - cx, cursor.y - cy) / W) * 6
    : 0;
};

export function TechFlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<Cursor>({ x: -9999, y: -9999, inside: false });
  const parts = useRef<Particle[] | null>(null);
  const [anchors, setAnchors] = useState<Anchors>();
  const hudRef = useRef<HudHandle>(null);
  const lastSize = useRef("");

  const draw = useCallback<DrawFrame>((ctx, size, t) => {
    const key = `${size.width}x${size.height}`;
    if (key !== lastSize.current) {
      lastSize.current = key;
      setAnchors(anchorsFor(size));
    }
    parts.current ??= makeParticles();
    const boost = drawTechFlow(ctx, size, t, cursor.current, parts.current);
    hudRef.current?.tick(t, boost);
  }, []);
  useCanvasLoop(canvasRef, draw);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    cursor.current = {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      inside: true,
    };
  };
  const onLeave = () => {
    cursor.current = { ...cursor.current, inside: false };
  };

  return (
    <section id="tech" className="relative pt-10 pb-[60px]">
      <div className="mx-auto max-w-[1180px] px-7">
        <div className="mb-12 max-w-[680px]">
          <div className="mb-3.5 text-xs font-bold tracking-[0.16em] text-brand-cyan uppercase">
            Технология
          </div>
          <h2 className="mb-4 text-[clamp(30px,4vw,50px)] leading-[1.05] font-extrabold tracking-[-0.035em]">
            GPU там. <span className="text-gradient">Игра здесь.</span>
          </h2>
          <p className="text-[17px] leading-[1.55] text-brand-muted">
            Каждая игра запускается в своём контейнере на сервере с видеокартой.
            Готовые кадры летят тебе по сети, а ввод летит обратно. Между ними —
            миллисекунды.
          </p>
        </div>
        <div
          className="relative h-[460px] cursor-crosshair min-[860px]:h-[560px]"
          onMouseMove={onMove}
          onMouseLeave={onLeave}
        >
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="absolute inset-0 block size-full"
          />
          <Hud ref={hudRef} driven />
          {anchors && (
            <>
              <FlowLabel x={anchors.ax} y={anchors.labelA} title="Дата-центр">
                контейнеры с играми на серверах с GPU
              </FlowLabel>
              <FlowLabel
                x={anchors.bx + 20}
                y={anchors.labelB}
                title="Твоё устройство"
              >
                здесь будет живое видео стрима
              </FlowLabel>
            </>
          )}
          <span className="pointer-events-none absolute right-0 bottom-0 text-xs text-brand-muted">
            частицы тянутся к курсору
          </span>
        </div>
        <div className="mt-5 grid gap-[18px] min-[860px]:grid-cols-3">
          {techNotes.map((n) => (
            <div key={n.title} className="border-l-2 border-brand-cyan/40 pl-4">
              <b className="mb-1.5 block text-[15px]">{n.title}</b>
              <span className="text-sm leading-normal text-brand-muted">
                {n.text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FlowLabel({
  x,
  y,
  title,
  children,
}: {
  x: number;
  y: number;
  title: string;
  children: string;
}) {
  return (
    <div
      className="pointer-events-none absolute -ml-[100px] w-[200px] text-center text-[11px] font-bold tracking-[0.14em] text-brand-muted uppercase"
      style={{ left: x, top: y }}
    >
      {title}
      <small className="mt-1 block text-[11px] font-medium tracking-normal text-brand-dim normal-case">
        {children}
      </small>
    </div>
  );
}
