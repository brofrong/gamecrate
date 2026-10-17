import { describe, expect, it } from "bun:test";
import {
  C_POINTS,
  DEFAULT_METRICS,
  easeInOut,
  fullWidth,
  LEFT_FACE,
  logoFrame,
  matrixString,
  multiply,
  polygonPath,
  RIGHT_FACE,
  scale,
  translate,
} from "../src/components/brand/logo-geometry";

describe("logo geometry", () => {
  it("frame at 0 places letters in the wordmark", () => {
    const f = logoFrame(0, DEFAULT_METRICS);
    expect(f.viewBoxWidth).toBe(fullWidth(DEFAULT_METRICS));
    expect(f.gTransform).toBe(
      matrixString(multiply(translate(232, 76), scale(0.7))),
    );
    expect(f.bandOpacity).toBe(1);
    expect(f.ame.opacity).toBe(1);
    expect(f.topPoints).toBe(
      "13.40,60.00 100.00,10.00 186.60,60.00 166.90,71.40 100.00,32.75 33.10,71.40",
    );
  });

  it("frame at 1 places letters on the cube faces", () => {
    const f = logoFrame(1, DEFAULT_METRICS);
    expect(f.viewBoxWidth).toBe(200);
    expect(f.gTransform).toBe(
      matrixString(
        multiply(LEFT_FACE, multiply(translate(2.5, 2.5), scale(0.95))),
      ),
    );
    expect(f.cTransform).toBe(
      matrixString(
        multiply(RIGHT_FACE, multiply(translate(2.5, 2.5), scale(0.95))),
      ),
    );
    expect(f.bandOpacity).toBe(0);
    expect(f.ame.opacity).toBe(0);
    expect(f.topSeamPath).toBe("M100 10L100.00 32.80");
  });

  it("frame in between is in between", () => {
    const f = logoFrame(0.5, DEFAULT_METRICS);
    expect(f.viewBoxWidth).toBeGreaterThan(200);
    expect(f.viewBoxWidth).toBeLessThan(fullWidth(DEFAULT_METRICS));
    expect(f.bandOpacity).toBeGreaterThan(0);
    expect(f.bandOpacity).toBeLessThan(1);
  });

  it("polygonPath closes the polygon", () => {
    expect(polygonPath(C_POINTS)).toBe(
      "M0 0L100 0L100 24L24 24L24 76L100 76L100 100L0 100Z",
    );
  });

  it("easeInOut is symmetric", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(1)).toBe(1);
  });
});
