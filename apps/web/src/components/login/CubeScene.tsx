// Сцена «сборка куба» для левой половины страницы входа: 27 изометрических кубиков
// слетаются к своим местам по мере заполнения формы (почта → код → готово), наведение
// на способ входа подсвечивает их цветом провайдера, а успешный вход зажигает куб.
import { useRef } from "react";
import {
  approach,
  CAPTIONS,
  type Cube,
  type Level,
  makeCubes,
  PROVIDER_TINT,
  STEP_LABELS,
  targetPosition,
} from "@/lib/cubeAssembly";
import {
  type CanvasSize,
  type DrawFrame,
  useCanvasLoop,
} from "@/lib/useCanvasLoop";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { cn } from "@/lib/utils";

type Rgb = readonly [number, number, number];

const EDGE_WIDE = 34;
const EDGE_NARROW = 24;
const WIDE_BREAKPOINT = 900;

/** Изометрический кубик: верх и две затемнённые боковые грани, тонкая белая рамка. */
const drawCube = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  col: Rgb,
  alpha: number,
): void => {
  const h = s * 0.5;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(x, y - h);
  ctx.lineTo(x + s, y - h * 1.5);
  ctx.lineTo(x, y - h * 2);
  ctx.lineTo(x - s, y - h * 1.5);
  ctx.closePath();
  ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
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
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
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

const edgeSize = (width: number): number =>
  width >= WIDE_BREAKPOINT ? EDGE_WIDE : EDGE_NARROW;

export function CubeScene({
  level,
  tint,
  lit,
  className,
}: {
  level: Level;
  tint: keyof typeof PROVIDER_TINT | null;
  lit: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cubes = useRef<Cube[] | null>(null);
  const reduced = usePrefersReducedMotion();

  const draw: DrawFrame = (ctx, size: CanvasSize, t) => {
    const { width: W, height: H } = size;
    cubes.current ??= makeCubes(Math.random);
    const s = edgeSize(W);
    const cx = W / 2;
    const cy = H / 2 + 60;
    const drift = !reduced;
    const approachK = reduced ? 1 : 0.06;

    ctx.clearRect(0, 0, W, H);
    cubes.current.forEach((c, n) => {
      const target = targetPosition(c, n, level, cx, cy, s, t, drift);
      c.x = approach(c.x, target.x, approachK);
      c.y = approach(c.y, target.y, approachK);
      const col = tint ? PROVIDER_TINT[tint] : c.color;
      const glow = reduced ? 1 : lit ? 0.6 + 0.4 * Math.sin(t / 120) : 1;
      const alpha = target.home
        ? glow
        : reduced
          ? 0.45
          : 0.45 + 0.2 * Math.sin(t / 500 + c.phase);
      drawCube(ctx, c.x, c.y, s, col, alpha);
    });

    if (lit) {
      const g = ctx.createRadialGradient(cx, cy - 40, 0, cx, cy - 40, 260);
      g.addColorStop(0, "rgba(60,194,255,0.35)");
      g.addColorStop(1, "rgba(60,194,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  };

  useCanvasLoop(canvasRef, draw);

  return (
    <div className={cn("relative size-full overflow-hidden", className)}>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 block size-full"
      />
      <div className="absolute top-7 right-7 grid gap-2 font-mono text-[11px] text-brand-muted">
        {STEP_LABELS.map((label, i) => (
          <span
            key={label}
            className={cn(
              "flex items-center gap-2 before:block before:size-2 before:rounded-sm before:bg-white/10",
              i <= level &&
                "on text-brand-text before:bg-brand-ok before:shadow-[0_0_10px_#3ddc97]",
            )}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="absolute bottom-11 left-10">
        <div className="font-mono text-[11px] tracking-[0.16em] text-brand-cyan uppercase">
          ASSEMBLING
        </div>
        <h4 className="mt-1.5 text-[26px] tracking-[-0.03em]">
          {CAPTIONS[level]}
        </h4>
      </div>
    </div>
  );
}
