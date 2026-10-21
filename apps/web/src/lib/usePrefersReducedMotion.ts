// Системная настройка «уменьшить движение»: анимации лендинга отключаются или
// сводятся к мгновенным переходам. matchMedia читаем при вызове, а не при импорте —
// тесты подменяют его после загрузки модуля.
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

const query = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : undefined;

/** Текущее значение `prefers-reduced-motion`; без `matchMedia` — `false`. */
export function prefersReducedMotion(): boolean {
  return query()?.matches ?? false;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    const mql = query();
    if (!mql) return;
    const update = () => setReduced(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return reduced;
}
