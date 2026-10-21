// Логотип GameCrate: один SVG на все состояния. progress 0 — полный лок-ап (шестигранное
// кольцо + «GameCrate» + слоган), 1 — компактный GC-куб: верхняя полоса гнётся в «крышу»,
// боковые растворяются, буквы G и C перелетают на грани. Геометрия — logo-geometry.ts.
import { useEffect, useId, useRef, useState } from "react";
import {
  BOX_HEIGHT,
  DEFAULT_METRICS,
  FONT_SIZE,
  LEFT_BAND,
  type LogoMetrics,
  logoFrame,
  MARK_WIDTH,
  RIGHT_BAND,
  SEAMS,
  TAG_FONT_SIZE,
} from "./logo-geometry";

export type LogoProps = {
  /** 0 — полный лок-ап, 1 — компактный знак. */
  progress?: number;
  /** Высота в px. */
  height?: number;
  /** Только знак, без названия. */
  iconOnly?: boolean;
  /** На светлом фоне. */
  light?: boolean;
  /** Готовые ширины «ame»/«rate» — пропустить измерение шрифта. */
  metrics?: LogoMetrics;
  className?: string;
  /** aria-label. */
  title?: string;
};

const FONT_FAMILY = "var(--font-sans)";

/** Ширины «ame»/«rate» текущим шрифтом; `undefined`, если измерить нельзя. */
const measure = (
  ame: SVGTextElement | null,
  rate: SVGTextElement | null,
): LogoMetrics | undefined => {
  if (!ame || !rate || typeof ame.getComputedTextLength !== "function") return;
  const ameWidth = ame.getComputedTextLength();
  const rateWidth = rate.getComputedTextLength();
  if (!(ameWidth > 0) || !(rateWidth > 0)) return;
  return { ameWidth, rateWidth };
};

export function Logo({
  progress = 0,
  height = 36,
  iconOnly = false,
  light = false,
  metrics,
  className,
  title = "GameCrate",
}: LogoProps) {
  const id = useId();
  const ameRef = useRef<SVGTextElement>(null);
  const rateRef = useRef<SVGTextElement>(null);
  const [measured, setMeasured] = useState<LogoMetrics>();

  useEffect(() => {
    if (metrics || iconOnly) return;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      const m = measure(ameRef.current, rateRef.current);
      if (m) setMeasured(m);
    };
    apply();
    const ready =
      typeof document !== "undefined" ? document.fonts?.ready : null;
    void ready?.then(apply, () => {});
    return () => {
      cancelled = true;
    };
  }, [metrics, iconOnly]);

  // iconOnly прячет надпись и фиксирует viewBox, но не прогресс: при 0 это кольцо
  // (фавиконка, мелкие знаки < 32px), при 1 — GC-куб.
  const frame = logoFrame(progress, metrics ?? measured ?? DEFAULT_METRICS);
  const viewBoxWidth = iconOnly ? MARK_WIDTH : frame.viewBoxWidth;
  const markId = `${id}-mark`;
  const gId = `${id}-g`;
  const cId = `${id}-c`;
  const maskId = `${id}-mask`;

  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${viewBoxWidth} ${BOX_HEIGHT}`}
      height={height}
      width={(viewBoxWidth * height) / BOX_HEIGHT}
      fontWeight={800}
      className={className}
      style={{
        color: light ? "#0b0e1f" : "#f3f4ff",
        fontFamily: FONT_FAMILY,
        display: "block",
      }}
    >
      <defs>
        <linearGradient
          id={markId}
          gradientUnits="userSpaceOnUse"
          x1="30"
          y1="20"
          x2="180"
          y2="210"
        >
          <stop offset="0" stopColor="#3cc2ff" />
          <stop offset="0.5" stopColor="#3a6cff" />
          <stop offset="1" stopColor="#5b2fff" />
        </linearGradient>
        <linearGradient id={gId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3cc2ff" />
          <stop offset="1" stopColor="#3a6cff" />
        </linearGradient>
        <linearGradient id={cId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3f7aff" />
          <stop offset="1" stopColor="#5b2fff" />
        </linearGradient>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <polygon points={frame.topPoints} fill="#fff" />
          <polygon points={LEFT_BAND} fill="#fff" opacity={frame.bandOpacity} />
          <polygon
            points={RIGHT_BAND}
            fill="#fff"
            opacity={frame.bandOpacity}
          />
          <path
            d={SEAMS}
            stroke="#000"
            strokeWidth={5}
            fill="none"
            opacity={frame.bandOpacity}
          />
          <path d={frame.topSeamPath} stroke="#000" strokeWidth={5} />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <rect width={MARK_WIDTH} height={BOX_HEIGHT} fill={`url(#${markId})`} />
        <polygon points="100,110 13.4,60 13.4,160 100,210" opacity={0.1} />
        <polygon points="100,110 186.6,60 186.6,160 100,210" opacity={0.26} />
      </g>
      <path
        d={frame.gPath}
        fill={`url(#${gId})`}
        transform={frame.gTransform}
      />
      <path
        d={frame.cPath}
        fill={`url(#${cId})`}
        transform={frame.cTransform}
      />
      {!iconOnly && (
        <>
          <text
            ref={ameRef}
            className="ame"
            x={frame.ame.x}
            y={frame.ame.y}
            fontSize={FONT_SIZE}
            fill="currentColor"
            opacity={frame.ame.opacity}
          >
            ame
          </text>
          <text
            ref={rateRef}
            className="rate"
            x={frame.rate.x}
            y={frame.rate.y}
            fontSize={FONT_SIZE}
            fill="currentColor"
            opacity={frame.rate.opacity}
          >
            rate
          </text>
          <text
            x={frame.tag.x}
            y={frame.tag.y}
            fontSize={TAG_FONT_SIZE}
            fontWeight={500}
            fill={light ? "#5c6089" : "#8b90b8"}
            opacity={frame.tag.opacity}
          >
            Games in containers
          </text>
        </>
      )}
    </svg>
  );
}
