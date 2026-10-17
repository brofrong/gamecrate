// Время последнего ввода пользователя на странице сессии — для `inputAgeMs` в heartbeat.
// Источники: клавиатура/мышь в документе страницы и в документе iframe стрима (тот же
// origin через /stream/<id>/) и изменения состояния геймпадов (опрос navigator.getGamepads()).
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

const readGamepads = (): ReadonlyArray<Gamepad | null> => {
  try {
    return navigator.getGamepads?.() ?? [];
  } catch {
    // Permissions Policy может запретить Gamepad API — тогда геймпадов просто нет.
    return [];
  }
};

export type InputActivity = {
  /** Мс с последнего ввода (до первого ввода — с открытия страницы сессии). */
  readonly ageMs: () => number;
  /** Отметить ввод сейчас (например, «Я здесь»). */
  readonly touch: () => void;
  /** Подписаться на документ загруженного iframe (вызывать на каждый `load`). */
  readonly attachFrame: (frame: HTMLIFrameElement) => void;
};

/** Отслеживание последнего ввода, пока смонтирован компонент. */
export function useInputActivity(): InputActivity {
  const lastInput = useRef(performance.now());
  const detachFrame = useRef<(() => void) | undefined>(undefined);

  const touch = useCallback(() => {
    lastInput.current = performance.now();
  }, []);

  useEffect(() => {
    const detach = listenForInput(document, touch);
    // Сравниваем с положением при последнем засчитанном вводе, а не с прошлым опросом:
    // иначе медленный наклон стика (меньше мёртвой зоны за 250 мс) не засчитался бы никогда.
    let baseline = snapshotGamepads(readGamepads());
    const poll = setInterval(() => {
      const next = snapshotGamepads(readGamepads());
      if (gamepadsChanged(baseline, next)) {
        touch();
        baseline = next;
      } else {
        baseline = next.map((pad, i) =>
          pad === null ? null : (baseline[i] ?? pad),
        );
      }
    }, GAMEPAD_POLL_MS);
    return () => {
      detach();
      clearInterval(poll);
      detachFrame.current?.();
      detachFrame.current = undefined;
    };
  }, [touch]);

  const attachFrame = useCallback(
    (frame: HTMLIFrameElement) => {
      detachFrame.current?.();
      detachFrame.current = undefined;
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
