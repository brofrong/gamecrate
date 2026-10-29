// Предложение требований и подсказки о падениях (`src/lib/requirementsSuggest.ts`,
// спека §5.2): чистая логика, без сети и React.
import { describe, expect, it } from "bun:test";
import type { AdminGameMetricsRow } from "@cg/rpc";
import {
  crashHints,
  CRASH_HINT_VRAM_STEP_BYTES,
  suggestRequirements,
} from "../src/lib/requirementsSuggest";

const GiB = 1024 ** 3;

/** Строка `overall` с валидными p95 по умолчанию — тесты переопределяют одно поле. */
const overall = (
  patch: Partial<{
    sessions: number;
    vramP95: number | null;
    ramP95: number | null;
    cpuP95: number | null;
  }> = {},
) => ({
  sessions: 3,
  vramP95: 1 * GiB,
  ramP95: 1 * GiB,
  cpuP95: 1,
  ...patch,
});

describe("suggestRequirements", () => {
  it("2 sessions give no suggestion", () => {
    expect(suggestRequirements(overall({ sessions: 2 }))).toBeNull();
  });

  it("unknown p95 (null) gives no suggestion even with enough sessions", () => {
    expect(suggestRequirements(overall({ vramP95: null }))).toBeNull();
  });

  it("vram 3.3 GiB p95 suggests 4.0 GiB", () => {
    const result = suggestRequirements(overall({ vramP95: 3.3 * GiB }));
    expect(result).not.toBeNull();
    expect(result!.minVramBytes / GiB).toBeCloseTo(4.0, 5);
  });

  it("ram rounds up to whole GiB", () => {
    // 2,2 GiB × 1,2 = 2,64 GiB → вверх до целого GiB = 3.
    const result = suggestRequirements(overall({ ramP95: 2.2 * GiB }));
    expect(result).not.toBeNull();
    expect(result!.minRamBytes / GiB).toBeCloseTo(3, 5);
  });

  it("cpu 2.1 cores suggests 3 threads", () => {
    const result = suggestRequirements(overall({ cpuP95: 2.1 }));
    expect(result).not.toBeNull();
    expect(result!.minCpuThreads).toBe(3);
  });
});

describe("crashHints", () => {
  const row = (
    patch: Partial<AdminGameMetricsRow> & { gpuName: string },
  ): AdminGameMetricsRow => ({
    className: null,
    sessions: 3,
    vramP95: null,
    ramP95: null,
    cpuP95: null,
    gpuUtilP95: null,
    crashShare: 0.3,
    otherShare: 0,
    vramSources: ["process"],
    perSlotVramBytes: 4 * GiB,
    ...patch,
  });

  it("includes a GPU at the threshold (>= 3 sessions, crash share >= 0.3)", () => {
    const result = crashHints([row({ gpuName: "GPU A" })]);
    expect(result).toHaveLength(1);
    expect(result[0]?.gpuName).toBe("GPU A");
    expect(result[0]?.share).toBeCloseTo(0.3, 5);
    expect(result[0]?.suggestVramBytes).toBe(
      4 * GiB + CRASH_HINT_VRAM_STEP_BYTES,
    );
  });

  it("excludes a GPU below the crash share threshold", () => {
    const result = crashHints([row({ gpuName: "GPU B", crashShare: 0.29 })]);
    expect(result).toEqual([]);
  });

  it("excludes a GPU with fewer than 3 sessions even with a high crash share", () => {
    const result = crashHints([
      row({ gpuName: "GPU C", sessions: 2, crashShare: 0.9 }),
    ]);
    expect(result).toEqual([]);
  });

  it("excludes a GPU with unknown VRAM per slot", () => {
    const result = crashHints([
      row({ gpuName: "GPU D", perSlotVramBytes: null }),
    ]);
    expect(result).toEqual([]);
  });
});
