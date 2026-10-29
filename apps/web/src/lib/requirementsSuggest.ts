// Предложение требований игры и подсказки о падениях (вкладка «Игры» → игра,
// спека §5.2, Global Constraints): чистая логика без сети — панель вызывает
// её на данных `admin.games.requirements`. Пороги — константы (5 мин уже
// применены на сервере, здесь ≥ 3 сессии, запас 20%, порог падений 30%).
import type { AdminGameMetricsRow, Requirements } from "@cg/rpc";

const GiB = 1024 ** 3;

/** Нужно хотя бы столько долгих сессий, чтобы считать p95 показательным. */
export const MIN_SESSIONS_FOR_SUGGESTION = 3;

/** Запас сверх p95 пиковых значений («Предложение», спека §5.2). */
export const SUGGESTION_FACTOR = 1.2;

/** Доля `crash` на модели GPU, с которой показывается подсказка. */
export const CRASH_HINT_THRESHOLD = 0.3;

/** Прибавка к текущей видеопамяти карты на слот в подсказке о падениях. */
export const CRASH_HINT_VRAM_STEP_BYTES = 0.5 * GiB;

/** Вверх до кратного `stepBytes` (0,5 GiB для VRAM, 1 GiB для RAM). */
const roundUpTo = (bytes: number, stepBytes: number) =>
  Math.ceil(bytes / stepBytes) * stepBytes;

/**
 * Требования по сумме всех сессий игры (`overall` из `admin.games.requirements`):
 * p95 пиковых значений × `SUGGESTION_FACTOR`, VRAM вверх до 0,5 GiB, RAM — до
 * 1 GiB, потоки CPU — до целого. Меньше `MIN_SESSIONS_FOR_SUGGESTION` долгих
 * сессий или хоть один p95 неизвестен (замер не удался ни на одной сессии) —
 * `null` (нечего предлагать).
 */
export function suggestRequirements(overall: {
  readonly sessions: number;
  readonly vramP95: number | null;
  readonly ramP95: number | null;
  readonly cpuP95: number | null;
}): Requirements | null {
  if (overall.sessions < MIN_SESSIONS_FOR_SUGGESTION) return null;
  if (
    overall.vramP95 === null ||
    overall.ramP95 === null ||
    overall.cpuP95 === null
  ) {
    return null;
  }
  return {
    minVramBytes: roundUpTo(overall.vramP95 * SUGGESTION_FACTOR, 0.5 * GiB),
    minRamBytes: roundUpTo(overall.ramP95 * SUGGESTION_FACTOR, 1 * GiB),
    minCpuThreads: Math.ceil(overall.cpuP95 * SUGGESTION_FACTOR),
  };
}

/** Подсказка о падениях на одной модели GPU: доля `crash` и чем её покрыть. */
export type CrashHint = {
  readonly gpuName: string;
  readonly share: number;
  readonly suggestVramBytes: number;
};

/**
 * Модели GPU, где игра падает часто (спека §5.2): хотя бы
 * `MIN_SESSIONS_FOR_SUGGESTION` сессий и доля `crash` не меньше
 * `CRASH_HINT_THRESHOLD`. `suggestVramBytes` — видеопамять этой карты на
 * слот плюс `CRASH_HINT_VRAM_STEP_BYTES`; строка без известного железа
 * (`perSlotVramBytes: null`) не попадает в список — нечем предложить.
 */
export function crashHints(
  rows: ReadonlyArray<AdminGameMetricsRow>,
): ReadonlyArray<CrashHint> {
  return rows
    .filter(
      (row) =>
        row.sessions >= MIN_SESSIONS_FOR_SUGGESTION &&
        row.crashShare >= CRASH_HINT_THRESHOLD &&
        row.perSlotVramBytes !== null,
    )
    .map((row) => ({
      gpuName: row.gpuName,
      share: row.crashShare,
      suggestVramBytes: (row.perSlotVramBytes as number) + CRASH_HINT_VRAM_STEP_BYTES,
    }));
}
