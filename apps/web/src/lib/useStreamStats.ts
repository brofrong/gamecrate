// Сбор статистики стрима для отладочной плашки (спека §3, бриф задачи 5). Пока отладка не
// «Выкл»: раз в секунду — выборка Selkies из окна iframe (`readSelkiesStats`) и снимок окна в
// минуту; время каждого показанного кадра — `requestVideoFrameCallback` на `<video>` Selkies
// (тот же origin). «Выкл» — ни таймеров, ни колбэков кадров, сбор у Selkies выключен.
import type { DebugMode } from "@cg/rpc";
import { useEffect, useState } from "react";
import { readSelkiesStats, type SelkiesBridge } from "./selkiesBridge";
import { createStatsWindow, type StatsSnapshot } from "./streamStats";

/** Как часто брать выборку Selkies и обновлять плашку. */
export const STATS_TICK_MS = 1_000;

/** `<video>` Selkies в документе iframe; нет окна/документа или доступ запрещён — `null`. */
function findVideo(bridge: SelkiesBridge): HTMLVideoElement | null {
  try {
    return bridge.frameWindow()?.document.querySelector("video") ?? null;
  } catch {
    return null;
  }
}

/**
 * Снимок статистики стрима или `null` («Выкл», ещё нет первой выборки, новый документ стрима).
 * Время кадра — разность `now` соседних колбэков кадра (часы iframe), метка точки —
 * `performance.now()` страницы (часы окна статистики). Смена `frameGeneration` (новый документ
 * стрима — новые глобалы и новый `<video>`) — окно очищается, колбэк регистрируется заново.
 * Без `requestVideoFrameCallback` кадров нет, FPS — из выборки Selkies.
 */
export function useStreamStats(
  bridge: SelkiesBridge,
  frameGeneration: number,
  mode: DebugMode,
): StatsSnapshot | null {
  const active = mode !== "off";
  const [stats] = useState(createStatsWindow);
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);

  useEffect(() => {
    bridge.setStatsOpen(active);
  }, [bridge, active]);

  useEffect(() => {
    if (!active) return;
    stats.clear();

    let video: HTMLVideoElement | null = null;
    let handle: number | null = null;
    let lastFrameNow: number | null = null;

    const release = () => {
      if (video !== null && handle !== null) {
        try {
          video.cancelVideoFrameCallback(handle);
        } catch {
          // документ уже выгружен — колбэк и так не придёт.
        }
      }
      video = null;
      handle = null;
      lastFrameNow = null;
    };

    const watch = (target: HTMLVideoElement) => {
      const onFrame: VideoFrameRequestCallback = (now) => {
        // Колбэк прошлой регистрации (другой `<video>` или уже снятый хук) — молча выходим.
        if (video !== target) return;
        if (lastFrameNow !== null)
          stats.addFrame(performance.now(), now - lastFrameNow);
        lastFrameNow = now;
        handle = target.requestVideoFrameCallback(onFrame);
      };
      handle = target.requestVideoFrameCallback(onFrame);
    };

    // `<video>` сменился (Selkies пересоздал плеер) — перерегистрируемся на новом.
    const sync = () => {
      const next = findVideo(bridge);
      if (next === video) return;
      release();
      video = next;
      if (next !== null && typeof next.requestVideoFrameCallback === "function")
        watch(next);
    };

    const tick = () => {
      const at = performance.now();
      const sample = readSelkiesStats(bridge.frameWindow());
      if (sample !== null) stats.addSample(at, sample);
      sync();
      setSnapshot(stats.snapshot(at));
    };

    sync();
    const timer = setInterval(tick, STATS_TICK_MS);
    return () => {
      clearInterval(timer);
      release();
      setSnapshot(null);
    };
    // `frameGeneration` в зависимостях: новый документ стрима — очистка и новая регистрация.
  }, [bridge, frameGeneration, active, stats]);

  return active ? snapshot : null;
}
