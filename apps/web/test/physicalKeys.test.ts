// Клавиши по физическому месту: символ раскладки игрока → символ этого места на английской,
// подмена `key` в окне iframe стрима и её выключатель.
import { describe, expect, it } from "bun:test";
import { physicalKey, physicalKeysInFrame } from "../src/lib/physicalKeys";

describe("physicalKey", () => {
  it("maps Russian letters to their US places", () => {
    expect(physicalKey("KeyW", "ц", false, false)).toBe("w");
    expect(physicalKey("KeyA", "ф", false, false)).toBe("a");
    expect(physicalKey("KeyA", "Ф", true, false)).toBe("A");
    // Caps Lock меняет регистр букв, Shift при Caps Lock — обратно.
    expect(physicalKey("KeyA", "Ф", false, true)).toBe("A");
    expect(physicalKey("KeyA", "ф", true, true)).toBe("a");
  });

  it("maps digits and punctuation by place, Shift picks the US symbol", () => {
    // ru: Shift+2 — «"», Shift+3 — «№», «.» — на месте «/».
    expect(physicalKey("Digit2", '"', true, false)).toBe("@");
    expect(physicalKey("Digit3", "№", true, false)).toBe("#");
    expect(physicalKey("Slash", ".", false, false)).toBe("/");
    expect(physicalKey("Semicolon", "ж", false, false)).toBe(";");
    expect(physicalKey("Backquote", "Dead", false, false)).toBe("`");
    // Caps Lock на цифры не действует.
    expect(physicalKey("Digit1", "1", false, true)).toBe("1");
  });

  it("leaves non-character keys alone", () => {
    expect(physicalKey("ShiftLeft", "Shift", true, false)).toBe("Shift");
    expect(physicalKey("Enter", "Enter", false, false)).toBe("Enter");
    expect(physicalKey("ArrowUp", "ArrowUp", false, false)).toBe("ArrowUp");
    expect(physicalKey("Numpad1", "1", false, false)).toBe("1");
    expect(physicalKey("KeyA", "Unidentified", false, false)).toBe(
      "Unidentified",
    );
  });
});

/** Окно iframe со своим `KeyboardEvent`: геттер `key` на прототипе, как в браузере. */
const fakeFrame = () => {
  class FakeKeyboardEvent {
    constructor(
      readonly rawKey: string,
      readonly code: string,
      readonly shiftKey = false,
    ) {}
    get key() {
      return this.rawKey;
    }
    getModifierState() {
      return false;
    }
  }
  const listeners = new Set<() => void>();
  const frame = {
    contentWindow: { KeyboardEvent: FakeKeyboardEvent },
    addEventListener: (_type: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      listeners.delete(listener),
  };
  return {
    frame: frame as unknown as HTMLIFrameElement,
    press: (key: string, code: string, shift = false) =>
      new FakeKeyboardEvent(key, code, shift).key,
    reload: () => {
      class Reloaded extends FakeKeyboardEvent {}
      Object.defineProperty(Reloaded.prototype, "key", {
        configurable: true,
        get(this: FakeKeyboardEvent) {
          return this.rawKey;
        },
      });
      frame.contentWindow = { KeyboardEvent: Reloaded };
      for (const listener of listeners) listener();
      return (key: string, code: string) => new Reloaded(key, code).key;
    },
    listeners,
  };
};

describe("physicalKeysInFrame", () => {
  it("rewrites keys while enabled, reattaches on load, restores on stop", () => {
    const fake = fakeFrame();
    let enabled = true;
    const stop = physicalKeysInFrame(fake.frame, () => enabled);

    expect(fake.press("ц", "KeyW")).toBe("w");
    expect(fake.press("Ф", "KeyA", true)).toBe("A");
    expect(fake.press("Shift", "ShiftLeft", true)).toBe("Shift");

    // Переключатель читается на каждое нажатие.
    enabled = false;
    expect(fake.press("ц", "KeyW")).toBe("ц");
    enabled = true;

    // Новая загрузка iframe — новое окно со своим прототипом.
    const pressReloaded = fake.reload();
    expect(pressReloaded("ы", "KeyS")).toBe("s");

    stop();
    expect(pressReloaded("ы", "KeyS")).toBe("ы");
    expect(fake.listeners.size).toBe(0);
  });
});
