import { describe, expect, it } from "bun:test";
import {
  type MetricsSample,
  MetricsAccumulator,
  sessionVram,
} from "../src/SessionMetrics";

const MiB = 2 ** 20;

const sample = (patch: Partial<MetricsSample> = {}): MetricsSample => ({
  vramBytes: null,
  vramSource: "process",
  ramBytes: null,
  cpuCores: null,
  gpuUtil: null,
  ...patch,
});

describe("MetricsAccumulator", () => {
  it("keeps maxima and p95", () => {
    const metrics = new MetricsAccumulator();
    for (let i = 1; i <= 20; i++)
      metrics.add(
        sample({
          vramBytes: (i % 7) * MiB,
          ramBytes: (i % 5) * 100 * MiB,
          cpuCores: i,
          gpuUtil: 100 - i,
        }),
        10,
      );
    expect(metrics.snapshot()).toEqual({
      gameSeconds: 200,
      peakVramBytes: 6 * MiB,
      peakRamBytes: 400 * MiB,
      // Ближайший ранг: ceil(0.95 · 20) = 19-е по возрастанию.
      cpuCoresP95: 19,
      gpuUtilP95: 98,
      vramSource: "process",
    });
  });

  it("null samples are skipped", () => {
    const metrics = new MetricsAccumulator();
    expect(metrics.snapshot()).toEqual({
      gameSeconds: 0,
      peakVramBytes: null,
      peakRamBytes: null,
      cpuCoresP95: null,
      gpuUtilP95: null,
      vramSource: "gpu_total",
    });
    metrics.add(sample({ cpuCores: 2.5, ramBytes: 3 * MiB }), 10);
    metrics.add(sample(), 10);
    metrics.add(sample({ gpuUtil: 40 }), 4.4);
    expect(metrics.snapshot()).toEqual({
      gameSeconds: 24,
      peakVramBytes: null,
      peakRamBytes: 3 * MiB,
      cpuCoresP95: 2.5,
      gpuUtilP95: 40,
      vramSource: "gpu_total",
    });
  });

  it("vram source is the one of the peak sample", () => {
    const metrics = new MetricsAccumulator();
    metrics.add(sample({ vramBytes: 900 * MiB, vramSource: "gpu_total" }), 10);
    metrics.add(sample({ vramBytes: 1885 * MiB, vramSource: "process" }), 10);
    metrics.add(sample({ vramBytes: 1000 * MiB, vramSource: "gpu_total" }), 10);
    expect(metrics.snapshot()).toMatchObject({
      peakVramBytes: 1885 * MiB,
      vramSource: "process",
    });
  });
});

describe("sessionVram", () => {
  const processes = [
    { pid: 101, usedBytes: 42 * MiB },
    { pid: 102, usedBytes: 1885 * MiB },
    { pid: 103, usedBytes: null },
    { pid: 900, usedBytes: 500 * MiB },
  ];

  it("sums processes of the container", () => {
    expect(
      sessionVram({
        processes,
        pids: [100, 101, 102, 103],
        gpuUsedBytes: 4000 * MiB,
        baselineBytes: 300 * MiB,
      }),
    ).toEqual({ bytes: 1927 * MiB, source: "process" });
  });

  it("gpu_total subtracts baseline and never goes negative", () => {
    // Ни один PID контейнера не нашёлся среди процессов GPU.
    expect(
      sessionVram({
        processes,
        pids: [7, 8],
        gpuUsedBytes: 2500 * MiB,
        baselineBytes: 300 * MiB,
      }),
    ).toEqual({ bytes: 2200 * MiB, source: "gpu_total" });
    expect(
      sessionVram({
        processes: undefined,
        pids: undefined,
        gpuUsedBytes: 200 * MiB,
        baselineBytes: 300 * MiB,
      }),
    ).toEqual({ bytes: 0, source: "gpu_total" });
    // Память совпавшего процесса неизвестна (N/A) — тоже запасной путь.
    expect(
      sessionVram({
        processes,
        pids: [103],
        gpuUsedBytes: null,
        baselineBytes: 300 * MiB,
      }),
    ).toEqual({ bytes: null, source: "gpu_total" });
    expect(
      sessionVram({
        processes: [],
        pids: [],
        gpuUsedBytes: 2500 * MiB,
        baselineBytes: null,
      }),
    ).toEqual({ bytes: null, source: "gpu_total" });
  });
});
