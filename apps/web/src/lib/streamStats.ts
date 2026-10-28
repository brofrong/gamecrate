// Окно статистики стрима (спека §5, бриф задачи 3): скользящее окно в 60 с поверх времени
// кадров и выборок Selkies (`SelkiesSample`, см. `selkiesBridge.ts`), перцентили ближайшего
// ранга и 1% low FPS. Чистая логика без React и DOM — наполняется из хука (задача 5).
import type { SelkiesSample } from "./selkiesBridge";

/** Ширина окна статистики. */
export const STATS_WINDOW_MS = 60_000;
/** Пороги «плохого» значения для подсветки в таблице (задача 5). */
export const BAD_FRAME_MS = 25;
export const BAD_PING_MS = 50;
export const BAD_DECODE_MS = 10;
/** Разрыв между кадрами длиннее этого не считается кадром (пауза/сворачивание вкладки). */
export const MAX_FRAME_GAP_MS = 1_000;

/** Перцентили ближайшего ранга плюс максимум. */
export type Percentiles = {
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

/** Точка временного ряда: момент на часах родителя и значение. */
export type Point = {
  readonly at: number;
  readonly value: number;
};

/** Статистика окна по состоянию на момент `now`. */
export type StatsSnapshot = {
  /** Кадров за последнюю секунду; если кадров в окне нет — `fps` из последней выборки Selkies. */
  readonly fps: number | null;
  readonly low1: number | null;
  readonly frameTimes: ReadonlyArray<Point>;
  readonly ping: ReadonlyArray<Point>;
  readonly bitrate: ReadonlyArray<Point>;
  readonly table: {
    readonly frame: Percentiles | null;
    readonly ping: Percentiles | null;
    readonly decode: Percentiles | null;
  };
  readonly latest: SelkiesSample | null;
};

/** Перцентиль ближайшего ранга: `sorted[ceil(p/100·n) − 1]`. Пустой массив — `null`. */
export function percentiles(values: ReadonlyArray<number>): Percentiles | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number => {
    const index = Math.ceil((p / 100) * n) - 1;
    return sorted[index] as number;
  };
  return {
    p50: rank(50),
    p90: rank(90),
    p95: rank(95),
    p99: rank(99),
    max: sorted[n - 1] as number,
  };
}

/** 1% low FPS: 1000 / среднее худших `max(1, ceil(n/100))` кадров. Пустой массив — `null`. */
export function onePercentLowFps(
  frameMs: ReadonlyArray<number>,
): number | null {
  const n = frameMs.length;
  if (n === 0) return null;
  const count = Math.max(1, Math.ceil(n / 100));
  const sorted = [...frameMs].sort((a, b) => a - b);
  const worst = sorted.slice(n - count);
  const average = worst.reduce((sum, value) => sum + value, 0) / count;
  return 1000 / average;
}

/** `true`, если значение можно добавить точкой/в таблицу — не `null` и не `NaN`/`Infinity`. */
const isUsable = (value: number | null): value is number =>
  value !== null && Number.isFinite(value);

/** Отбрасывает из начала массива (сортированного по `at`) точки старше `at − STATS_WINDOW_MS`. */
function evictStale(points: Point[], at: number): void {
  const threshold = at - STATS_WINDOW_MS;
  let dropCount = 0;
  while (dropCount < points.length && points[dropCount]!.at <= threshold)
    dropCount++;
  if (dropCount > 0) points.splice(0, dropCount);
}

/** Скользящее окно статистики стрима: копится `addFrame`/`addSample`, читается `snapshot`. */
export function createStatsWindow(): {
  addFrame(at: number, frameMs: number): void;
  addSample(at: number, sample: SelkiesSample): void;
  snapshot(now: number): StatsSnapshot;
  clear(): void;
} {
  const frames: Point[] = [];
  const ping: Point[] = [];
  const bitrate: Point[] = [];
  const decode: Point[] = [];
  let latest: SelkiesSample | null = null;

  return {
    addFrame(at, frameMs) {
      if (frameMs > MAX_FRAME_GAP_MS) return;
      frames.push({ at, value: frameMs });
      evictStale(frames, at);
    },
    addSample(at, sample) {
      latest = sample;
      if (isUsable(sample.rttMs)) {
        ping.push({ at, value: sample.rttMs });
        evictStale(ping, at);
      }
      if (isUsable(sample.mbps)) {
        bitrate.push({ at, value: sample.mbps });
        evictStale(bitrate, at);
      }
      if (isUsable(sample.decodeMs)) {
        decode.push({ at, value: sample.decodeMs });
        evictStale(decode, at);
      }
    },
    snapshot(now) {
      evictStale(frames, now);
      evictStale(ping, now);
      evictStale(bitrate, now);
      evictStale(decode, now);

      const frameValues = frames.map((point) => point.value);
      const lastSecondStart = now - 1_000;
      const framesLastSecond = frames.filter(
        (point) => point.at > lastSecondStart && point.at <= now,
      ).length;

      return {
        fps: framesLastSecond > 0 ? framesLastSecond : (latest?.fps ?? null),
        low1: onePercentLowFps(frameValues),
        frameTimes: frames.slice(),
        ping: ping.slice(),
        bitrate: bitrate.slice(),
        table: {
          frame: percentiles(frameValues),
          ping: percentiles(ping.map((point) => point.value)),
          decode: percentiles(decode.map((point) => point.value)),
        },
        latest,
      };
    },
    clear() {
      frames.length = 0;
      ping.length = 0;
      bitrate.length = 0;
      decode.length = 0;
      latest = null;
    },
  };
}
