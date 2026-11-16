// Полный экран сессии (спека §2.4): `requestFullscreen` на корне экрана (`<main>` — кнопки и
// статистика остаются поверх стрима) и захват клавиш `navigator.keyboard.lock()` (Chrome/Edge):
// Esc и системные сочетания уходят в игру, выход — удержанием Esc. Где Keyboard Lock API нет
// (Safari, Firefox) — просто полный экран. После входа и после закрытия меню фокус — в iframe
// стрима, чтобы клавиши снова шли в игру. Мышь захватывается сразу при входе (слово владельца
// 2026-11-03), а отпущенная — снова кликом по игре (`lockPointerOnClick`). Нажатия Esc для
// подсказки «зажми Esc» — `watchEscape`.
//
// В десктоп-приложении (`isDesktop()`) полный экран — нативный, окна (`enter_game_fullscreen`):
// на macOS и Linux без HTML Fullscreen API — в WKWebView Esc из него сразу выходит, а в нативном
// полном экране Esc уходит в игру. На Windows (WebView2, Chromium) — ещё `requestFullscreen` и
// `keyboard.lock()`, если они есть: так Win и Alt+Tab уходят в игру. Состояние — по событию
// приложения (`onDesktopGameFullscreen`), выход — удержанием Esc (`escHold`) через
// `exit_game_fullscreen`.
import { useEffect, useState } from "react";
import {
  desktopAppInfo,
  desktopEnterGameFullscreen,
  desktopExitGameFullscreen,
  isDesktop,
  onDesktopGameFullscreen,
} from "./desktop";

/** Keyboard Lock API — пока не в `lib.dom.d.ts`, поэтому локальное расширение `Navigator`. */
type KeyboardLockNavigator = Navigator & {
  readonly keyboard?: {
    readonly lock?: (keyCodes?: ReadonlyArray<string>) => Promise<void>;
    readonly unlock?: () => void;
  };
};

const keyboard = () => (navigator as KeyboardLockNavigator).keyboard;

/**
 * Есть Keyboard Lock API (Chrome, Edge, Яндекс Браузер): в полном экране Esc уходит в игру, а
 * выход — удержанием Esc. Без него (Safari, Firefox) Esc выходит сразу.
 */
export const keyboardLockSupported = (): boolean =>
  typeof keyboard()?.lock === "function";

/**
 * Сколько держать Esc до выхода из полного экрана с захваченными клавишами: `kHoldEscapeTime`
 * в Chromium (`chrome/browser/ui/exclusive_access/keyboard_lock_controller.cc`) — 1,5 с.
 */
export const ESC_HOLD_MS = 1_500;

/**
 * Esc в полном экране уходит в игру, а выход — удержанием: в приложении всегда (нативный полный
 * экран Esc не закрывает), в браузере — с Keyboard Lock API.
 */
export const escHoldExits = (): boolean =>
  isDesktop() || keyboardLockSupported();

/**
 * Таймер удержания Esc для приложения (в браузере выход по удержанию делает сам Chrome):
 * `down` — нажали, `up` — отпустили, через `ESC_HOLD_MS` без отпускания — `onHold`.
 */
export function escHold(onHold: () => void): {
  readonly down: () => void;
  readonly up: () => void;
  readonly stop: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    down: () => {
      stop();
      timer = setTimeout(() => {
        timer = undefined;
        onHold();
      }, ESC_HOLD_MS);
    },
    up: stop,
    stop,
  };
}

/** Выход из HTML-полного экрана страницы, если он есть; отказ — не ошибка. */
const leavePageFullscreen = async (): Promise<void> => {
  if (document.fullscreenElement == null) return;
  try {
    await document.exitFullscreen();
  } catch {
    // уже вышли / документ выгружается.
  }
};

/** Выход из игрового полного экрана приложения (и полного экрана страницы на Windows). */
export async function exitGameFullscreen(): Promise<void> {
  await leavePageFullscreen();
  await desktopExitGameFullscreen();
}

/**
 * Windows: полный экран страницы и захват клавиш. Захват отказал — полный экран страницы
 * снимаем: остаётся нативный, как на macOS.
 */
const lockKeysInPageFullscreen = async (root: HTMLElement): Promise<void> => {
  try {
    await root.requestFullscreen();
  } catch {
    return;
  }
  try {
    await keyboard()?.lock?.();
  } catch {
    await leavePageFullscreen();
  }
};

/** Вход в приложении: нативный полный экран окна (+ на Windows полный экран страницы и захват). */
const enterDesktopFullscreen = async (root: HTMLElement): Promise<void> => {
  const info = await desktopAppInfo();
  if (info?.os === "windows" && keyboardLockSupported()) {
    await lockKeysInPageFullscreen(root);
  }
  await desktopEnterGameFullscreen();
};

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
 * Захват мыши (его отказ — не ошибка: мышь захватит первый клик по игре), полный экран на
 * `root`, захват клавиш (отказ — тоже не ошибка: остаётся обычный полный экран) и фокус в стрим.
 * Мышь — до полного экрана, в том же жесте: Chrome тратит жест пользователя на
 * `requestFullscreen`, и захват после него получает отказ «нужен жест» (проверено 2026-11-03:
 * Chrome 156 — только в этом порядке, Яндекс Браузер 26.10 — в любом). Отказ самого
 * `requestFullscreen` пробрасывается, захваченная мышь при этом отпускается.
 */
