// Мост к десктоп-приложению: вне приложения — no-op, в приложении — вызов команд Tauri через
// `__TAURI_INTERNALS__.invoke`, ошибки моста не пробрасываются.
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  desktopAppInfo,
  desktopEnterGameFullscreen,
  desktopExitGameFullscreen,
  desktopNotify,
  desktopOpenExternal,
  desktopSetStatus,
  homePath,
  isDesktop,
} from "../src/lib/desktop";

type Bridge = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };

const setBridge = (invoke: Bridge["invoke"]) => {
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
};

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("desktop bridge outside the app", () => {
  it("is not desktop, home is the landing, wrappers are no-ops", async () => {
    expect(isDesktop()).toBe(false);
    expect(homePath()).toBe("/");
    await desktopNotify("t", "b");
    await desktopSetStatus({ kind: "idle" });
    await desktopEnterGameFullscreen();
    await desktopExitGameFullscreen();
    expect(await desktopOpenExternal("https://example.com")).toBe(false);
    expect(await desktopAppInfo()).toBeNull();
  });
});

describe("desktop bridge inside the app", () => {
  it("detects the bridge and sends home to /app", () => {
    setBridge(async () => undefined);
    expect(isDesktop()).toBe(true);
    expect(homePath()).toBe("/app");
  });

  it("set_status passes the status as is", async () => {
    const invoke = mock<Bridge["invoke"]>(async () => undefined);
    setBridge(invoke);
    const status = {
      kind: "queued",
      position: 3,
      total: 5,
      etaMinutes: 4,
    } as const;
    await desktopSetStatus(status);
    expect(invoke).toHaveBeenCalledWith("set_status", { status });
  });

  it("calls the other commands with the agreed names and args", async () => {
    const invoke = mock<Bridge["invoke"]>(async () => undefined);
    setBridge(invoke);
    await desktopNotify("Сервер готов", "Заходите");
    await desktopEnterGameFullscreen();
    await desktopExitGameFullscreen();
    expect(await desktopOpenExternal("https://example.com/a")).toBe(true);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      "notify",
      "enter_game_fullscreen",
      "exit_game_fullscreen",
      "open_external",
    ]);
    expect(invoke.mock.calls[0]).toEqual([
      "notify",
      { title: "Сервер готов", body: "Заходите" },
    ]);
    expect(invoke.mock.calls[3]).toEqual([
      "open_external",
      { url: "https://example.com/a" },
    ]);
  });

  it("swallows rejections and synchronous throws from the bridge", async () => {
    setBridge(async () => {
      throw new Error("boom");
    });
    await desktopNotify("t", "b");
    await desktopSetStatus({ kind: "playing" });
    await desktopEnterGameFullscreen();
    await desktopExitGameFullscreen();
    // отказ приложения открыть браузер виден вызывающему, но не бросает
    expect(await desktopOpenExternal("https://example.com")).toBe(false);
    expect(await desktopAppInfo()).toBeNull();

    setBridge(() => {
      throw new Error("sync boom");
    });
    await desktopNotify("t", "b");
    expect(await desktopOpenExternal("https://example.com")).toBe(false);
    expect(await desktopAppInfo()).toBeNull();
  });

  it("app_info returns a valid answer and rejects a malformed one", async () => {
    setBridge(async () => ({ version: "0.1.0", os: "macos" }));
    expect(await desktopAppInfo()).toEqual({ version: "0.1.0", os: "macos" });

    for (const bad of [
      null,
      "x",
      {},
      { version: 1, os: "linux" },
      { version: "0.1.0", os: "plan9" },
      { version: "0.1.0" },
    ]) {
      setBridge(async () => bad);
      expect(await desktopAppInfo()).toBeNull();
    }
  });
});
