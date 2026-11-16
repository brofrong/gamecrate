// Секция «Технология»: сцена на canvas без рамки — слева облако (стопки изометрических
// кубиков), справа устройство с «игрой» и геймпадом, между ними поток частиц по дуге.
// Частицы обходят курсор, сама дуга не двигается. На экране ноутбука — ролик-«стрим»
// и HUD поверх него (DOM поверх canvas); телефон горизонтально рядом с ноутбуком, не
// заходя на него, показывает те же кадры (canvas рисует их из видео ноутбука), геймпад
// покачивается и «жмёт» кнопки. Снизу — три заметки.
import { useCallback, useRef, useState } from "react";
import { type BrandPalette, readBrandPalette } from "@/lib/brandColors";
import {
  type CanvasSize,
  type DrawFrame,
  useCanvasLoop,
} from "@/lib/useCanvasLoop";
import { techNotes } from "./data";
import { Hud, type HudHandle } from "./Hud";
import { StreamVideo } from "./StreamVideo";

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
  /** Экран ноутбука в координатах сцены — сюда кладётся HUD. */
  screen: { left: number; top: number; width: number; height: number };
  /** Ноутбук: ширина и высота корпуса с центром в (bx, by). */
  laptop: { bw: number; bh: number };
  /** Телефон: центр, размеры корпуса и наклон (рад). */
  phone: { x: number; y: number; pw: number; ph: number; tilt: number };
  /** Геймпад: центр и масштаб. */
  pad: { x: number; y: number; k: number };
  narrow: boolean;
};

/** Цвета частиц — палитра витрины: три акцента и два промежуточных оттенка. */
const particlePalette = (p: BrandPalette): ReadonlyArray<Rgb> => [
  p.glowRgb,
  p.accent2Rgb,
  p.accent3Rgb,
  p.mixRgb[1],
  p.mixRgb[2],
];
const PARTICLES = 600;
const AVOID_RADIUS = 160;
const GLOW_RADIUS = 120;

const makeParticles = (palette: BrandPalette): Particle[] => {
  const colors = particlePalette(palette);
  return Array.from({ length: PARTICLES }, (_, i) => ({
    p: Math.random(),
    off: (Math.random() - 0.5) * 120,
    sp: 0.0016 + Math.random() * 0.0022,
    col: colors[i % colors.length] as Rgb,
    sz: 1.5 + Math.random() * 2.5,
    tw: Math.random() * 6,
    dx: 0,
    dy: 0,
  }));
};

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

const PHONE_TILT = -0.1;
/** Зазор между ноутбуком (с основанием) и телефоном. */
const PHONE_GAP = 18;

/** Полуширина и полувысота рамки телефона с наклоном `PHONE_TILT`. */
const tiltedHalf = (pw: number, ph: number) => {
  const c = Math.abs(Math.cos(PHONE_TILT));
  const s = Math.abs(Math.sin(PHONE_TILT));
  return { hw: (pw / 2) * c + (ph / 2) * s, hh: (pw / 2) * s + (ph / 2) * c };
};

/**
 * Сцена: облако слева, ноутбук (до 440×275, от ширины сцены) и телефон горизонтально
 * с наклоном. На широкой сцене телефон стоит справа от ноутбука на том же «столе», на
 * узкой — под ним справа; с ноутбуком не пересекается. Геймпад — слева от ноутбука, а
 * если там он задел бы подпись облака — перед ноутбуком, под «столом».
 */
