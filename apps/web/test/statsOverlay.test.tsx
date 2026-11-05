// Отладочная плашка стрима (спека §3, бриф задачи 5): «Коротко» / «Подробно», графики за минуту,
// таблица перцентилей, хук сбора (выборка Selkies раз в секунду + `requestVideoFrameCallback`).
import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import {
  defaultStreamSettings,
  type SessionView,
  type StreamSettings,
} from "@cg/rpc";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { Player } from "../src/components/Player";
import { sparklineGeometry } from "../src/components/session/Sparkline";
import { StatsOverlay } from "../src/components/session/StatsOverlay";
import type { SelkiesBridge, SelkiesSample } from "../src/lib/selkiesBridge";
import type { Percentiles, StatsSnapshot } from "../src/lib/streamStats";
import { STATS_TICK_MS, useStreamStats } from "../src/lib/useStreamStats";

const sample = (patch: Partial<SelkiesSample> = {}): SelkiesSample => ({
  fps: 60,
  mbps: 18.42,
  rttMs: 12,
  decodeMs: 3,
  jitterMs: 4,
  lossPercent: 0.2,
  framesDropped: 12,
  codec: "H264",
  resolution: "1920x1080",
  ...patch,
});

const pct = (
  p50: number,
  p90: number,
  p95: number,
  p99: number,
  max: number,
): Percentiles => ({ p50, p90, p95, p99, max });

const snapshot = (patch: Partial<StatsSnapshot> = {}): StatsSnapshot => ({
  fps: 60,
  low1: 41,
  frameTimes: [],
  ping: [],
  bitrate: [],
  table: {
    frame: pct(16, 17, 18, 20, 30),
    // p99 ровно на пороге пинга (50) — ещё не «хуже порога».
    ping: pct(12, 14, 15, 50, 60),
    decode: pct(3, 4, 5, 6, 12),
  },
  latest: sample(),
  ...patch,
});

const fakeBridge = (win: Window | null = null) => ({
  attach: mock((_frame: HTMLIFrameElement) => {}),
  update: mock((_prev: StreamSettings, _next: StreamSettings) => {}),
  setStatsOpen: mock((_open: boolean) => {}),
  frameWindow: mock((): Window | null => win),
  detach: mock(() => {}),
});

afterEach(() => {
  jest.useRealTimers();
});

