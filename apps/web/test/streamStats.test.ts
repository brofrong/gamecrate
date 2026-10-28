// Окно статистики стрима (спека §5, бриф задачи 3): перцентили ближайшего ранга, 1% low FPS,
// скользящее окно в 60 с поверх кадров и выборок Selkies. Чистая логика без React.
import { describe, expect, it } from "bun:test";
import type { SelkiesSample } from "../src/lib/selkiesBridge";
import {
  createStatsWindow,
  onePercentLowFps,
  percentiles,
} from "../src/lib/streamStats";

/** Выборка Selkies с заданными числовыми полями, остальное — `null`. */
function sample(overrides: Partial<SelkiesSample>): SelkiesSample {
  return {
    fps: null,
    mbps: null,
    rttMs: null,
    decodeMs: null,
    jitterMs: null,
    lossPercent: null,
    framesDropped: null,
    codec: null,
    resolution: null,
    ...overrides,
  };
}

describe("percentiles", () => {
  it("1..100 даёт точные перцентили ближайшего ранга", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentiles(values)).toEqual({
      p50: 50,
      p90: 90,
      p95: 95,
      p99: 99,
      max: 100,
    });
  });

  it("пустой массив — null", () => {
    expect(percentiles([])).toBeNull();
  });

  it("один элемент — он же во всех полях", () => {
    expect(percentiles([7])).toEqual({
      p50: 7,
      p90: 7,
      p95: 7,
      p99: 7,
      max: 7,
    });
  });
});

describe("onePercentLowFps", () => {
  it("99 кадров по 10 мс + один 50 мс → 20", () => {
    const frames = [...Array(99).fill(10), 50];
    expect(onePercentLowFps(frames)).toBe(20);
  });

  it("198 кадров по 10 мс + 2 по 40 мс → 25", () => {
    const frames = [...Array(198).fill(10), 40, 40];
    expect(onePercentLowFps(frames)).toBe(25);
  });

  it("пустой массив — null", () => {
    expect(onePercentLowFps([])).toBeNull();
  });
});

describe("createStatsWindow: fps за последнюю секунду", () => {
  it("кадры каждые 16 мс на [0, 2000) → snapshot(2000).fps = 62", () => {
    const win = createStatsWindow();
    for (let at = 0; at < 2000; at += 16) win.addFrame(at, 16);
    expect(win.snapshot(2000).fps).toBe(62);
  });

  it("без кадров — fps берётся из latest.fps Selkies", () => {
    const win = createStatsWindow();
    win.addSample(500, sample({ fps: 59.8 }));
    expect(win.snapshot(2000).fps).toBe(59.8);
  });
});

describe("createStatsWindow: разрывы длиннее секунды не считаются кадрами", () => {
  it("addFrame с frameMs = 30 000 не попадает в frameTimes/table.frame/low1", () => {
    const win = createStatsWindow();
    win.addFrame(0, 30_000);
    const snap = win.snapshot(1000);
    expect(snap.frameTimes).toEqual([]);
    expect(snap.table.frame).toBeNull();
    expect(snap.low1).toBeNull();
  });
});

describe("createStatsWindow: старые точки покидают окно", () => {
  it("кадр и выборка в at = 0 — пусто после 60 001", () => {
    const win = createStatsWindow();
    win.addFrame(0, 16);
    win.addSample(0, sample({ rttMs: 10 }));
    const snap = win.snapshot(60_001);
    expect(snap.frameTimes).toEqual([]);
    expect(snap.ping).toEqual([]);
    expect(snap.table.frame).toBeNull();
    expect(snap.table.ping).toBeNull();
  });

  it("точка в at = 60 000 ещё в окне при now = 119 999", () => {
    const win = createStatsWindow();
    win.addFrame(60_000, 16);
    win.addSample(60_000, sample({ rttMs: 10 }));
    const snap = win.snapshot(119_999);
    expect(snap.frameTimes).toEqual([{ at: 60_000, value: 16 }]);
    expect(snap.ping).toEqual([{ at: 60_000, value: 10 }]);
  });
});

describe("createStatsWindow: выборки кормят ping, bitrate и decode", () => {
  it("три выборки → ping из трёх точек, table.ping.max = 30, table.decode.p50 = 2", () => {
    const win = createStatsWindow();
    win.addSample(0, sample({ rttMs: 10, mbps: 18, decodeMs: 2 }));
    win.addSample(1000, sample({ rttMs: 20, mbps: 18, decodeMs: 2 }));
    win.addSample(2000, sample({ rttMs: 30, mbps: 18, decodeMs: 2 }));

    const snap = win.snapshot(2000);
    expect(snap.ping).toEqual([
      { at: 0, value: 10 },
      { at: 1000, value: 20 },
      { at: 2000, value: 30 },
    ]);
    expect(snap.table.ping?.max).toBe(30);
    expect(snap.table.decode?.p50).toBe(2);
  });

  it("выборка с rttMs: null не попадает в ping; latest — последняя выборка", () => {
    const win = createStatsWindow();
    win.addSample(0, sample({ rttMs: 10 }));
    const last = sample({ rttMs: null, mbps: 18 });
    win.addSample(1000, last);

    const snap = win.snapshot(1000);
    expect(snap.ping).toEqual([{ at: 0, value: 10 }]);
    expect(snap.latest).toEqual(last);
  });

  it("не-конечное (NaN) значение поля трактуется как null: не попадает ни в точки, ни в таблицу", () => {
    const win = createStatsWindow();
    win.addSample(0, sample({ rttMs: 10, mbps: 18, decodeMs: 2 }));
    win.addSample(1000, sample({ rttMs: Number.NaN, mbps: Number.NaN, decodeMs: Number.NaN }));

    const snap = win.snapshot(1000);
    expect(snap.ping).toEqual([{ at: 0, value: 10 }]);
    expect(snap.bitrate).toEqual([{ at: 0, value: 18 }]);
    expect(snap.table.ping?.max).toBe(10);
    expect(snap.table.decode?.max).toBe(2);
  });
});

describe("createStatsWindow: clear", () => {
  it("забывает все кадры, выборки и latest", () => {
    const win = createStatsWindow();
    win.addFrame(0, 16);
    win.addSample(0, sample({ rttMs: 10 }));
    win.clear();

    const snap = win.snapshot(0);
    expect(snap.frameTimes).toEqual([]);
    expect(snap.ping).toEqual([]);
    expect(snap.latest).toBeNull();
    expect(snap.fps).toBeNull();
  });
});
