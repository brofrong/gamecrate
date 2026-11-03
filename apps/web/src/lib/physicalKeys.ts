// Клавиши по физическому месту (слово владельца 2026-11-03). Selkies шлёт на сервер символ
// клавиши (`KeyboardEvent.key`), а не её место: на русской раскладке клавиша A — это «ф». На
// сервере (раскладка us) кириллицы нет, Selkies вешает её на запасной код клавиши, и игра, которая
// ждёт WASD по местам, такое нажатие не узнаёт. Поэтому в окне iframe стрима (тот же origin)
// геттер `key` подменяется: символ клавиши основного блока — символ этого же места на английской
// раскладке (с учётом Shift и Caps Lock). Selkies читает клавишу только из `key` в `keydown`/`keyup`
// (проверено по `selkies-core.js` образа 2026-11-03), так что больше ничего трогать не нужно.
// Выключатель — `localLayout` в настройках стрима: печатать на своей раскладке (чаты на русском).

/** Символы мест основного блока на английской раскладке: [без Shift, с Shift]. */
const usKeys: Record<string, readonly [string, string]> = {
  Backquote: ["`", "~"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  IntlBackslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
};
for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
  usKeys[`Key${letter}`] = [letter.toLowerCase(), letter];

/**
 * Символ клавиши `code` на английской раскладке вместо `key` раскладки игрока. Не трогает
 * всё, что не символ основного блока: Shift, стрелки, F1, Enter, цифровой блок, `Unidentified`.
 * `Dead` (мёртвые клавиши, например ` на некоторых раскладках) тоже меняется на символ места.
 */
export function physicalKey(
  code: string,
  key: string,
  shift: boolean,
  capsLock: boolean,
): string {
  const us = usKeys[code];
  if (us === undefined) return key;
  if (key !== "Dead" && [...key].length !== 1) return key;
  const letter = code.startsWith("Key");
  return us[(letter ? shift !== capsLock : shift) ? 1 : 0];
}

/** Окно iframe с его собственным `KeyboardEvent` (у каждого окна свой прототип). */
type FrameWindow = { KeyboardEvent?: { prototype: KeyboardEvent } };

/**
 * Подменяет `key` у событий клавиатуры окна iframe стрима, пока `enabled()` — правда (читается
 * на каждое нажатие, переключатель меню действует сразу). Переподключается на каждую загрузку
 * iframe (новое окно — новый прототип). Возвращает «стоп»: возвращает исходный геттер.
 */
export function physicalKeysInFrame(
  frame: HTMLIFrameElement,
  enabled: () => boolean,
): () => void {
  let restore = () => {};

  const attach = () => {
    restore();
    restore = () => {};
    let proto: KeyboardEvent | undefined;
    try {
      proto = (frame.contentWindow as FrameWindow | null)?.KeyboardEvent
        ?.prototype;
    } catch {
      return;
    }
    if (proto === undefined) return;
    const target = proto;
    const original = Object.getOwnPropertyDescriptor(target, "key");
    const get = original?.get;
    if (original === undefined || get === undefined) return;
    Object.defineProperty(target, "key", {
      ...original,
      get(this: KeyboardEvent) {
        const key = get.call(this) as string;
        if (!enabled()) return key;
        return physicalKey(
          this.code,
          key,
          this.shiftKey,
          this.getModifierState?.("CapsLock") ?? false,
        );
      },
    });
    restore = () => {
      try {
        Object.defineProperty(target, "key", original);
      } catch {
        // окно уже выгружено — его прототип никому не нужен.
      }
    };
  };

  attach();
  frame.addEventListener("load", attach);
  return () => {
    frame.removeEventListener("load", attach);
    restore();
  };
}
