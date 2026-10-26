// Форматирование времени и дат для главной `/app`: длительность, относительная
// дата последней игры, подпись месяца и его сдвиг. Чистые функции, без DOM.
import { describe, expect, it } from "bun:test";
import {
  currentMonth,
  formatHM,
  formatHoursInGame,
  formatMinutes,
  formatMonth,
  formatRelativeDate,
  monthShift,
} from "../src/lib/formatTime";

describe("formatMinutes", () => {
  it("hours and minutes", () => {
    expect(formatMinutes(134)).toBe("2 ч 14 м");
  });

  it("minutes only", () => {
    expect(formatMinutes(38)).toBe("38 м");
  });

  it("zero", () => {
    expect(formatMinutes(0)).toBe("0 м");
  });

  it("exact hours, no remainder", () => {
    expect(formatMinutes(120)).toBe("2 ч");
  });
});

describe("formatHM", () => {
  it("hours without padding, minutes always two digits", () => {
    expect(formatHM(460)).toBe("7:40");
  });

  it("pads single-digit minutes", () => {
    expect(formatHM(305)).toBe("5:05");
  });

  it("zero hours", () => {
    expect(formatHM(38)).toBe("0:38");
  });

  it("zero", () => {
    expect(formatHM(0)).toBe("0:00");
  });
});

describe("formatHoursInGame", () => {
  it("whole hours", () => {
    expect(formatHoursInGame(840)).toBe("14 ч в игре");
  });

  it("minutes only", () => {
    expect(formatHoursInGame(38)).toBe("38 мин в игре");
  });

  it("never played", () => {
    expect(formatHoursInGame(0)).toBe("не запускалась");
  });
});

describe("formatRelativeDate", () => {
  // Полдень по местному времени — чтобы сдвиг часового пояса не перескакивал через полночь.
  const now = new Date(2026, 9, 23, 12, 0, 0);

  it("today", () => {
    expect(formatRelativeDate(now.toISOString(), now)).toBe("сегодня");
  });

  it("yesterday", () => {
    const yesterday = new Date(2026, 9, 22, 12, 0, 0);
    expect(formatRelativeDate(yesterday.toISOString(), now)).toBe("вчера");
  });

  it("earlier this year", () => {
    const d = new Date(2026, 9, 21, 12, 0, 0);
    expect(formatRelativeDate(d.toISOString(), now)).toBe("21 окт");
  });

  it("different year", () => {
    const d = new Date(2025, 9, 21, 12, 0, 0);
    expect(formatRelativeDate(d.toISOString(), now)).toBe("21 окт 2025");
  });
});

describe("formatMonth", () => {
  it("formats YYYY-MM as a Russian month name and year", () => {
    expect(formatMonth("2026-10")).toBe("Октябрь 2026");
  });
});

describe("monthShift", () => {
  it("shifts back across a year boundary", () => {
    expect(monthShift("2026-01", -1)).toBe("2025-12");
  });

  it("shifts forward within the same year", () => {
    expect(monthShift("2026-10", 1)).toBe("2026-11");
  });

  it("shifts forward across a year boundary", () => {
    expect(monthShift("2026-12", 1)).toBe("2027-01");
  });
});

describe("currentMonth", () => {
  it("formats the local month as YYYY-MM", () => {
    expect(currentMonth(new Date(2026, 9, 23, 12, 0, 0))).toBe("2026-10");
  });
});
