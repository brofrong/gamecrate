// «Как это работает»: слева три шага с прогресс-полосой, справа анимированное демо по
// кругу — QR-привязка Steam → библиотека с курсором и кликом «Играть» → старт стрима.
// Клик по шагу перематывает на его фазу. При reduced motion таймеров нет: показан
// финальный кадр третьей фазы, клик по шагу показывает финальный кадр его фазы.
import { useEffect, useRef, useState } from "react";
import {
  type DemoCue,
  type DemoPhase,
  FINAL_CUE,
  nextPhase,
  PHASE_CUES,
  PHASE_DURATION_MS,
} from "@/lib/howItWorksTimeline";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { cn } from "@/lib/utils";
import { coverUrl, demoAppIds, steps } from "./data";
import { StreamVideo } from "./StreamVideo";

const HOT_TILE = 4;

/** Детерминированная «QR-сетка» 15×15 с угловыми маркерами. */
const QR_CELLS: ReadonlyArray<boolean> = (() => {
  let seed = 7;
  return Array.from({ length: 225 }, (_, i) => {
    seed = (seed * 16807) % 2147483647;
    const on = (seed & 3) !== 0 && ((seed >> 4) & 1) === 1;
    const r = Math.floor(i / 15);
    const c = i % 15;
    const finder = (r < 4 && c < 4) || (r < 4 && c > 10) || (r > 10 && c < 4);
    return finder || on;
  });
})();

type Pos = { left: string; top: string };

