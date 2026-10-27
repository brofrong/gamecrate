// Значение справа на плитке игры (спека 2026-10-27 §3.3): одно короткое слово/число
// и его тон; процент — только для полосы прогресса установки.
import { describe, expect, it } from "bun:test";
import { tileValue } from "../src/lib/tileValue";

const ready = { _tag: "Ready" } as const;
const missing = { _tag: "Missing" } as const;

describe("tileValue", () => {
  it("установлена, играл → часы, muted", () =>
    expect(tileValue({ cloud: ready, playtimeMinutes: 2460 }, false)).toEqual({
      text: "41 ч",
      tone: "muted",
      percent: null,
    }));

  it("установлена, не играл → готова, ok", () =>
    expect(tileValue({ cloud: ready, playtimeMinutes: 0 }, false)).toEqual({
      text: "готова",
      tone: "ok",
      percent: null,
    }));

  it("качается с процентом → 42 %, warn, percent", () =>
    expect(
      tileValue({ cloud: { _tag: "Installing", percent: 42 } }, false),
    ).toEqual({ text: "42 %", tone: "warn", percent: 42 }));

  it("качается без процента → качается, warn", () =>
    expect(
      tileValue({ cloud: { _tag: "Installing", percent: null } }, false),
    ).toEqual({ text: "качается", tone: "warn", percent: null }));

  it("не установлена", () =>
    expect(tileValue({ cloud: missing, playtimeMinutes: 900 }, false)).toEqual({
      text: "не установлена",
      tone: "muted",
      percent: null,
    }));

  it("dimmed перекрывает статус", () =>
    expect(tileValue({ cloud: ready, playtimeMinutes: 900 }, true)).toEqual({
      text: "нужен вход в Steam",
      tone: "muted",
      percent: null,
    }));
});
