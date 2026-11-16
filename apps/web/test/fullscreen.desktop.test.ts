// Полный экран в десктоп-приложении: нативный полный экран окна командой
// `enter_game_fullscreen`, на macOS/Linux без HTML Fullscreen API (иначе Esc в WKWebView сразу
// выходит), на Windows — ещё `requestFullscreen` + `keyboard.lock()`, если они есть. О входе и
// выходе (в т.ч. средствами ОС) приложение говорит DOM-событием `gamecrate:game-fullscreen`.
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { GAME_FULLSCREEN_EVENT } from "../src/lib/desktop";
import {
  ESC_HOLD_MS,
  enterFullscreen,
  escHold,
  escHoldExits,
  exitGameFullscreen,
  useIsFullscreen,
} from "../src/lib/fullscreen";

/** То, что шлёт приложение (`fullscreen::event_script` в Rust) при входе и выходе. */
const dispatchDesktopGameFullscreen = (on: boolean) =>
  window.dispatchEvent(new CustomEvent(GAME_FULLSCREEN_EVENT, { detail: on }));

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;

const setDesktop = (os: "macos" | "linux" | "windows") => {
  const invoke = mock<Invoke>(async (cmd) =>
    cmd === "app_info" ? { version: "0.1.0", os } : undefined,
  );
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
  return invoke;
};

let calls: string[] = [];
let fullscreenElement: Element | null = null;
const originalRequestFullscreen = HTMLElement.prototype.requestFullscreen;
const originalExitFullscreen = document.exitFullscreen;

const setFullscreenElement = (element: Element | null) => {
  fullscreenElement = element;
};

const setKeyboard = (lock: () => Promise<void>) =>
  Object.defineProperty(navigator, "keyboard", {
    configurable: true,
    value: {
      lock: mock(async () => {
        calls.push("lock");
        await lock();
      }),
      unlock: mock(() => calls.push("unlock")),
    },
  });

beforeEach(() => {
  calls = [];
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  HTMLElement.prototype.requestFullscreen = async function (this: HTMLElement) {
    calls.push("requestFullscreen");
    setFullscreenElement(this);
  };
  document.exitFullscreen = async () => {
    calls.push("exitFullscreen");
    fullscreenElement = null;
  };
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  HTMLElement.prototype.requestFullscreen = originalRequestFullscreen;
  document.exitFullscreen = originalExitFullscreen;
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(navigator, "keyboard");
});

const commands = (invoke: ReturnType<typeof setDesktop>) =>
  invoke.mock.calls.map((c) => c[0]).filter((cmd) => cmd !== "app_info");

describe("enterFullscreen in the desktop app", () => {
  for (const os of ["macos", "linux"] as const) {
    it(`${os}: native fullscreen only, no HTML Fullscreen API`, async () => {
      const invoke = setDesktop(os);
      setKeyboard(async () => {});
      await enterFullscreen(document.createElement("main"), null);
      expect(commands(invoke)).toEqual(["enter_game_fullscreen"]);
      expect(calls).toEqual([]);
    });
  }

  it("windows: page fullscreen and keyboard lock, then native fullscreen", async () => {
    const invoke = setDesktop("windows");
    setKeyboard(async () => {});
    const root = document.createElement("main");
    await enterFullscreen(root, null);
    expect(calls).toEqual(["requestFullscreen", "lock"]);
    expect(fullscreenElement).toBe(root);
    expect(commands(invoke)).toEqual(["enter_game_fullscreen"]);
  });

  it("windows without Keyboard Lock API: like macOS", async () => {
    const invoke = setDesktop("windows");
    await enterFullscreen(document.createElement("main"), null);
    expect(calls).toEqual([]);
    expect(commands(invoke)).toEqual(["enter_game_fullscreen"]);
  });

  it("windows, keyboard lock refused: page fullscreen undone, native stays", async () => {
    const invoke = setDesktop("windows");
    setKeyboard(async () => {
      throw new Error("NotAllowedError");
    });
    await enterFullscreen(document.createElement("main"), null);
    expect(calls).toEqual(["requestFullscreen", "lock", "exitFullscreen"]);
    expect(fullscreenElement).toBeNull();
    expect(commands(invoke)).toEqual(["enter_game_fullscreen"]);
  });

  it("windows, page fullscreen refused: native fullscreen anyway", async () => {
    const invoke = setDesktop("windows");
    setKeyboard(async () => {});
    HTMLElement.prototype.requestFullscreen = async () => {
      calls.push("requestFullscreen");
      throw new Error("denied");
    };
    await enterFullscreen(document.createElement("main"), null);
    expect(calls).toEqual(["requestFullscreen"]);
    expect(commands(invoke)).toEqual(["enter_game_fullscreen"]);
  });
});

