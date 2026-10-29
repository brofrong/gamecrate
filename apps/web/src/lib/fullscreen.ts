// Полный экран сессии (спека §2.4): `requestFullscreen` на корне экрана (`<main>` — кнопки и
// статистика остаются поверх стрима) и захват клавиш `navigator.keyboard.lock()` (Chrome/Edge):
// Esc и системные сочетания уходят в игру, выход — удержанием Esc. Где Keyboard Lock API нет
// (Safari, Firefox) — просто полный экран. После входа и после закрытия меню фокус — в iframe
// стрима, чтобы клавиши снова шли в игру. В полном экране клик по игре захватывает мышь
// (`lockPointerOnClick`).
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

/** Документ окна iframe Selkies с Pointer Lock API (у `Document` из `lib.dom.d.ts` он есть). */
type FrameDocument = Pick<
  Document,
  "addEventListener" | "removeEventListener" | "pointerLockElement" | "exitPointerLock"
>;

/** Элемент ввода Selkies (`window.webrtcInput.element` окна iframe) или `null`, пока его нет. */
const selkiesInputElement = (frame: HTMLIFrameElement): Element | null => {
  const input = (
    frame.contentWindow as { webrtcInput?: { element?: unknown } } | null
  )?.webrtcInput;
  const element = input?.element;
  return typeof element === "object" && element !== null
    ? (element as Element)
    : null;
};

/**
 * Захват мыши в полном экране (слово владельца 2026-10-29): левый клик по игре захватывает мышь
 * на элементе ввода Selkies. Тогда Selkies сам шлёт в игру движение (`m2`), а не положение
 * курсора — без этого камера в играх от первого лица не крутится, а после смены размера окна
 * координаты сбиваются совсем. Сам Selkies захватывает мышь только в своём полном экране
 * (документа iframe) или по Ctrl+Shift+клику; наш полный экран — на `<main>` страницы.
 *
 * Слушает `mousedown` в документе iframe (тот же origin; клик — жест пользователя в этом окне,
 * его хватает для `requestPointerLock`) и переподписывается на каждую загрузку iframe. Возвращает
 * «стоп»: снимает слушатели и отпускает мышь. Выход из захвата в полном экране — удержание Esc.
 */
export function lockPointerOnClick(frame: HTMLIFrameElement): () => void {
  let detachDocument = () => {};

  const attach = () => {
    detachDocument();
    detachDocument = () => {};
    let doc: FrameDocument | null;
    try {
      doc = frame.contentDocument;
    } catch {
      return;
    }
    if (doc === null) return;
    const target = doc;
    const onMouseDown = (event: Event) => {
      if ((event as MouseEvent).button !== 0) return;
      if (target.pointerLockElement != null) return;
      const element = selkiesInputElement(frame);
      if (element === null) return;
      // Отказ браузера (нет жеста, окно не в фокусе) — останется обычный курсор.
      Promise.resolve(element.requestPointerLock()).catch(() => {});
    };
    target.addEventListener("mousedown", onMouseDown, true);
    detachDocument = () => {
      target.removeEventListener("mousedown", onMouseDown, true);
      if (target.pointerLockElement != null) target.exitPointerLock();
    };
  };

  attach();
  frame.addEventListener("load", attach);
  return () => {
    frame.removeEventListener("load", attach);
    detachDocument();
  };
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