export function HowItWorks() {
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const demoRef = useRef<HTMLDivElement>(null);
  const hotTileRef = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<DemoPhase>(reduced ? 2 : 0);
  const [cues, setCues] = useState<ReadonlySet<DemoCue>>(
    () => new Set(reduced ? ["playing"] : []),
  );
  const [run, setRun] = useState(0);
  const [cursor, setCursor] = useState<Pos>({ left: "85%", top: "85%" });
  const [clickAt, setClickAt] = useState<Pos | null>(null);

  const show = (p: DemoPhase) => {
    setPhase(p);
    setCues(new Set(reduced ? [FINAL_CUE[p]] : []));
    setClickAt(null);
    setRun((n) => n + 1);
    if (!reduced) setStarted(true);
  };

  // Старт при появлении секции на экране.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || reduced || started) return;
    if (typeof IntersectionObserver === "undefined") {
      setStarted(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setStarted(true);
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced, started]);

  // Курсор: к плитке / к кнопке «Играть» на ней (координаты относительно сцены).
  const moveCursorToTile = (ox: number, oy: number) => {
    const demo = demoRef.current;
    const tile = hotTileRef.current;
    if (!demo || !tile) return;
    const r = tile.getBoundingClientRect();
    const d = demo.getBoundingClientRect();
    setCursor({
      left: `${(r.left - d.left + r.width * ox).toFixed(1)}px`,
      top: `${(r.top - d.top + r.height * oy).toFixed(1)}px`,
    });
  };

  // Таймеры фазы: реплики по расписанию, затем следующая фаза.
  useEffect(() => {
    if (!started || reduced) return;
    if (phase === 0) setCursor({ left: "85%", top: "85%" });
    if (phase === 2) setCursor({ left: "90%", top: "90%" });
    const apply = (cue: DemoCue) => {
      setCues((prev) => new Set(prev).add(cue));
      if (cue === "cursor-tile") moveCursorToTile(0.5, 0.4);
      if (cue === "cursor-play") moveCursorToTile(0.5, 0.86);
      if (cue === "click") setCursor((c) => (setClickAt(c), c));
    };
    const timers = PHASE_CUES[phase].map(({ at, cue }) =>
      setTimeout(() => apply(cue), at),
    );
    timers.push(
      setTimeout(() => {
        setCues(new Set());
        setClickAt(null);
        setPhase(nextPhase(phase));
      }, PHASE_DURATION_MS[phase]),
    );
    return () => timers.forEach(clearTimeout);
  }, [started, reduced, phase, run]);

  const bootText = cues.has("boot-stream")
    ? "Запускаем стрим…"
    : cues.has("boot-gpu")
      ? "Выделяем GPU…"
      : "Поднимаем облако…";

  return (
    <section
      id="how"
      ref={sectionRef}
      className="relative overflow-hidden py-[110px]"
    >
      <div className="pointer-events-none absolute top-0 -left-[300px] size-[700px] rounded-full bg-[radial-gradient(circle,rgba(58,108,255,0.16),rgba(0,0,0,0)_65%)]" />
      <div className="relative mx-auto max-w-[1180px] px-7">
        <div className="mb-12 max-w-[680px]">
          <div className="mb-3.5 text-xs font-bold tracking-[0.16em] text-brand-cyan uppercase">
            Как это работает
          </div>
          <h2 className="text-[clamp(30px,4vw,50px)] leading-[1.05] font-extrabold tracking-[-0.035em]">
            От входа до игры за три клика
          </h2>
        </div>
        <div className="grid items-center gap-10 min-[960px]:grid-cols-[340px_1fr]">
          <div className="grid gap-1.5">
            {steps.map((step, i) => {
              const active = phase === i;
              return (
                <div
                  key={step.title}
                  data-active={active ? "" : undefined}
                  onClick={() => show(i as DemoPhase)}
                  className={cn(
                    "relative cursor-pointer rounded-2xl border border-transparent px-5 py-[18px] transition-[background-color,border-color] duration-250",
                    active && "border-brand-line bg-brand-card",
                  )}
                >
                  <div
                    className={cn(
                      "mb-1.5 font-mono text-xs text-brand-muted",
                      active && "text-brand-cyan",
                    )}
                  >
                    0{i + 1}
                  </div>
                  <h3 className="mb-1.5 text-[19px] font-bold tracking-[-0.02em]">
                    {step.title}
                  </h3>
                  <p className="text-sm leading-normal text-brand-muted">
                    {step.text}
                  </p>
                  {active && started && !reduced && (
                    <div className="absolute right-5 bottom-0 left-5 h-0.5 overflow-hidden rounded-sm bg-white/6">
                      <i
                        key={run}
                        className="block h-full w-0 bg-brand-gradient"
                        style={{
                          animation: `gc-fill ${PHASE_DURATION_MS[phase]}ms linear forwards`,
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div
            ref={demoRef}
            className="relative h-[480px] overflow-hidden rounded-3xl border border-brand-line bg-[radial-gradient(ellipse_at_30%_20%,rgba(58,108,255,0.14),transparent_60%),#0a0d1c]"
          >
            {!reduced && (
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute z-10 size-[22px] transition-[left,top,transform] duration-[900ms,900ms,150ms] ease-[cubic-bezier(.4,0,.2,1)] drop-shadow-[0_4px_8px_rgba(0,0,0,0.6)]",
                  cues.has("click") && !cues.has("tile-cool") && "scale-80",
                )}
                style={cursor}
              >
                <path
                  d="M4 2l16 9-7 2-3 8z"
                  fill="#fff"
                  stroke="#000"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {clickAt && (
              <div
                className="pointer-events-none absolute z-[9] size-2.5 rounded-full border-2 border-brand-cyan animate-[gc-ripple_.7s_ease-out_forwards]"
                style={{
                  left: `calc(${clickAt.left} - 5px)`,
                  top: `calc(${clickAt.top} - 5px)`,
                }}
              />
            )}

            <Phase on={phase === 0}>
              <div className="flex max-w-[92%] flex-wrap items-center justify-center gap-5 rounded-[20px] border border-brand-line bg-brand-card px-5 py-5 min-[600px]:flex-nowrap min-[600px]:gap-7 min-[600px]:px-[30px] min-[600px]:py-[26px]">
                <div className="relative grid size-[120px] shrink-0 grid-cols-[repeat(15,1fr)] gap-px overflow-hidden rounded-[10px] bg-white p-2 min-[600px]:size-[150px]">
                  {QR_CELLS.map((dark, i) => (
                    <i
                      key={i}
                      className={cn(
                        "block rounded-px",
                        dark ? "bg-[#0b0e1f]" : "bg-white",
                      )}
                    />
                  ))}
                  {!cues.has("linked") && !reduced && (
                    <div className="absolute inset-x-0 top-0 h-[3px] animate-[gc-scan_1.6s_ease-in-out_infinite] bg-brand-cyan shadow-[0_0_16px_#3cc2ff]" />
                  )}
                </div>
                <div>
                  <h4 className="mb-2 text-xl font-bold tracking-[-0.02em]">
                    Привяжи Steam
                  </h4>
                  <p className="mb-3.5 max-w-[260px] text-sm leading-normal text-brand-muted max-[599px]:max-w-none">
                    Открой Steam на телефоне → Steam Guard → отсканируй.
                  </p>
                  <span
                    className={cn(
                      "inline-flex items-center gap-2 text-[13px] font-semibold text-brand-ok transition-opacity duration-400",
                      cues.has("linked") ? "opacity-100" : "opacity-0",
                    )}
                  >
                    ✓ Привязано: <b>dga</b> · 212 игр
                  </span>
                </div>
                <div className="relative hidden h-[100px] w-14 rounded-xl border-2 border-white/20 bg-[#0b0e1f] min-[600px]:block">
                  <div className="absolute top-1.5 left-1/2 h-[3px] w-4 -translate-x-1/2 rounded-sm bg-white/20" />
                  <div className="absolute inset-x-2 top-[18px] bottom-3.5 rounded-md border border-dashed border-brand-cyan/40 bg-brand-cyan/12" />
                </div>
              </div>
            </Phase>

            <Phase on={phase === 1}>
              <div className="w-[min(560px,92%)]">
                <div className="mb-3.5 flex items-center justify-between text-[13px] text-brand-muted">
                  <b className="text-base text-brand-text">Библиотека</b>
                  <span>212 игр · 180 запускаются</span>
                </div>
                <div className="grid grid-cols-6 gap-2.5">
                  {demoAppIds.map((appId, i) => {
                    const hot =
                      i === HOT_TILE &&
                      cues.has("tile-hot") &&
                      !cues.has("tile-cool");
                    const check = i % 5 === 3;
                    return (
                      <div
                        key={appId}
                        ref={i === HOT_TILE ? hotTileRef : undefined}
                        className={cn(
                          "relative aspect-[2/3] overflow-hidden rounded-lg bg-[#141834] transition-[transform,box-shadow] duration-300",
                          hot &&
                            "z-[2] scale-112 shadow-[0_20px_40px_rgba(0,0,0,0.6),0_0_0_2px_#3cc2ff]",
                        )}
                      >
                        <img
                          src={coverUrl(appId)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="block size-full object-cover"
                        />
                        <span
                          className={cn(
                            "absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 text-[9px] font-bold text-[#04140c]",
                            check
                              ? "bg-[rgba(255,209,102,0.9)]"
                              : "bg-[rgba(61,220,151,0.9)]",
                          )}
                        >
                          {check ? "ПРОВЕРЬ" : "ОК"}
                        </span>
                        <div
                          className={cn(
                            "absolute inset-x-0 bottom-0 bg-[linear-gradient(transparent,rgba(0,0,0,0.85))] p-2 transition-opacity duration-300",
                            hot ? "opacity-100" : "opacity-0",
                          )}
                        >
                          <b className="block rounded-md bg-brand-gradient p-1.5 text-center text-[11px] text-white">
                            Играть
                          </b>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Phase>

            <Phase on={phase === 2}>
              <div className="relative aspect-video w-[min(600px,92%)] overflow-hidden rounded-[14px] border border-white/12 bg-[#0b0e1f] shadow-[0_30px_60px_rgba(0,0,0,0.6)]">
                <div
                  className={cn(
                    "absolute inset-0 flex flex-col items-center justify-center gap-3.5 font-mono text-[13px] text-[#c9cdf0] transition-opacity duration-400",
                    cues.has("playing") && "opacity-0",
                  )}
                >
                  <span>{bootText}</span>
                  <div className="h-1 w-[220px] overflow-hidden rounded bg-white/8">
                    <i
                      key={run}
                      className="block h-full w-0 bg-brand-gradient"
                      style={
                        phase === 2 && started && !reduced
                          ? { animation: "gc-fill 1.6s ease-in-out forwards" }
                          : undefined
                      }
                    />
                  </div>
                </div>
                <div
                  className={cn(
                    "absolute inset-0 transition-opacity duration-600",
                    cues.has("playing") ? "opacity-100" : "opacity-0",
                  )}
                >
                  <StreamVideo active={phase === 2} />
                  <div className="absolute top-2.5 left-2.5 rounded bg-black/45 px-2 py-1 font-mono text-[11px] text-brand-ok">
                    ● 60 FPS · 14 ms
                  </div>
                </div>
              </div>
            </Phase>
          </div>
        </div>
      </div>
    </section>
  );
}

function Phase({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-500",
        on ? "opacity-100" : "translate-y-3.5 scale-[0.98] opacity-0",
      )}
      aria-hidden={!on}
    >
      {children}
    </div>
  );
}