export async function enterFullscreen(
  root: HTMLElement,
  frame: HTMLIFrameElement | null,
): Promise<void> {
  focusStream(frame);
  if (frame !== null) lockPointer(frame);
  if (isDesktop()) {
    await enterDesktopFullscreen(root);
    focusStream(frame);
    return;
  }
  try {
    await root.requestFullscreen();
  } catch (error) {
    if (frame !== null) unlockPointer(frame);
    throw error;
  }
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
  | "addEventListener"
  | "removeEventListener"
  | "pointerLockElement"
  | "exitPointerLock"
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
 * Захватывает мышь на элементе ввода Selkies, если она ещё не захвачена. Отказ браузера (нет
 * жеста, окно не в фокусе) — не ошибка: останется обычный курсор.
 */
function lockPointer(frame: HTMLIFrameElement): void {
  try {
    if (frame.contentDocument?.pointerLockElement != null) return;
    const element = selkiesInputElement(frame);
    if (element === null) return;
    Promise.resolve(element.requestPointerLock()).catch(() => {});
  } catch {
    // окно iframe выгружается/недоступно.
  }
}

/** Отпускает мышь, если она захвачена в документе iframe. */
function unlockPointer(frame: HTMLIFrameElement): void {
  try {
    const doc = frame.contentDocument;
    if (doc?.pointerLockElement != null) doc.exitPointerLock();
  } catch {
    // окно iframe выгружается/недоступно.
  }
}

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
      lockPointer(frame);
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

/**
 * Страница сейчас в полном экране; при выходе из него снимает захват клавиш. В приложении — по
 * событию приложения (игровой полный экран окна), а выход из полного экрана страницы во время
 * игры (Windows) выводит и окно.
 */
export function useIsFullscreen(): boolean {
  const desktop = isDesktop();
  const [fullscreen, setFullscreen] = useState(
    () => !desktop && document.fullscreenElement != null,
  );

  useEffect(() => {
    if (desktop) {
      let game = false;
      const stopEvents = onDesktopGameFullscreen((on) => {
        game = on;
        setFullscreen(on);
        if (!on) {
          keyboard()?.unlock?.();
          void leavePageFullscreen();
        }
      });
      const onPageChange = () => {
        if (document.fullscreenElement != null || !game) return;
        keyboard()?.unlock?.();
        void desktopExitGameFullscreen();
      };
      document.addEventListener("fullscreenchange", onPageChange);
      return () => {
        stopEvents();
        document.removeEventListener("fullscreenchange", onPageChange);
      };
    }
    const onChange = () => {
      const now = document.fullscreenElement != null;
      setFullscreen(now);
      if (!now) keyboard()?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [desktop]);

  return fullscreen;
}

const isEscape = (event: Event): boolean => {
  const { code, key } = event as KeyboardEvent;
  return code === "Escape" || key === "Escape";
};

/**
 * Нажатие и отпускание Esc — в окне iframe стрима (там фокус в полном экране; подписка
 * переставляется на каждую загрузку iframe) и в документе страницы (фокус ушёл на наши кнопки).
 * Автоповтор удержания (`repeat`) — не новое нажатие. Возвращает «стоп».
 *
 * Именно окно iframe, а не его документ: Selkies слушает клавиши на `window` в фазе захвата и
 * в Chrome гасит каждое нажатие и отпускание (`stopPropagation`, `selkies-core.js` образа,
 * проверено 2026-11-05) — до документа они не доходят. Слушателей того же окна это не задевает.
 */
export function watchEscape(
  frame: HTMLIFrameElement,
  handlers: { readonly onDown: () => void; readonly onUp: () => void },
): () => void {
  const onKeyDown = (event: Event) => {
    if (isEscape(event) && !(event as KeyboardEvent).repeat) handlers.onDown();
  };
  const onKeyUp = (event: Event) => {
    if (isEscape(event)) handlers.onUp();
  };
  const listen = (
    target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  ) => {
    target.addEventListener("keydown", onKeyDown, true);
    target.addEventListener("keyup", onKeyUp, true);
    return () => {
      target.removeEventListener("keydown", onKeyDown, true);
      target.removeEventListener("keyup", onKeyUp, true);
    };
  };

  let detachFrame = () => {};
  const attach = () => {
    detachFrame();
    detachFrame = () => {};
    try {
      const win = frame.contentWindow;
      if (win !== null) detachFrame = listen(win);
    } catch {
      // окно iframe чужого origin или выгружается — следующая загрузка подпишет заново.
    }
  };

  attach();
  frame.addEventListener("load", attach);
  const detachPage = listen(document);
  return () => {
    frame.removeEventListener("load", attach);
    detachFrame();
    detachPage();
  };
}