describe("stats overlay", () => {
  it("short shows two lines", () => {
    const shown = render(<StatsOverlay mode="short" snapshot={snapshot()} />);
    expect(screen.getByText("60 FPS · 12 мс · 18,4 Мбит/с")).toBeTruthy();
    expect(screen.getByText("1920×1080 · потери 0,2 %")).toBeTruthy();
    // Клики сквозь плашку уходят в игру.
    expect(
      screen
        .getByText("1920×1080 · потери 0,2 %")
        .closest(".pointer-events-none"),
    ).not.toBeNull();
    shown.unmount();

    const empty = render(<StatsOverlay mode="short" snapshot={null} />);
    expect(screen.getByText("— FPS · — мс · — Мбит/с")).toBeTruthy();
    expect(screen.getByText("— · потери — %")).toBeTruthy();
    empty.unmount();

    // NaN из Selkies — тоже «нет значения».
    render(
      <StatsOverlay
        mode="short"
        snapshot={snapshot({ latest: sample({ rttMs: Number.NaN }) })}
      />,
    );
    expect(screen.getByText("60 FPS · — мс · 18,4 Мбит/с")).toBeTruthy();
  });

  it("detailed shows header, charts and table", () => {
    render(<StatsOverlay mode="detailed" snapshot={snapshot()} />);
    expect(screen.getByText("60 FPS · 1% low 41")).toBeTruthy();
    expect(screen.getByText("H264 1920×1080")).toBeTruthy();
    expect(
      screen.getByText("потери 0,2 % · джиттер 4 мс · выпавших кадров 12"),
    ).toBeTruthy();

    for (const name of ["Время кадра", "Пинг", "Битрейт"]) {
      const chart = screen.getByRole("img", { name });
      // Наведение на графики работает, остальная плашка — сквозная.
      expect(chart.classList.contains("pointer-events-auto")).toBe(true);
    }

    const table = screen.getByRole("table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["", "p50", "p90", "p95", "p99", "макс"]);

    const row = (name: string) =>
      within(within(table).getByRole("rowheader", { name }).closest("tr")!);
    const bad = (cell: HTMLElement) =>
      cell.getAttribute("data-bad") === "true" &&
      cell.classList.contains("text-brand-warn");

    expect(bad(row("Кадр, мс").getByText("30"))).toBe(true);
    expect(bad(row("Кадр, мс").getByText("20"))).toBe(false);
    expect(bad(row("Пинг, мс").getByText("60"))).toBe(true);
    expect(bad(row("Пинг, мс").getByText("50"))).toBe(false);
    expect(bad(row("Декодер, мс").getByText("12"))).toBe(true);
    expect(bad(row("Декодер, мс").getByText("6"))).toBe(false);
  });

  it("detailed without data shows dashes", () => {
    render(<StatsOverlay mode="detailed" snapshot={null} />);
    expect(screen.getByText("— FPS · 1% low —")).toBeTruthy();
    expect(screen.getByText("— —")).toBeTruthy();
    expect(within(screen.getByRole("table")).getAllByText("—")).toHaveLength(
      15,
    );
  });

  it("chart hover shows value and age", () => {
    const at = performance.now() - 5_000;
    render(
      <StatsOverlay
        mode="detailed"
        snapshot={snapshot({ frameTimes: [{ at, value: 12.3 }] })}
      />,
    );
    const chart = screen.getByRole("img", { name: "Время кадра" });
    chart.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 600,
        height: 40,
        right: 600,
        bottom: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    // 55 с из 60 от левого края — 5 с назад.
    fireEvent.pointerMove(chart, { clientX: 550, clientY: 20 });
    expect(screen.getByText("12,3 мс · 5 с назад")).toBeTruthy();

    fireEvent.pointerLeave(chart);
    expect(screen.queryByText("12,3 мс · 5 с назад")).toBeNull();
  });
});

describe("sparkline geometry", () => {
  it("maps the window to the width and marks points above the threshold", () => {
    const now = 100_000;
    const geometry = sparklineGeometry(
      [
        { at: now - 60_000, value: 10 },
        { at: now, value: 30 },
      ],
      now,
      { width: 200, height: 40 },
      25,
    );
    expect(geometry.path).toBe("M0,26.67L200,0");
    expect(geometry.p95Y).toBe(0);
    expect(geometry.dots).toEqual([
      { x: 200, y: 0, point: { at: now, value: 30 } },
    ]);

    const noThreshold = sparklineGeometry([{ at: now, value: 30 }], now, {
      width: 200,
      height: 40,
    });
    expect(noThreshold.dots).toEqual([]);
  });

  it("empty series has no path", () => {
    expect(
      sparklineGeometry([], 100_000, { width: 200, height: 40 }, 25),
    ).toEqual({ path: "", p95Y: null, dots: [] });
  });
});

/** Окно iframe Selkies: `stream_stats.latest`, `stream_client` и `<video>` с `rVFC`. */
const fakeSelkiesWindow = () => {
  const callbacks: Array<VideoFrameRequestCallback> = [];
  const video = {
    requestVideoFrameCallback: mock((callback: VideoFrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
    cancelVideoFrameCallback: mock((_handle: number) => {}),
  };
  const win = {
    stream_stats: {
      latest: { fps: null, mbps: 18, rtt_ms: 12, decode_ms: 3 },
    },
    stream_client: { codec: "H264", resolution: "1920x1080" },
    document: {
      querySelector: (selector: string) =>
        selector === "video" ? video : null,
    },
  } as unknown as Window;
  return { win, video, callbacks };
};

const metadata = {} as VideoFrameCallbackMetadata;

describe("useStreamStats", () => {
  it("stats hook is idle when off", () => {
    jest.useFakeTimers();
    const bridge = fakeBridge();
    const { result } = renderHook(() => useStreamStats(bridge, 1, "off"));
    act(() => jest.advanceTimersByTime(3_000));
    expect(bridge.setStatsOpen).toHaveBeenCalledWith(false);
    expect(bridge.setStatsOpen).not.toHaveBeenCalledWith(true);
    expect(bridge.frameWindow).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("stats hook samples Selkies and frames", () => {
    jest.useFakeTimers();
    const { win, video, callbacks } = fakeSelkiesWindow();
    const bridge: SelkiesBridge = fakeBridge(win);
    const { result, rerender } = renderHook(
      ({ generation }) => useStreamStats(bridge, generation, "short"),
      { initialProps: { generation: 1 } },
    );
    expect(bridge.setStatsOpen).toHaveBeenCalledWith(true);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);

    // 60 кадров по 16 мс на часах iframe; первый — только отсчёт.
    for (let i = 0; i < 60; i++) {
      act(() => {
        callbacks.at(-1)!(i * 16, metadata);
        jest.advanceTimersByTime(16);
      });
    }
    act(() => jest.advanceTimersByTime(STATS_TICK_MS - 60 * 16));

    const first = result.current!;
    expect(first.fps).toBeGreaterThan(0);
    expect(first.frameTimes).toHaveLength(59);
    expect(first.frameTimes.every((point) => point.value === 16)).toBe(true);
    expect(first.latest?.rttMs).toBe(12);
    expect(first.ping).toHaveLength(1);

    // Новый документ стрима: окно очищено, колбэк зарегистрирован заново.
    const stale = callbacks.at(-1)!;
    const registered = video.requestVideoFrameCallback.mock.calls.length;
    rerender({ generation: 2 });
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(
      registered + 1,
    );
    expect(result.current).toBeNull();

    // Колбэк прошлой регистрации больше ничего не пишет и не перерегистрируется.
    act(() => stale(10_000, metadata));
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(
      registered + 1,
    );

    act(() => jest.advanceTimersByTime(STATS_TICK_MS));
    expect(result.current!.frameTimes).toHaveLength(0);
    expect(result.current!.ping).toHaveLength(1);
  });

  it("stats hook without requestVideoFrameCallback takes FPS from Selkies", () => {
    jest.useFakeTimers();
    const { win } = fakeSelkiesWindow();
    const plain = {
      ...win,
      stream_stats: { latest: { fps: 58, rtt_ms: 12 } },
      document: { querySelector: () => ({}) },
    } as unknown as Window;
    const bridge = fakeBridge(plain);
    const { result } = renderHook(() => useStreamStats(bridge, 1, "detailed"));
    act(() => jest.advanceTimersByTime(STATS_TICK_MS));
    expect(result.current!.fps).toBe(58);
    expect(result.current!.frameTimes).toHaveLength(0);
  });
});

const sessionId = "0b5c1a52-7f4e-4f1e-9a43-3c1d2e5f6a7b";

const view = (patch: Partial<SessionView> = {}): SessionView => ({
  id: sessionId,
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
  ...patch,
});

const noop = () => {};

const renderPlayer = (
  sessionView: SessionView,
  patch: Partial<StreamSettings>,
  bridge = fakeBridge(),
) =>
  render(
    <Player
      view={sessionView}
      onExit={noop}
      onHere={noop}
      onLibrary={noop}
      onPlayAgain={noop}
      streamSettings={{
        settings: { ...defaultStreamSettings, ...patch },
        loaded: true,
        update: noop,
      }}
      bridge={bridge}
    />,
  );

describe("Player stats overlay", () => {
  it("Player shows the overlay only over the stream", () => {
    const bridge = fakeBridge();
    const playing = renderPlayer(view(), { debug: "short" }, bridge);
    expect(screen.getByText("— FPS · — мс · — Мбит/с")).toBeTruthy();
    expect(bridge.setStatsOpen).toHaveBeenCalledWith(true);
    // Iframe по-прежнему первый ребёнок `<main>` (не переподключается).
    expect(
      playing.container.querySelector("main")!.firstElementChild?.tagName,
    ).toBe("IFRAME");
    playing.unmount();

    const loadingBridge = fakeBridge();
    renderPlayer(
      view({ state: "starting", stage: "login" }),
      { debug: "short" },
      loadingBridge,
    );
    expect(screen.queryByText(/FPS/)).toBeNull();
    expect(loadingBridge.setStatsOpen).not.toHaveBeenCalledWith(true);
  });

  it("Player hides the overlay when debug is off", () => {
    renderPlayer(view(), { debug: "off" });
    expect(screen.queryByText(/FPS/)).toBeNull();
  });
});
