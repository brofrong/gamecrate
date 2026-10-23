import { describe, expect, it } from "bun:test";
import {
  approach,
  assemblyLevel,
  type Cube,
  HOME_COUNT,
  homePosition,
  makeCubes,
  targetPosition,
} from "../src/lib/cubeAssembly";

describe("cube assembly model", () => {
  it("level follows the form", () => {
    expect(assemblyLevel({ email: "", codeLength: 0, submitted: false })).toBe(
      0,
    );
    expect(
      assemblyLevel({
        email: "ivan@gmail.com",
        codeLength: 0,
        submitted: false,
      }),
    ).toBe(1);
    expect(
      assemblyLevel({
        email: "ivan@gmail.com",
        codeLength: 6,
        submitted: false,
      }),
    ).toBe(2);
    expect(assemblyLevel({ email: "", codeLength: 0, submitted: true })).toBe(
      2,
    );
  });

  it("27 cubes sorted bottom layer first", () => {
    const cubes = makeCubes(() => 0.5);
    expect(cubes).toHaveLength(27);
    expect(cubes[0]).toMatchObject({ i: 0, j: 0, k: 0 });
    expect(cubes.at(-1)).toMatchObject({ i: 2, j: 2, k: 2 });
  });

  it("home position is isometric", () =>
    expect(homePosition({ i: 1, j: 0, k: 1 } as Cube, 100, 200, 34)).toEqual({
      x: 134,
      y: 183,
    }));

  it("only HOME_COUNT cubes are home at each level", () => {
    const cubes = makeCubes(Math.random);
    for (const level of [0, 1, 2] as const)
      expect(
        cubes.filter(
          (c, n) => targetPosition(c, n, level, 0, 0, 34, 0, false).home,
        ),
      ).toHaveLength(HOME_COUNT[level]);
  });

  it("approach moves 6% of the way", () => expect(approach(0, 100)).toBe(6));
});
