// Хук «Запоминание» настроек стрима (спека §4): локальное состояние, debounced-сохранение,
// учёт правок до загрузки сохранённого значения.
import { describe, expect, it, jest, mock } from "bun:test";
import { defaultStreamSettings } from "@cg/rpc";
import { act, renderHook } from "@testing-library/react";
import {
  SAVE_DEBOUNCE_MS,
  useStreamSettingsState,
} from "../src/lib/useStreamSettings";

describe("useStreamSettingsState", () => {
  it("defaults until loaded", () => {
    const save = mock(async () => {});
    const { result } = renderHook(() =>
      useStreamSettingsState(undefined, save),
    );
    expect(result.current.loaded).toBe(false);
    expect(result.current.settings).toEqual(defaultStreamSettings);
  });

  it("loaded value is adopted once; a later change of `loaded` does not overwrite edits", () => {
    const save = mock(async () => {});
    const { result, rerender } = renderHook(
      ({ loaded }) => useStreamSettingsState(loaded, save),
      { initialProps: { loaded: undefined as typeof defaultStreamSettings | undefined } },
    );

    rerender({ loaded: { ...defaultStreamSettings, debug: "short" } });
    expect(result.current.loaded).toBe(true);
    expect(result.current.settings).toEqual({
      ...defaultStreamSettings,
      debug: "short",
    });

    act(() => result.current.update({ menuSeen: true }));
    rerender({ loaded: { ...defaultStreamSettings, debug: "detailed" } });
    expect(result.current.settings).toEqual({
      ...defaultStreamSettings,
      debug: "short",
      menuSeen: true,
    });
  });

  it("edits before load win over the loaded value", () => {
    const save = mock(async () => {});
    const { result, rerender } = renderHook(
      ({ loaded }) => useStreamSettingsState(loaded, save),
      { initialProps: { loaded: undefined as typeof defaultStreamSettings | undefined } },
    );

    act(() => result.current.update({ debug: "short" }));
    expect(result.current.settings).toEqual({
      ...defaultStreamSettings,
      debug: "short",
    });

    rerender({ loaded: { ...defaultStreamSettings, menuSeen: true } });
    expect(result.current.loaded).toBe(true);
    expect(result.current.settings).toEqual({
      ...defaultStreamSettings,
      debug: "short",
      menuSeen: true,
    });
  });

  it("update applies at once and saves once after 500 ms", () => {
    const save = mock(async () => {});
    jest.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useStreamSettingsState(defaultStreamSettings, save),
      );

      act(() => result.current.update({ debug: "short" }));
      expect(result.current.settings.debug).toBe("short");
      act(() => jest.advanceTimersByTime(50));
      act(() => result.current.update({ menuSeen: true }));
      act(() => jest.advanceTimersByTime(50));
      act(() =>
        result.current.update({ quality: "manual", bitrateMbps: 10 }),
      );

      expect(save).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1));
      expect(save).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(1));

      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith({
        ...defaultStreamSettings,
        debug: "short",
        menuSeen: true,
        quality: "manual",
        bitrateMbps: 10,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("save failure keeps the settings (applied optimistically, no toast)", async () => {
    const save = mock(async () => {
      throw new Error("network down");
    });
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    jest.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useStreamSettingsState(defaultStreamSettings, save),
      );

      act(() => result.current.update({ debug: "detailed" }));
      await act(async () => {
        jest.advanceTimersByTime(SAVE_DEBOUNCE_MS);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(save).toHaveBeenCalledTimes(1);
      expect(result.current.settings).toEqual({
        ...defaultStreamSettings,
        debug: "detailed",
      });
      expect(warn).toHaveBeenCalledWith("Stream settings not saved");
    } finally {
      jest.useRealTimers();
      console.warn = originalWarn;
    }
  });

  it("pending save is flushed on unmount", () => {
    const save = mock(async () => {});
    jest.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() =>
        useStreamSettingsState(defaultStreamSettings, save),
      );

      act(() => result.current.update({ debug: "short" }));
      expect(save).not.toHaveBeenCalled();
      unmount();

      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith({
        ...defaultStreamSettings,
        debug: "short",
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
