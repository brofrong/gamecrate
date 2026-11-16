// Статус для трея десктоп-приложения: из состояния сессии (`desktopStatusOf`), зеркало в
// `QueueWatcher` (`useDesktopStatusMirror`) и экран игры (`useDesktopGameStatus`).
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { SessionState, SessionView } from "@cg/rpc";
import { renderHook } from "@testing-library/react";
import {
  desktopStatusOf,
  useDesktopGameStatus,
  useDesktopStatusMirror,
} from "../src/lib/desktopStatus";

const view = (state: SessionState, patch: Partial<SessionView> = {}): SessionView => ({
  id: "0b5c1a52-7f4e-4f1e-9a43-3c1d2e5f6a7b",
  appId: 620,
  gameName: "Portal 2",
  state,
  streamReady: false,
  failReason: null,
  idleDeadline: null,
  installPercent: null,
  stage: null,
  installStage: null,
  hadInstall: false,
  timing: null,
  playedSeconds: 0,
  previousPlayedAt: null,
  createdAt: "2026-11-16T10:00:00.000Z",
  queue: null,
  limit: null,
  ...patch,
});

const queued = (position: number, total: number, etaMinutes: number | null) =>
  view("queued", { queue: { position, total, etaMinutes } });

const setBridge = () => {
  const invoke = mock(async (_cmd: string, _args?: unknown) => undefined);
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
  return invoke;
};

const statusCalls = (invoke: ReturnType<typeof setBridge>) =>
  invoke.mock.calls
    .filter(([cmd]) => cmd === "set_status")
    .map(([, args]) => (args as { status: unknown }).status);

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("desktopStatusOf", () => {
  it("maps session states to tray statuses", () => {
    expect(desktopStatusOf(queued(3, 5, 4))).toEqual({
      kind: "queued",
      position: 3,
      total: 5,
      etaMinutes: 4,
    });
    // место ещё не посчитано
    expect(desktopStatusOf(view("queued"))).toEqual({
      kind: "queued",
      position: 0,
      total: 0,
      etaMinutes: null,
    });
    expect(desktopStatusOf(view("installing"))).toEqual({ kind: "starting" });
    expect(desktopStatusOf(view("starting"))).toEqual({ kind: "starting" });
    for (const state of ["playing", "idle_warning", "disconnected"] as const) {
      expect(desktopStatusOf(view(state))).toEqual({ kind: "playing" });
    }
    for (const state of ["stopping", "ended", "failed"] as const) {
      expect(desktopStatusOf(view(state))).toEqual({ kind: "idle" });
    }
  });
});

describe("useDesktopStatusMirror (QueueWatcher)", () => {
  it("sends each new status once and idle on unmount", () => {
    const invoke = setBridge();
    const { rerender, unmount } = renderHook(
      ({ v }: { v: SessionView | undefined }) => useDesktopStatusMirror(v),
      { initialProps: { v: undefined as SessionView | undefined } },
    );
    // состояние ещё не пришло — ничего
    expect(statusCalls(invoke)).toEqual([]);

    rerender({ v: queued(3, 5, 4) });
    rerender({ v: queued(3, 5, 4) });
    rerender({ v: queued(2, 5, 3) });
    rerender({ v: view("starting") });
    rerender({ v: view("ended") });
    expect(statusCalls(invoke)).toEqual([
      { kind: "queued", position: 3, total: 5, etaMinutes: 4 },
      { kind: "queued", position: 2, total: 5, etaMinutes: 3 },
      { kind: "starting" },
      { kind: "idle" },
    ]);

    unmount();
    expect(statusCalls(invoke).at(-1)).toEqual({ kind: "idle" });
  });

  it("does nothing in the browser", () => {
    const { rerender, unmount } = renderHook(
      ({ v }: { v: SessionView }) => useDesktopStatusMirror(v),
      { initialProps: { v: queued(1, 1, null) } },
    );
    rerender({ v: view("playing") });
    unmount();
    expect("__TAURI_INTERNALS__" in window).toBe(false);
  });
});

describe("useDesktopGameStatus (session screen)", () => {
  it("sets starting/playing on the game screen and idle when leaving it", () => {
    const invoke = setBridge();
    const { rerender, unmount } = renderHook(
      ({ v }: { v: SessionView | undefined }) => useDesktopGameStatus(v),
      { initialProps: { v: queued(2, 3, 1) as SessionView | undefined } },
    );
    // очередь — забота QueueWatcher, экран игры её не трогает
    expect(statusCalls(invoke)).toEqual([]);

    rerender({ v: view("starting") });
    rerender({ v: view("playing") });
    rerender({ v: view("idle_warning") });
    expect(statusCalls(invoke)).toEqual([
      { kind: "starting" },
      { kind: "playing" },
    ]);

    unmount();
    expect(statusCalls(invoke)).toEqual([
      { kind: "starting" },
      { kind: "playing" },
      { kind: "idle" },
    ]);
  });

  it("leaving the screen while still queued keeps the queue status", () => {
    const invoke = setBridge();
    const { unmount } = renderHook(() => useDesktopGameStatus(queued(2, 3, 1)));
    unmount();
    expect(statusCalls(invoke)).toEqual([]);
  });
});