describe("exitGameFullscreen", () => {
  it("in the app: native exit and page fullscreen off", async () => {
    const invoke = setDesktop("windows");
    fullscreenElement = document.body;
    await exitGameFullscreen();
    expect(calls).toEqual(["exitFullscreen"]);
    expect(commands(invoke)).toEqual(["exit_game_fullscreen"]);
  });

  it("in the app without page fullscreen: only the native exit", async () => {
    const invoke = setDesktop("macos");
    await exitGameFullscreen();
    expect(calls).toEqual([]);
    expect(commands(invoke)).toEqual(["exit_game_fullscreen"]);
  });
});

describe("useIsFullscreen in the app", () => {
  it("follows the app event, not fullscreenchange", () => {
    setDesktop("macos");
    setKeyboard(async () => {});
    const { result } = renderHook(() => useIsFullscreen());
    expect(result.current).toBe(false);

    act(() => dispatchDesktopGameFullscreen(true));
    expect(result.current).toBe(true);

    // HTML fullscreen не трогает состояние в приложении
    act(() => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(result.current).toBe(true);

    act(() => dispatchDesktopGameFullscreen(false));
    expect(result.current).toBe(false);
    expect(calls).toContain("unlock");
  });

  it("ignores events with a non-boolean detail", () => {
    setDesktop("macos");
    const { result } = renderHook(() => useIsFullscreen());
    act(() => {
      window.dispatchEvent(
        new CustomEvent(GAME_FULLSCREEN_EVENT, { detail: "true" }),
      );
    });
    expect(result.current).toBe(false);
  });

  it("windows: leaving page fullscreen during the game leaves native fullscreen too", async () => {
    const invoke = setDesktop("windows");
    const { result } = renderHook(() => useIsFullscreen());
    act(() => {
      fullscreenElement = document.body;
      dispatchDesktopGameFullscreen(true);
    });
    act(() => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    await act(async () => {});
    expect(commands(invoke)).toEqual(["exit_game_fullscreen"]);
    expect(result.current).toBe(true);
  });

  it("outside the app the event is ignored", () => {
    const { result } = renderHook(() => useIsFullscreen());
    act(() => dispatchDesktopGameFullscreen(true));
    expect(result.current).toBe(false);
  });
});

describe("Esc hold in the app", () => {
  it("holding Esc ESC_HOLD_MS calls onHold, releasing earlier does not", () => {
    jest.useFakeTimers();
    try {
      const onHold = mock(() => {});
      const hold = escHold(onHold);
      hold.down();
      jest.advanceTimersByTime(ESC_HOLD_MS - 1);
      hold.up();
      jest.advanceTimersByTime(ESC_HOLD_MS);
      expect(onHold).not.toHaveBeenCalled();

      hold.down();
      jest.advanceTimersByTime(ESC_HOLD_MS);
      expect(onHold).toHaveBeenCalledTimes(1);

      hold.down();
      hold.stop();
      jest.advanceTimersByTime(ESC_HOLD_MS);
      expect(onHold).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("in the app Esc is always held to exit; in the browser only with Keyboard Lock", () => {
    expect(escHoldExits()).toBe(false);
    setKeyboard(async () => {});
    expect(escHoldExits()).toBe(true);
    Reflect.deleteProperty(navigator, "keyboard");
    setDesktop("macos");
    expect(escHoldExits()).toBe(true);
  });
});
