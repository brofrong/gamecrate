// Статус игрока для трея десктоп-приложения (`set_status`): от него зависят строка в меню трея
// и крестик окна (в очереди и в игре окно прячется в трей). В браузере всё — no-op
// (`desktopSetStatus` без моста ничего не делает).
//
// Кто шлёт: `QueueWatcher` (живёт, пока есть активная сессия, на любой странице) зеркалит
// состояние сервера; экран игры снова ставит `starting`/`playing`, когда игрок на него
// возвращается, и `idle`, когда уходит с него (игра без игрока доживает до таймаута простоя —
// держать приложение в трее ради неё незачем). Оба берут статус из `desktopStatusOf`, поэтому
// порядок их эффектов в одном рендере не важен. `idle` экрана игры держится до следующей смены
// статуса на сервере: ушёл с экрана, пока сервер запускался, — переход в `playing` снова
// поставит `playing`. Это нарочно: сессия жива и тратит время, крестик прячет окно в трей.
// Уход окна с сайта (заглушка без сети) сбрасывает статус в самом приложении.
import type { SessionView } from "@cg/rpc";
import { useEffect, useRef } from "react";
import { type DesktopStatus, desktopSetStatus } from "./desktop";

const idle: DesktopStatus = { kind: "idle" };

/** Статус трея по состоянию сессии. Место 0 — сервер ещё не посчитал очередь. */
export const desktopStatusOf = (view: SessionView): DesktopStatus => {
  switch (view.state) {
    case "queued":
      return {
        kind: "queued",
        position: view.queue?.position ?? 0,
        total: view.queue?.total ?? 0,
        etaMinutes: view.queue?.etaMinutes ?? null,
      };
    case "installing":
    case "starting":
      return { kind: "starting" };
    case "playing":
    case "idle_warning":
    case "disconnected":
      return { kind: "playing" };
    case "stopping":
    case "ended":
    case "failed":
      return idle;
  }
};

/** Ключ статуса: эффект срабатывает только когда статус и правда сменился. */
const statusKey = (view: SessionView | undefined): string | undefined =>
  view === undefined ? undefined : JSON.stringify(desktopStatusOf(view));

/** `QueueWatcher`: каждый новый статус — в трей; без сессии (размонтирование) — `idle`. */
export function useDesktopStatusMirror(view: SessionView | undefined): void {
  const key = statusKey(view);
  useEffect(() => {
    if (key === undefined) return;
    void desktopSetStatus(JSON.parse(key) as DesktopStatus);
  }, [key]);
  useEffect(() => () => void desktopSetStatus(idle), []);
}

/** Экран игры: `starting`/`playing` — в трей; ушёл с экрана после них — `idle`. */
export function useDesktopGameStatus(view: SessionView | undefined): void {
  const sent = useRef(false);
  const key = statusKey(view);
  useEffect(() => {
    if (key === undefined) return;
    const status = JSON.parse(key) as DesktopStatus;
    if (status.kind !== "starting" && status.kind !== "playing") return;
    sent.current = true;
    void desktopSetStatus(status);
  }, [key]);
  useEffect(
    () => () => {
      if (sent.current) void desktopSetStatus(idle);
    },
    [],
  );
}
