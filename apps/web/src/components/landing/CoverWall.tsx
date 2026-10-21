// Стена обложек Steam за hero: ряды едут сами, ряд под курсором тормозит до остановки и
// подсвечивается, после ухода курсора разгоняется. Стена наклонена статически и не
// реагирует на курсор целиком (укачивает). Цикл идёт только пока секция видна;
// при reduced motion ряды стоят.
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { initialRows, stepRows } from "@/lib/coverWallPhysics";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { cn } from "@/lib/utils";
import { coverUrl, headerUrl, heroAppIds } from "./data";

const MAX_DT = 0.05;

function Cover({ appId }: { appId: number }) {
  const [state, setState] = useState<"loading" | "ok" | "fallback" | "failed">(
    "loading",
  );
  const onError = (e: SyntheticEvent<HTMLImageElement>) => {
    if (state === "fallback" || state === "failed") {
      setState("failed");
      return;
    }
    e.currentTarget.src = headerUrl(appId);
    setState("fallback");
  };
  return (
    <div
      className="relative h-[225px] w-[150px] shrink-0 overflow-hidden rounded-[10px] bg-[#141834] shadow-[0_20px_40px_rgba(0,0,0,0.5)] transition-[transform,box-shadow] duration-400 ease-out group-[.hold]:-translate-y-1 group-[.hold]:shadow-[0_26px_50px_rgba(0,0,0,0.6),0_0_0_1px_rgba(60,194,255,0.35)]"
      data-failed={state === "failed" ? "" : undefined}
    >
      <img
        src={coverUrl(appId)}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setState("ok")}
        onError={onError}
        className={cn(
          "block size-full object-cover transition-opacity duration-600",
          state === "ok" || state === "fallback" ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

export function CoverWall({
  rows = 5,
  perRow = 12,
}: {
  rows?: number;
  perRow?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const wallRef = useRef<HTMLDivElement>(null);
  const heldRef = useRef<number | null>(null);

  useEffect(() => {
    const wall = wallRef.current;
    if (!wall || reduced) return;
    const section = wall.parentElement ?? wall;
    const rowEls = Array.from(wall.querySelectorAll<HTMLElement>("[data-row]"));
    let motion = initialRows(rowEls.length);
    let frame = 0;
    let last = 0;
    let visible = typeof IntersectionObserver === "undefined";

    const tick = (now: number) => {
      frame = 0;
      if (!visible) return;
      const dt = Math.min(MAX_DT, last ? (now - last) / 1000 : 0);
      last = now;
      motion = stepRows(
        motion,
        heldRef.current,
        dt,
        (i) => (rowEls[i]?.scrollWidth ?? 0) / 2,
      );
      rowEls.forEach((el, i) => {
        el.style.transform = `translateX(${(motion[i]?.x ?? 0).toFixed(2)}px)`;
      });
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    const setHeld = (row: HTMLElement | null) => {
      const index = row ? Number(row.dataset.row) : null;
      if (index === heldRef.current) return;
      rowEls.forEach((el, i) => el.classList.toggle("hold", i === index));
      heldRef.current = index;
    };
    // Только мышь: на тач-устройствах браузер синтезирует move без leave, и ряд
    // «залипал» бы после тапа.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const row = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>("[data-row]");
      setHeld(row ?? null);
    };
    const onLeave = () => setHeld(null);
    section.addEventListener("pointermove", onMove);
    section.addEventListener("pointerleave", onLeave);

    let observer: IntersectionObserver | undefined;
    if (visible) start();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          visible = entries.some((e) => e.isIntersecting);
          if (visible) start();
          else stop();
        },
        { threshold: 0.05 },
      );
      observer.observe(section);
    }

    return () => {
      stop();
      observer?.disconnect();
      section.removeEventListener("pointermove", onMove);
      section.removeEventListener("pointerleave", onLeave);
    };
  }, [reduced]);

  return (
    <div
      ref={wallRef}
      aria-hidden="true"
      className="absolute -inset-y-[18%] -inset-x-[20%] z-0 origin-[50%_40%] [transform:perspective(1400px)_rotateX(18deg)_rotateZ(-8deg)_scale(1.08)]"
    >
      {Array.from({ length: rows }, (_, i) => {
        const ids = Array.from(
          { length: perRow },
          (_, j) => heroAppIds[(i * 7 + j * 3) % heroAppIds.length] as number,
        );
        return (
          <div
            key={i}
            data-row={i}
            className="group mb-3.5 flex w-max gap-3.5 will-change-transform"
          >
            {[...ids, ...ids].map((appId, j) => (
              <Cover key={`${appId}-${j}`} appId={appId} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
