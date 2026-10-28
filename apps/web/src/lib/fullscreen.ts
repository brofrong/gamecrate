// Полный экран сессии (спека §2.4): `requestFullscreen` на корне экрана (`<main>` — кнопки и
// статистика остаются поверх стрима) и захват клавиш `navigator.keyboard.lock()` (Chrome/Edge):
// Esc и системные сочетания уходят в игру, выход — удержанием Esc. Где Keyboard Lock API нет
// (Safari, Firefox) — просто полный экран. После входа и после закрытия меню фокус — в iframe
// стрима, чтобы клавиши снова шли в игру.
import { useEffect, useState } from "react";

/** Keyboard Lock API — пока не в `lib.dom.d.ts`, поэтому локальное расширение `Navigator`. */
type KeyboardLockNavigator = Navigator & {
  readonly keyboard?: {
    readonly lock?: (keyCodes?: ReadonlyArray<string>) => Promise<void>;
    readonly unlock?: () => void;
  };
};

const keyboard = () => (navigator as KeyboardLockNavigator).keyboard;

/** Отдаёт фокус стриму: сам iframe и его окно (иначе клавиши остаются на странице). */
export function focusStream(frame: HTMLIFrameElement | null): void {
  if (frame === null) return;
  try {
    frame.focus();
    frame.contentWindow?.focus();
  } catch {
    // окно iframe выгружается/недоступно — фокус вернётся со следующим кликом по игре.
  }
}

/**
 * Полный экран на `root`, затем захват клавиш (его отказ — не ошибка: остаётся обычный полный
 * экран) и фокус в стрим. Отказ самого `requestFullscreen` пробрасывается.
 */
export async function enterFullscreen(
  root: HTMLElement,
  frame: HTMLIFrameElement | null,
): Promise<void> {
  await root.requestFullscreen();
  try {
    await keyboard()?.lock?.();
  } catch {
    // нет разрешения/не поддерживается — см. выше.
  }
  focusStream(frame);
}

/** Страница сейчас в полном экране; при выходе из него снимает захват клавиш. */
export function useIsFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(
    () => document.fullscreenElement != null,
  );

  useEffect(() => {
    const onChange = () => {
      const now = document.fullscreenElement != null;
      setFullscreen(now);
      if (!now) keyboard()?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  return fullscreen;
}
