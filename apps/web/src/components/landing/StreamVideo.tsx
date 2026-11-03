// «Стрим» на лендинге: зацикленная нарезка геймплея из трейлеров Steam (Elden Ring,
// Forza Horizon 5, DOOM Eternal, GTA V, Cyberpunk 2077; 854×480, без звука, ~3,4 МБ).
// Грузится и играет, только пока виден на экране и `active`; при reduced motion —
// только постер. Один ролик на экране ноутбука в «Технологии» и в демо «Как это работает».
import { useEffect, useRef, useState } from "react";
import poster from "@/assets/landing/landing-stream.jpg";
import src from "@/assets/landing/landing-stream.mp4";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { cn } from "@/lib/utils";

export function StreamVideo({
  active = true,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const reduced = usePrefersReducedMotion();
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (active && visible && !reduced) {
      // Автоплей без звука браузеры разрешают; отказ (энергосбережение) — остаётся постер.
      el.play()?.catch(() => {});
    } else {
      el.pause();
    }
  }, [active, visible, reduced]);

  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      className={cn("block size-full object-cover", className)}
    />
  );
}
