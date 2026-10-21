// Прогресс сворачивания логотипа 0..1 по вертикальному скроллу: цель —
// clamp((scrollY − start) / span), к ней значение подтягивается в rAF с коэффициентом
// 0.14. При reduced motion — мгновенное переключение между 0 и 1 без rAF.
import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";

const SMOOTHING = 0.14;
const EPSILON = 0.0005;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function useScrollProgress(start = 20, span = 140): number {
  const reduced = usePrefersReducedMotion();
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let current = 0;
    let frame = 0;
    const target = () => clamp01((window.scrollY - start) / span);

    const tick = () => {
      frame = 0;
      const t = target();
      if (Math.abs(t - current) < EPSILON) {
        current = t;
      } else {
        current += (t - current) * SMOOTHING;
        frame = requestAnimationFrame(tick);
      }
      setProgress(current);
    };

    const onScroll = () => {
      if (reduced) {
        current = target() > 0.5 ? 1 : 0;
        setProgress(current);
        return;
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [reduced, start, span]);

  return progress;
}
