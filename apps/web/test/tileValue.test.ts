// Значение справа на плитке игры (спека 2026-10-27 §3.3): одно короткое слово/число
// и его тон; процент — только для полосы прогресса установки.
import { describe, expect, it } from "bun:test";
import { headerUrl } from "../src/components/app/GameCover";
import { coverUrl, heroUrl } from "../src/lib/gameHero";
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

  // Секция «Нужна установка» и кнопка «Установить» уже говорят это — на плитке пусто,
  // иначе на телефоне слово съедает название (прогон на библиотеке владельца).
  it("не установлена → пусто", () =>
    expect(tileValue({ cloud: missing, playtimeMinutes: 900 }, false)).toEqual({
      text: "",
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

describe("own games", () => {
  it("own tile says бесплатно, not нужен вход в Steam", () => {
    const own = { appId: 1900000001, cloud: ready, playtimeMinutes: 900 };
    const free = { text: "бесплатно", tone: "ok", percent: null } as const;
    expect(tileValue(own, false)).toEqual(free);
    expect(tileValue(own, true)).toEqual(free);
    // Steam-игра с тем же статусом — как раньше.
    expect(tileValue({ ...own, appId: 620 }, true).text).toBe(
      "нужен вход в Steam",
    );
  });

  it("own game covers come from /own-games", () => {
    expect(headerUrl(1900000001)).toBe("/own-games/1900000001/header.jpg");
    expect(heroUrl(1900000001)).toBe("/own-games/1900000001/hero.jpg");
    expect(coverUrl(1900000001)).toBe("/own-games/1900000001/cover.jpg");
    // Steam-игры — по-прежнему с CDN Steam.
    expect(headerUrl(620)).toBe(
      "https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg",
    );
    expect(heroUrl(620)).toBe(
      "https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_hero.jpg",
    );
  });
});
