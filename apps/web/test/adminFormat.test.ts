import { describe, expect, it } from "bun:test";
import {
  diskLabel,
  formatAgo,
  formatBytes,
  formatDuration,
  formatUsage,
  purposeLabel,
  sessionStageLabel,
} from "../src/lib/adminFormat";

describe("formatBytes", () => {
  it("1024-основа, одна цифра после запятой от ГБ до 10, дальше — целые", () => {
    expect(formatBytes(317 * 2 ** 20)).toBe("317 МБ");
    expect(formatBytes(2 * 2 ** 30)).toBe("2,0 ГБ");
    expect(formatBytes(7.3 * 2 ** 40)).toBe("7,3 ТБ");
    expect(formatBytes(233 * 2 ** 30)).toBe("233 ГБ");
    expect(formatBytes(512)).toBe("512 Б");
    expect(formatBytes(0)).toBe("0 Б");
  });
});

describe("formatUsage", () => {
  it("занято и всего в единице всего", () => {
    expect(formatUsage(121 * 2 ** 30, 233 * 2 ** 30)).toBe("121 из 233 ГБ");
    expect(formatUsage(1.1 * 2 ** 40, 7.3 * 2 ** 40)).toBe("1,1 из 7,3 ТБ");
  });
});

describe("formatAgo", () => {
  it("секунды, минуты, часы, дни", () => {
    expect(formatAgo(4000)).toBe("4 с назад");
    expect(formatAgo(12 * 60_000)).toBe("12 мин назад");
    expect(formatAgo(3 * 3_600_000)).toBe("3 ч назад");
    expect(formatAgo(2 * 86_400_000)).toBe("2 дн назад");
    expect(formatAgo(-500)).toBe("0 с назад");
  });
});

describe("formatDuration", () => {
  it("минуты, часы с минутами, дни с часами", () => {
    expect(formatDuration(12 * 60_000)).toBe("12 мин");
    expect(formatDuration(65 * 60_000)).toBe("1 ч 5 мин");
    expect(formatDuration(2 * 3_600_000)).toBe("2 ч");
    expect(formatDuration((11 * 24 + 17) * 3_600_000 + 5 * 60_000)).toBe(
      "11 дн 17 ч",
    );
  });
});

describe("diskLabel", () => {
  it("NVMe, HDD и RAID (md127 из Task 1) с дисками-членами", () => {
    expect(
      diskLabel({
        name: "nvme0n1",
        kind: "nvme",
        sizeBytes: 233 * 2 ** 30,
        raidLevel: null,
        members: [],
      }),
    ).toBe("NVMe 233 ГБ");
    expect(
      diskLabel({
        name: "md127",
        kind: "raid",
        sizeBytes: 15625000000 * 512,
        raidLevel: "raid5",
        members: ["sda", "sdb", "sdd"],
      }),
    ).toBe("RAID5 (sda, sdb, sdd) 7,3 ТБ");
    expect(
      diskLabel({
        name: "sdc",
        kind: "hdd",
        sizeBytes: 3.6 * 2 ** 40,
        raidLevel: null,
        members: [],
      }),
    ).toBe("HDD 3,6 ТБ");
  });
});

describe("purposeLabel", () => {
  it("назначения ФС по-русски", () => {
    expect(purposeLabel(["scratch", "steamClient"])).toBe(
      "scratch и шаблон Steam",
    );
    expect(purposeLabel(["library"])).toBe("библиотека игр");
  });
});

describe("sessionStageLabel", () => {
  it("состояние, а при запуске — этап как на экране загрузки", () => {
    expect(sessionStageLabel("playing", "visible")).toBe("играет");
    expect(sessionStageLabel("starting", "steam")).toBe("Запускаем Steam");
    expect(sessionStageLabel("playing", "loading")).toBe("Загружаем игру");
    expect(sessionStageLabel("queued", null)).toBe("Ждём свободный сервер");
    expect(sessionStageLabel("failed", null)).toBe("сбой");
  });
});
