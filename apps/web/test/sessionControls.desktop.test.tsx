// Экран сессии в десктоп-приложении: «На весь экран» → `enter_game_fullscreen`, состояние —
// по событию приложения, удержание Esc → `exit_game_fullscreen`, уход с экрана сессии —
// тоже выход (иначе на macOS Dock и Cmd+Tab остались бы выключенными).
import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import { defaultStreamSettings, type SessionView } from "@cg/rpc";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Player } from "../src/components/Player";
import { GAME_FULLSCREEN_EVENT } from "../src/lib/desktop";
import { ESC_HOLD_MS } from "../src/lib/fullscreen";

/** То, что шлёт приложение (`fullscreen::event_script` в Rust) при входе и выходе. */
const dispatchDesktopGameFullscreen = (on: boolean) =>
  window.dispatchEvent(new CustomEvent(GAME_FULLSCREEN_EVENT, { detail: on }));

const view: SessionView = {
  id: "0b5c1a52-7f4e-4f1e-9a43-3c1d2e5f6a7b",
  appId: 620,
  gameName: "Portal 2",
  state: "playing",
  streamReady: true,
  failReason: null,
  idleDeadline: null,
  installPercent: null,
  stage: null,
  installStage: null,
  hadInstall: false,
  timing: null,
  playedSeconds: 0,
  previousPlayedAt: null,
  createdAt: "2026-10-17T10:00:00.000Z",
  queue: null,
  limit: null,
};

const noop = () => {};

const bridge = () => ({
  attach: mock((_frame: HTMLIFrameElement) => {}),
  update: mock(() => {}),
  setStatsOpen: mock((_open: boolean) => {}),
  frameWindow: mock((): Window | null => null),
  detach: mock(() => {}),
});

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;

const setDesktop = () => {
  const invoke = mock<Invoke>(async (cmd) =>
    cmd === "app_info" ? { version: "0.1.0", os: "macos" } : undefined,
  );
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
  return invoke;
};

const commands = (invoke: ReturnType<typeof setDesktop>) =>
  invoke.mock.calls.map((c) => c[0]).filter((cmd) => cmd !== "app_info");

const renderPlayer = () => {
  const result = render(
    <Player
      view={view}
      onExit={noop}
      onHere={noop}
      onLibrary={noop}
      onPlayAgain={noop}
      streamSettings={{
        settings: {
          ...defaultStreamSettings,
          fullscreenTutorialSeen: true,
          menuTourSeen: true,
        },
        loaded: true,
        update: noop,
      }}
      bridge={bridge()}
    />,
  );
  const frame = result.container.querySelector("iframe") as HTMLIFrameElement;
  // окно iframe стрима: Esc приходит на него
  const win = Object.assign(new EventTarget(), { focus: noop });
  Object.defineProperty(frame, "contentWindow", { value: win });
  return { ...result, frameWindow: win };
};

const escape = (target: EventTarget, type: "keydown" | "keyup") =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent(type, { key: "Escape", code: "Escape", bubbles: true }),
    );
  });

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("session screen in the desktop app", () => {
  it("button → native fullscreen; app event drives the UI; Esc hold exits", async () => {
    const invoke = setDesktop();
    const player = renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));
    await waitFor(() =>
      expect(commands(invoke)).toEqual(["enter_game_fullscreen"]),
    );
    // окно ушло в полный экран — так говорит приложение
    act(() => dispatchDesktopGameFullscreen(true));
    expect(screen.queryByRole("button", { name: "На весь экран" })).toBeNull();

    jest.useFakeTimers();
    try {
      escape(player.frameWindow, "keydown");
      // полоска со шкалой удержания, как в Chrome с захватом клавиш
      expect(screen.queryByText(/зажми/i)).toBeTruthy();
      act(() => jest.advanceTimersByTime(ESC_HOLD_MS - 100));
      expect(commands(invoke)).toEqual(["enter_game_fullscreen"]);
      act(() => jest.advanceTimersByTime(100));
      escape(player.frameWindow, "keyup");
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() =>
      expect(commands(invoke)).toEqual([
        "enter_game_fullscreen",
        "exit_game_fullscreen",
      ]),
    );

    act(() => dispatchDesktopGameFullscreen(false));
    expect(screen.getByRole("button", { name: "На весь экран" })).toBeTruthy();
  });

  it("short Esc press does not exit", () => {
    const invoke = setDesktop();
    const player = renderPlayer();
    act(() => dispatchDesktopGameFullscreen(true));
    jest.useFakeTimers();
    try {
      escape(player.frameWindow, "keydown");
      act(() => jest.advanceTimersByTime(ESC_HOLD_MS / 2));
      escape(player.frameWindow, "keyup");
      act(() => jest.advanceTimersByTime(ESC_HOLD_MS * 2));
    } finally {
      jest.useRealTimers();
    }
    expect(commands(invoke)).toEqual([]);
  });

  it("leaving the session screen in game fullscreen exits it", async () => {
    const invoke = setDesktop();
    const player = renderPlayer();
    act(() => dispatchDesktopGameFullscreen(true));
    player.unmount();
    await waitFor(() =>
      expect(commands(invoke)).toEqual(["exit_game_fullscreen"]),
    );
  });

  it("leaving the session screen outside fullscreen does nothing", async () => {
    const invoke = setDesktop();
    const player = renderPlayer();
    player.unmount();
    await act(async () => {});
    expect(commands(invoke)).toEqual([]);
  });
});
