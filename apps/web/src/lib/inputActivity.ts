// Время последнего ввода пользователя на странице сессии — для `inputAgeMs` в heartbeat.
// Источники: клавиатура/мышь в документе страницы и в документе iframe стрима (тот же
// origin через /stream/<id>/) и изменения состояния геймпадов (опрос navigator.getGamepads()
// страницы и окна iframe: браузер отдаёт свежие данные геймпада только окну с фокусом,
// а во время игры фокус в iframe).
// Часы монотонные (`performance.now()`): часам клиента сервер не доверяет.
import { useCallback, useEffect, useMemo, useRef } from "react";

/** События, которые считаются вводом. */
export const inputEvents = [
  "keydown",
  "pointermove",
  "pointerdown",
  "wheel",
] as const;

/** Как часто опрашивать геймпады. */
export const GAMEPAD_POLL_MS = 250;

/** Мёртвая зона стиков: дрожание ближе этого к прошлому положению — не ввод. */
export const GAMEPAD_DEAD_ZONE = 0.15;

/** Нажатие курка/кнопки меньше этого — не ввод (аналоговые кнопки тоже шумят). */
const BUTTON_DEAD_ZONE = 0.1;

/** Состояние одного геймпада; `null` — слота нет или геймпад отключён. */
export type PadSnapshot = {
  readonly axes: ReadonlyArray<number>;
  readonly buttons: ReadonlyArray<number>;
} | null;

export const snapshotGamepads = (
  pads: ReadonlyArray<Gamepad | null>,
): ReadonlyArray<PadSnapshot> =>
  pads.map((pad) =>
    pad === null
      ? null
      : {
          axes: Array.from(pad.axes),
          buttons: Array.from(pad.buttons, (button) =>
            button.pressed ? Math.max(button.value, 1) : button.value,
          ),
        },
  );

const moved = (
  before: ReadonlyArray<number>,
  after: ReadonlyArray<number>,
  deadZone: number,
) =>
  after.some((value, i) => Math.abs(value - (before[i] ?? value)) > deadZone);

/**
 * Был ли ввод с геймпада между снимками: стик сдвинулся дальше мёртвой зоны или
 * кнопка нажата/отпущена. Подключение и отключение геймпада вводом не считаются.
 */
export const gamepadsChanged = (
  before: ReadonlyArray<PadSnapshot>,
  after: ReadonlyArray<PadSnapshot>,
  deadZone: number = GAMEPAD_DEAD_ZONE,
): boolean =>
  after.some((pad, i) => {
    const prev = before[i];
    if (pad == null || prev == null) return false;
    return (
      moved(prev.axes, pad.axes, deadZone) ||
      moved(prev.buttons, pad.buttons, BUTTON_DEAD_ZONE)
    );
  });

/** Слушать ввод в документе; возвращает отписку. */
export function listenForInput(target: Document, onInput: () => void) {
  const options = { capture: true, passive: true } as const;
  for (const type of inputEvents) {
    target.addEventListener(type, onInput, options);
  }
  return () => {
    for (const type of inputEvents) {
      target.removeEventListener(type, onInput, options);
    }
  };
}

/** Окно, у которого спрашиваем геймпады: страница или окно iframe стрима. */
export type GamepadWindow = {
  readonly navigator: Pick<Navigator, "getGamepads">;
};

const readGamepads = (
  win: GamepadWindow,
): ReadonlyArray<Gamepad | null> | undefined => {
  try {
    return win.navigator.getGamepads?.() ?? [];
  } catch {
    // Чужой origin у iframe (доступ к navigator бросает) или Permissions Policy
    // запретила Gamepad API — у этого окна геймпадов просто нет.
    return undefined;
  }
};

/**
 * Опрос геймпадов в нескольких окнах. У каждого окна свой снимок, с которым
 * сравнивается следующий опрос; первый опрос окна (например, после перезагрузки
 * iframe) только запоминает положение. Окна, которых больше нет в списке, забываются.
 */
export function createGamepadWatcher(onInput: () => void) {
  const baselines = new Map<GamepadWindow, ReadonlyArray<PadSnapshot>>();
  return {
    poll(windows: ReadonlyArray<GamepadWindow | null | undefined>) {
      let input = false;
      const seen = new Set<GamepadWindow>();
      for (const win of windows) {
        if (win == null) continue;
        seen.add(win);
        const pads = readGamepads(win);
        if (pads === undefined) continue;
        const next = snapshotGamepads(pads);
        const baseline = baselines.get(win);
        if (baseline === undefined) {
          baselines.set(win, next);
        } else if (gamepadsChanged(baseline, next)) {
          input = true;
          baselines.set(win, next);
        } else {
          // Сравниваем с положением при последнем засчитанном вводе, а не с прошлым
          // опросом: иначе медленный наклон стика (меньше мёртвой зоны за 250 мс) не
          // засчитался бы никогда.
          baselines.set(
            win,
            next.map((pad, i) => (pad === null ? null : (baseline[i] ?? pad))),
          );
        }
      }
      for (const win of baselines.keys()) {
        if (!seen.has(win)) baselines.delete(win);
      }
      if (input) onInput();
    },
  };
}

export type InputActivity = {
  /** Мс с последнего ввода (до первого ввода — с открытия страницы сессии). */
  readonly ageMs: () => number;
  /** Отметить ввод сейчас (например, «Я здесь»). */
  readonly touch: () => void;
  /**
   * Подписаться на документ загруженного iframe и опрашивать геймпады его окна
   * (вызывать на каждый `load`).
   */
  readonly attachFrame: (frame: HTMLIFrameElement) => void;
};

/** Отслеживание последнего ввода, пока смонтирован компонент. */
export function useInputActivity(): InputActivity {
  const lastInput = useRef(performance.now());
  const detachFrame = useRef<(() => void) | undefined>(undefined);
  /** Окно iframe стрима: его геймпады опрашиваются вместе с геймпадами страницы. */
  const frameWindow = useRef<GamepadWindow | null>(null);

  const touch = useCallback(() => {
    lastInput.current = performance.now();
  }, []);

  useEffect(() => {
    const detach = listenForInput(document, touch);
    const watcher = createGamepadWatcher(touch);
    const pollGamepads = () => watcher.poll([window, frameWindow.current]);
    pollGamepads();
    const poll = setInterval(pollGamepads, GAMEPAD_POLL_MS);
    return () => {
      detach();
      clearInterval(poll);
      detachFrame.current?.();
      detachFrame.current = undefined;
      frameWindow.current = null;
    };
  }, [touch]);

  const attachFrame = useCallback(
    (frame: HTMLIFrameElement) => {
      detachFrame.current?.();
      detachFrame.current = undefined;
      frameWindow.current = frame.contentWindow;
      try {
        const doc = frame.contentDocument;
        if (doc) detachFrame.current = listenForInput(doc, touch);
      } catch {
        // Чужой origin (например, ошибка прокси отдала другую страницу) — без него.
      }
    },
    [touch],
  );

  return useMemo(
    () => ({
      ageMs: () =>
        Math.max(0, Math.round(performance.now() - lastInput.current)),
      touch,
      attachFrame,
    }),
    [touch, attachFrame],
  );
}
