// Замеры ресурсов игры по сессии (спека 2026-10-29 «требования к железу», §4.1):
// пока процесс игры жив, SessionSupervisor раз в METRICS_SAMPLE снимает замер
// контейнера сессии и складывает его в MetricsAccumulator; накопленное целиком
// уходит оркестратору отчётом `SessionMetrics` раз в METRICS_REPORT и при конце
// игры. Здесь — только чистый счёт; сами замеры снимает супервизор.
import type { AgentReport, VramSource } from "@cg/rpc";
import { Duration } from "effect";

/** Период замера ресурсов игры. */
export const METRICS_SAMPLE = Duration.seconds(10);
/** Период отчёта `SessionMetrics`, пока игра идёт. */
export const METRICS_REPORT = Duration.seconds(60);

/** Поля отчёта `SessionMetrics` без тега и сессии. */
export type SessionMetricsReport = Omit<
  Extract<AgentReport, { _tag: "SessionMetrics" }>,
  "_tag" | "sessionId"
>;

/**
 * Один замер; `null` — это поле не удалось снять (остальные идут в счёт).
 * `vramSource` — откуда `vramBytes` (см. {@link sessionVram}).
 */
export interface MetricsSample {
  readonly vramBytes: number | null;
  readonly vramSource: VramSource;
  readonly ramBytes: number | null;
  readonly cpuCores: number | null;
  readonly gpuUtil: number | null;
}

/** Замер без единого значения: только время (хвост игры после последнего замера). */
export const EMPTY_SAMPLE: MetricsSample = {
  vramBytes: null,
  vramSource: "gpu_total",
  ramBytes: null,
  cpuCores: null,
  gpuUtil: null,
};

/** p95 по ближайшему рангу: `ceil(0.95·n)`-е по возрастанию; пусто — `null`. */
const p95 = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null;
};

/**
 * Накопленные замеры сессии: максимумы VRAM и RAM, вся выборка CPU и GPU для
 * p95 (замер раз в 10 с — за 10 часов игры 3600 чисел, держим в памяти), время
 * игры. `vramSource` — источник замера с пиковой VRAM (ни одного — `gpu_total`,
 * запасной путь).
 */
export class MetricsAccumulator {
  private seconds = 0;
  private peakVram: number | null = null;
  private vramSource: VramSource = "gpu_total";
  private peakRam: number | null = null;
  private readonly cpu: Array<number> = [];
  private readonly gpu: Array<number> = [];

  /** Замер `sample`, снятый за `seconds` игры с прошлого замера. */
  add(sample: MetricsSample, seconds: number): void {
    this.seconds += Math.max(0, seconds);
    if (
      sample.vramBytes !== null &&
      (this.peakVram === null || sample.vramBytes > this.peakVram)
    ) {
      this.peakVram = sample.vramBytes;
      this.vramSource = sample.vramSource;
    }
    if (
      sample.ramBytes !== null &&
      (this.peakRam === null || sample.ramBytes > this.peakRam)
    )
      this.peakRam = sample.ramBytes;
    if (sample.cpuCores !== null) this.cpu.push(sample.cpuCores);
    if (sample.gpuUtil !== null) this.gpu.push(sample.gpuUtil);
  }

  snapshot(): SessionMetricsReport {
    return {
      gameSeconds: Math.round(this.seconds),
      peakVramBytes: this.peakVram,
      peakRamBytes: this.peakRam,
      cpuCoresP95: p95(this.cpu),
      gpuUtilP95: p95(this.gpu),
      vramSource: this.vramSource,
    };
  }
}

/**
 * VRAM сессии на один замер («Итоги Task 1» плана). `process`: сумма памяти
 * процессов GPU (`parseGpuProcesses`), чьи host PID есть среди `pids`
 * контейнера (`docker top`; сюда входит и кодировщик Selkies — след сессии
 * целиком). Ни один PID не совпал (или память совпавших — `N/A`, или списков
 * нет) — `gpu_total`: занятая на карте память минус занятая до старта игры
 * (`baselineBytes`), не меньше 0; неизвестна любая из двух — `null`.
 */
export const sessionVram = (input: {
  readonly processes:
    | ReadonlyArray<{ readonly pid: number; readonly usedBytes: number | null }>
    | undefined;
  readonly pids: ReadonlyArray<number> | undefined;
  readonly gpuUsedBytes: number | null;
  readonly baselineBytes: number | null;
}): { readonly bytes: number | null; readonly source: VramSource } => {
  if (input.processes !== undefined && input.pids !== undefined) {
    const pids = new Set(input.pids);
    let bytes = 0;
    let matched = false;
    for (const process of input.processes)
      if (pids.has(process.pid) && process.usedBytes !== null) {
        bytes += process.usedBytes;
        matched = true;
      }
    if (matched) return { bytes, source: "process" };
  }
  return {
    bytes:
      input.gpuUsedBytes === null || input.baselineBytes === null
        ? null
        : Math.max(0, input.gpuUsedBytes - input.baselineBytes),
    source: "gpu_total",
  };
};