export const anchorsFor = ({ width: W, height: H }: CanvasSize): Anchors => {
  const narrow = W < 760;
  const ax = narrow ? W * 0.2 : W * 0.18;
  const ay = H * 0.5;
  const s = narrow ? 16 : 24;
  const bw = narrow ? 200 : Math.min(440, W * 0.39);
  const bh = bw * 0.625;
  const pw = narrow ? 84 : bw * 0.355;
  const ph = pw * 0.49;
  const { hw, hh } = tiltedHalf(pw, ph);
  const bx = narrow ? W * 0.64 : W * 0.6;
  const by = ay;
  // Низ основания ноутбука — «стол».
  const desk = by + bh / 2 + 8;
  const phone = narrow
    ? { x: bx + bw / 2 - hw, y: desk + PHONE_GAP / 2 + hh }
    : { x: bx + bw / 2 + 14 + PHONE_GAP + hw, y: desk - hh };
  const labelA = ay + s * 1.1 + s * 3.2;
  // Геймпад: полуширина и выступы вверх/вниз с запасом на покачивание и наклон.
  const k = narrow ? 0.7 : 1;
  const padHalf = 44 * k;
  const padUp = 18 * k + 5;
  const padDown = 38 * k + 5;
  // Подпись облака: 200 px по центру `ax`, ~40 px высотой.
  const captionRight = ax + 100 + 4;
  const besideX = bx - bw / 2 - 14 - 8 - padHalf;
  const besideY = by + bh / 2 - 2;
  const besideHitsCaption =
    besideX - padHalf < captionRight &&
    besideY + padDown > labelA &&
    besideY - padUp < labelA + 40;
  // Под «столом» — правее подписи облака; на узкой сцене, если там уже телефон, —
  // под левым краем ноутбука, но ниже подписи облака.
  const underY = desk + padUp + 6;
  const underX = Math.max(bx - bw / 2 + padHalf, captionRight + padHalf);
  const phoneLeft = phone.x - pw / 2 - 4;
  const underHitsPhone = narrow && underX + padHalf > phoneLeft;
  const pad = !besideHitsCaption
    ? { x: besideX, y: besideY, k }
    : underHitsPhone
      ? {
          x: bx - bw / 2 + padHalf,
          y: Math.max(underY, labelA + 40 + padUp + 4),
          k,
        }
      : { x: underX, y: underY, k };
  return {
    ax,
    ay,
    bx,
    by,
    labelA,
    labelB: Math.max(desk, phone.y + hh, pad.y + padDown) + 22,
    screen: {
      left: bx - bw / 2 + 8,
      top: ay - bh / 2 + 8,
      width: bw - 16,
      height: bh - 16,
    },
    laptop: { bw, bh },
    phone: { ...phone, pw, ph, tilt: PHONE_TILT },
    pad,
    narrow,
  };
};

/** Частица обходит курсор: в радиусе AVOID_RADIUS её сносит от него, сильнее — ближе. */
export const nudgeAwayFromCursor = (
  p: { dx: number; dy: number },
  px: number,
  py: number,
  cursor: Cursor,
): void => {
  if (!cursor.inside) return;
  const ddx = cursor.x - (px + p.dx);
  const ddy = cursor.y - (py + p.dy);
  const d = Math.hypot(ddx, ddy);
  if (d >= AVOID_RADIUS || d === 0) return;
  const f = (1 - d / AVOID_RADIUS) * 0.9;
  p.dx -= (ddx / d) * f * 3;
  p.dy -= (ddy / d) * f * 3;
};

/**
 * Поза геймпада в момент `t` (мс): покачивание вверх-вниз (`dy`, px), наклон
 * (`angle`, рад), какая из четырёх кнопок «нажата» и куда отклонены стики.
 */
export const gamepadPose = (t: number) => ({
  dy: Math.sin(t / 520) * 5,
  angle: Math.sin(t / 830) * 0.1,
  pressed: Math.floor(t / 260) % 4,
  stick: { x: Math.cos(t / 400) * 2, y: Math.sin(t / 310) * 2 },
});

