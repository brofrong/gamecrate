// Общий цикл рисования на canvas: размер по родителю × devicePixelRatio, пересчёт на
// resize, рисуем только пока видно (IntersectionObserver), при reduced motion — по
// одному кадру вместо rAF, при размонтировании всё отписывается. `draw` читается из
// ref, чтобы новый замыкание на каждом рендере не перезапускало цикл.
import { type RefObject, useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export type CanvasSize = { width: number; height: number };
export type DrawFrame = (
  ctx: CanvasRenderingContext2D,
  size: CanvasSize,
  time: number,
) => void;

export function useCanvasLoop(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  draw: DrawFrame,
): void {
  const reduced = usePrefersReducedMotion();
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const host = canvas.parentElement ?? canvas;

    const size: CanvasSize = { width: 0, height: 0 };
    let visible = typeof IntersectionObserver === "undefined";
    let frame = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const box = host.getBoundingClientRect();
      size.width = box.width;
      size.height = box.height;
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const once = () => drawRef.current(ctx, size, performance.now());
    const tick = (time: number) => {
      frame = 0;
      if (!visible) return;
      drawRef.current(ctx, size, time);
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (reduced) {
        once();
        return;
      }
      if (visible && !frame) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    const onResize = () => {
      resize();
      start();
    };
    resize();
    window.addEventListener("resize", onResize);

    let observer: IntersectionObserver | undefined;
    if (!visible) {
      observer = new IntersectionObserver(
        (entries) => {
          visible = entries.some((e) => e.isIntersecting);
          if (visible) start();
          else stop();
        },
        { threshold: 0.05 },
      );
      observer.observe(host);
    } else {
      start();
    }

    return () => {
      stop();
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [canvasRef, reduced]);
}
