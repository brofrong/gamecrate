import { describe, expect, it } from "bun:test";
import {
  nextPhase,
  PHASE_CUES,
  PHASE_DURATION_MS,
} from "../src/lib/howItWorksTimeline";

describe("how it works timeline", () => {
  it("cues are ordered and inside their phase", () => {
    for (const p of [0, 1, 2] as const) {
      const cues = PHASE_CUES[p];
      cues.forEach((c, i) => {
        expect(c.at).toBeLessThan(PHASE_DURATION_MS[p]);
        const prev = cues[i - 1];
        if (prev) expect(c.at).toBeGreaterThan(prev.at);
      });
    }
  });

  it("phases cycle", () => {
    expect(nextPhase(0)).toBe(1);
    expect(nextPhase(1)).toBe(2);
    expect(nextPhase(2)).toBe(0);
  });
});