/** Геймпад: корпус, две рукоятки, крестовина, кнопки, стики — в позе момента `t`. */
const gamepad = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  k: number,
  t: number,
  accent: string,
) => {
  const pose = gamepadPose(t);
  ctx.save();
  ctx.translate(x, y + pose.dy);
  ctx.rotate(pose.angle);
  ctx.scale(k, k);
  ctx.fillStyle = "#10132a";
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1 / k;
  ctx.beginPath();
  ctx.ellipse(-26, 14, 13, 20, -0.35, 0, Math.PI * 2);
  ctx.ellipse(26, 14, 13, 20, 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  roundRect(ctx, -40, -14, 80, 36, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(-29, -3, 14, 4);
  ctx.fillRect(-24, -8, 4, 14);
  const buttons: ReadonlyArray<[number, number, string]> = [
    [24, -7, "#3ddc97"],
    [30, -1, "#ffd166"],
    [18, -1, accent],
    [24, 5, "#ff6b6b"],
  ];
  buttons.forEach(([bx, by, col], i) => {
    const down = i === pose.pressed;
    ctx.fillStyle = col;
    ctx.globalAlpha = down ? 1 : 0.55;
    ctx.beginPath();
    ctx.arc(bx, by, down ? 1.8 : 2.4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  for (const [sx, dir] of [
    [-10, 1],
    [10, -1],
  ] as const) {
    ctx.fillStyle = "#23284a";
    ctx.beginPath();
    ctx.arc(sx, 12, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3a4170";
    ctx.beginPath();
    ctx.arc(
      sx + pose.stick.x * dir,
      12 + pose.stick.y * dir,
      2.6,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
};

export const drawTechFlow = (
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  t: number,
  cursor: Cursor,
  parts: Particle[],
  /** Видео ноутбука: его кадры повторяет экран телефона (пока кадров нет — градиент). */
  video?: HTMLVideoElement | null,
  /** Палитра витрины; вызывающий читает её один раз при монтировании. */
  palette: BrandPalette = readBrandPalette(),
): number => {
  const { width: W, height: H } = size;
  const narrow = W < 760;
  const { ax, ay, bx, by, laptop, phone, pad } = anchorsFor(size);
  const cx = (ax + bx) / 2;
  const cy = ay - 120;
  ctx.clearRect(0, 0, W, H);

  // Частицы на дуге; обходят курсор.
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
    nudgeAwayFromCursor(p, px, py, cursor);
    p.dx *= 0.93;
    p.dy *= 0.93;
    px += p.dx;
    py += p.dy;
    const near = cursor.inside
      ? Math.max(0, 1 - Math.hypot(cursor.x - px, cursor.y - py) / GLOW_RADIUS)
      : 0;
    const a = (0.2 + spread * 0.8) * (0.6 + 0.4 * Math.sin(t / 300 + p.tw));
    // Синий канал у холодной палитры (GameCrate) поднимаем до 255, у тёплой не трогаем.
    const blue = p.col[2] >= 200 ? 255 : p.col[2];
    ctx.fillStyle = `rgba(${(p.col[0] + near * 120) | 0},${(p.col[1] + near * 60) | 0},${blue},${Math.min(1, a + near * 0.5)})`;
    ctx.fillRect(px, py, p.sz + near * 1.5, p.sz + near * 1.5);
  }

  // Облако: стопки кубиков.
  const s = narrow ? 16 : 24;
  const base = ay + s * 1.1;
  const stackColors: ReadonlyArray<Rgb> = [
    palette.glowRgb,
    palette.accent2Rgb,
    palette.accent3Rgb,
    palette.mixRgb[0],
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
  const glowRgb = palette.glowRgb.join(",");
  glow.addColorStop(0, `rgba(${glowRgb},0.18)`);
  glow.addColorStop(1, `rgba(${glowRgb},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(ax - 200, ay - 200, 400, 400);

  // Устройство: ноутбук со стримом (видео и HUD — DOM поверх экрана), рядом телефон с
  // теми же кадрами и геймпад.
  const { bw, bh } = laptop;
  ctx.save();
  ctx.translate(bx - bw / 2, by - bh / 2);
  ctx.shadowColor = `rgba(${palette.accent2Rgb.join(",")},0.35)`;
  ctx.shadowBlur = 40;
  roundRect(ctx, 0, 0, bw, bh, 12);
  ctx.fillStyle = "#10132a";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.stroke();
  const screen = ctx.createLinearGradient(0, 0, bw, bh);
  screen.addColorStop(0, `hsl(${(t / 50) % 360},60%,28%)`);
  screen.addColorStop(1, `hsl(${(t / 50 + 80) % 360},65%,14%)`);
  ctx.fillStyle = screen;
  roundRect(ctx, 8, 8, bw - 16, bh - 16, 8);
  ctx.fill();
  ctx.save();
  roundRect(ctx, 8, 8, bw - 16, bh - 16, 8);
  ctx.clip();
  for (let i = 0; i < 7; i++) {
    const x = 8 + ((t / 10 + i * 55) % (bw - 16));
    const y = 24 + Math.sin(t / 280 + i) * 22 + i * 12;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(x, y, 12, 12);
  }
  ctx.restore();
  ctx.fillStyle = "#1a1f40";
  roundRect(ctx, -14, bh, bw + 28, 8, 4);
  ctx.fill();
  ctx.restore();

  const { pw, ph } = phone;
  ctx.save();
  ctx.translate(phone.x, phone.y);
  ctx.rotate(phone.tilt);
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 24;
  roundRect(ctx, -pw / 2, -ph / 2, pw, ph, narrow ? 7 : 11);
  ctx.fillStyle = "#10132a";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.stroke();
  const inset = narrow ? 4 : 6;
  const sw = pw - inset * 2;
  const sh = ph - inset * 2;
  roundRect(ctx, -sw / 2, -sh / 2, sw, sh, narrow ? 4 : 6);
  ctx.save();
  ctx.clip();
  if (video && video.readyState >= 2) {
    // Кадр видео 16:9 заполняет экран телефона по высоте (лишнее по бокам обрезает клип).
    const vw = Math.max(sw, (sh * 16) / 9);
    ctx.drawImage(video, -vw / 2, -sh / 2, vw, sh);
  } else {
    ctx.fillStyle = screen;
    ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
  }
  ctx.restore();
  ctx.restore();

  gamepad(ctx, pad.x, pad.y, pad.k, t, palette.accent);

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSize = useRef("");
  // Палитра витрины читается один раз при монтировании.
  const [palette] = useState(readBrandPalette);

  const draw = useCallback<DrawFrame>(
    (ctx, size, t) => {
      const key = `${size.width}x${size.height}`;
      if (key !== lastSize.current) {
        lastSize.current = key;
        setAnchors(anchorsFor(size));
      }
      parts.current ??= makeParticles(palette);
      const boost = drawTechFlow(
        ctx,
        size,
        t,
        cursor.current,
        parts.current,
        videoRef.current,
        palette,
      );
      hudRef.current?.tick(t, boost);
    },
    [palette],
  );
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
    <section id="tech" className="relative pt-[110px] pb-[60px]">
      <div className="mx-auto max-w-[1180px] px-7">
        <div className="mb-12 max-w-[680px]">
          <div className="mb-3.5 text-xs font-bold tracking-[0.16em] text-brand-cyan uppercase">
            Технология
          </div>
          <h2 className="mb-4 text-[clamp(30px,4vw,50px)] leading-[1.05] font-extrabold tracking-[-0.035em]">
            GPU там. <span className="text-gradient">Игра здесь.</span>
          </h2>
          <p className="text-[17px] leading-[1.55] text-brand-muted">
            Каждая игра запускается в своём облаке на сервере с видеокартой.
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
          {anchors && (
            <>
              <div
                className="pointer-events-none absolute overflow-hidden rounded-lg"
                style={anchors.screen}
              >
                <StreamVideo videoRef={videoRef} />
                <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,6,15,0.72),rgba(5,6,15,0.2)_75%)]" />
                <Hud
                  ref={hudRef}
                  driven
                  className={
                    anchors.narrow
                      ? "absolute top-1.5 left-2 origin-top-left scale-[0.55]"
                      : "absolute top-3 left-4"
                  }
                />
              </div>
              <FlowLabel x={anchors.ax} y={anchors.labelA} title="Облако">
                твои игры на серверах с GPU
              </FlowLabel>
              <FlowLabel
                x={anchors.bx + 20}
                y={anchors.labelB}
                title="Твоё устройство"
              >
                игра в реальном времени
              </FlowLabel>
            </>
          )}
          <span className="pointer-events-none absolute right-0 bottom-0 text-xs text-brand-muted">
            частицы обходят курсор
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
