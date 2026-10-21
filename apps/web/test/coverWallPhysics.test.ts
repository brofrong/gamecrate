import { describe, expect, it } from "bun:test";
import {
  initialRows,
  rowBaseSpeed,
  stepRows,
} from "../src/lib/coverWallPhysics";

const at = <T>(xs: ReadonlyArray<T>, i: number): T => {
  const v = xs[i];
  if (v === undefined) throw new Error(`no row ${i}`);
  return v;
};

describe("cover wall physics", () => {
  it("held row brakes toward zero, others keep base speed", () => {
    const rows = initialRows(5);
    const next = stepRows(rows, 2, 0.1, () => 1000);
    expect(Math.abs(at(next, 2).v)).toBeLessThan(Math.abs(at(rows, 2).v));
    expect(at(next, 0).v).toBe(at(rows, 0).base);
  });

  it("released row resumes toward base speed", () => {
    const rows = initialRows(3).map((r, i) => (i === 1 ? { ...r, v: 0 } : r));
    const next = stepRows(rows, null, 0.1, () => 1000);
    expect(Math.abs(at(next, 1).v)).toBeGreaterThan(0);
    expect(Math.abs(at(next, 1).v)).toBeLessThan(Math.abs(at(next, 1).base));
  });

  it("position wraps within half width", () => {
    const rows = [{ x: -999, v: -50, base: -50 }];
    expect(
      at(
        stepRows(rows, null, 0.05, () => 1000),
        0,
      ).x,
    ).toBeGreaterThan(-1000);
    const fwd = [{ x: -1, v: 50, base: 50 }];
    expect(
      at(
        stepRows(fwd, null, 0.05, () => 1000),
        0,
      ).x,
    ).toBeLessThanOrEqual(0);
  });

  it("without hover every row keeps its base speed", () => {
    const rows = initialRows(5);
    const next = stepRows(rows, null, 0.5, () => 1000);
    next.forEach((r, i) => expect(r.v).toBe(rowBaseSpeed(i)));
  });
});
