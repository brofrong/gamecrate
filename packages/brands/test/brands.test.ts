import { describe, expect, it } from "bun:test";
import {
  BRANDS,
  brandForHost,
  isBrandId,
  normalizeHost,
  parseBrandHosts,
} from "../src/index";

describe("parseBrandHosts", () => {
  it("парсит пары host=id, хосты приводит к нижнему регистру", () => {
    const map = parseBrandHosts(
      "Play.Beeline.ru=beeline, beeline.brofrong.ru=beeline",
    );
    expect(map.size).toBe(2);
    expect(map.get("play.beeline.ru")).toBe("beeline");
    expect(map.get("beeline.brofrong.ru")).toBe("beeline");
  });

  it("пустая строка даёт пустую карту", () => {
    expect(parseBrandHosts("").size).toBe(0);
  });

  it("бросает на неизвестном id бренда", () => {
    expect(() => parseBrandHosts("x.ru=nope")).toThrow("x.ru=nope");
  });

  it("бросает на паре без знака =", () => {
    expect(() => parseBrandHosts("x.ru")).toThrow("x.ru");
  });
});

describe("brandForHost", () => {
  const map = parseBrandHosts(
    "Play.Beeline.ru=beeline, beeline.brofrong.ru=beeline",
  );

  it("находит бренд по карте хостов без учёта порта и регистра", () => {
    expect(brandForHost("Play.Beeline.ru:443", map)).toBe("beeline");
  });

  it("распознаёт <id>.localhost без карты", () => {
    expect(brandForHost("beeline.localhost:5173", new Map())).toBe("beeline");
  });

  it("возвращает gamecrate для хоста не из карты", () => {
    expect(brandForHost("game.brofrong.ru", map)).toBe("gamecrate");
  });

  it("возвращает gamecrate, если host не передан", () => {
    expect(brandForHost(undefined, map)).toBe("gamecrate");
  });

  it("возвращает gamecrate для неизвестного <id>.localhost", () => {
    expect(brandForHost("evil.localhost", new Map())).toBe("gamecrate");
  });
});

describe("normalizeHost", () => {
  it("убирает порт и приводит к нижнему регистру", () => {
    expect(normalizeHost("Play.X.ru:443")).toBe("play.x.ru");
  });
});

describe("isBrandId", () => {
  it("true для известных id, false для прочих строк", () => {
    expect(isBrandId("gamecrate")).toBe(true);
    expect(isBrandId("beeline")).toBe(true);
    expect(isBrandId("nope")).toBe(false);
  });
});

describe("BRANDS", () => {
  it("содержит данные бренда beeline", () => {
    expect(BRANDS.beeline.name).toBe("билайн");
  });

  it("у gamecrate нет кастомных иконок", () => {
    expect(BRANDS.gamecrate.icons).toBeNull();
  });
});
