import { describe, expect, it } from "bun:test";
import {
  classifyBlockDevice,
  cpuPercent,
  parseCpuInfo,
  parseCpuTimes,
  parseMeminfo,
  parseNvidiaSmi,
} from "../src/hostProbe";

describe("parseMeminfo", () => {
  it("считает cache как free, used = total - free - cache (фрагмент brofrong)", () => {
    const text = [
      "MemTotal:       32795732 kB",
      "MemFree:         2586332 kB",
      "MemAvailable:   20000000 kB",
      "Buffers:          512984 kB",
      "Cached:         20599344 kB",
      "SwapCached:            0 kB",
      "SReclaimable:    1000000 kB",
      "",
    ].join("\n");
    const totalKb = 32795732;
    const freeKb = 2586332;
    const cacheKb = 512984 + 20599344 + 1000000;
    expect(parseMeminfo(text)).toEqual({
      totalBytes: totalKb * 1024,
      usedBytes: (totalKb - freeKb - cacheKb) * 1024,
      cacheBytes: cacheKb * 1024,
    });
  });

  it("формула used = total - free - cache уходит в минус — откат на total - free", () => {
    // Cache (Buffers+Cached+SReclaimable) больше free+used — несогласованный
    // /proc/meminfo (бывает на некоторых ядрах/контейнерах).
    const text = [
      "MemTotal:       1000000 kB",
      "MemFree:          10000 kB",
      "Buffers:          20000 kB",
      "Cached:          990000 kB",
      "SReclaimable:         0 kB",
      "",
    ].join("\n");
    expect(parseMeminfo(text)).toEqual({
      totalBytes: 1000000 * 1024,
      usedBytes: (1000000 - 10000) * 1024,
      cacheBytes: (20000 + 990000) * 1024,
    });
  });

  it("даже total - free отрицателен — usedBytes = 0, а не минус", () => {
    const text = [
      "MemTotal:        10000 kB",
      "MemFree:         20000 kB",
      "Buffers:             0 kB",
      "Cached:               0 kB",
      "SReclaimable:         0 kB",
      "",
    ].join("\n");
    expect(parseMeminfo(text).usedBytes).toBe(0);
  });
});

describe("parseCpuInfo", () => {
  it("threads = число processor, cores = cpu cores первой записи", () => {
    const text = [
      "processor\t: 0",
      "vendor_id\t: AuthenticAMD",
      "model name\t: AMD Ryzen 5 2600X Six-Core Processor",
      "cpu cores\t: 6",
      "",
      "processor\t: 1",
      "vendor_id\t: AuthenticAMD",
      "model name\t: AMD Ryzen 5 2600X Six-Core Processor",
      "cpu cores\t: 6",
      "",
    ].join("\n");
    expect(parseCpuInfo(text)).toEqual({
      model: "AMD Ryzen 5 2600X Six-Core Processor",
      cores: 6,
      threads: 2,
    });
  });

  it("нет поля cpu cores — cores = threads", () => {
    const text = [
      "processor\t: 0",
      "model name\t: Some CPU",
      "",
      "processor\t: 1",
      "model name\t: Some CPU",
      "",
    ].join("\n");
    expect(parseCpuInfo(text)).toEqual({
      model: "Some CPU",
      cores: 2,
      threads: 2,
    });
  });
});

describe("cpuPercent", () => {
  it("между снимками cpu  100 0 100 800 ... и cpu  150 0 150 900 ... — 50", () => {
    const prev = parseCpuTimes("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 ...");
    const next = parseCpuTimes("cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 ...");
    expect(cpuPercent(prev, next)).toBe(50);
  });

  it("одинаковые снимки — 0 (Δtotal = 0)", () => {
    const snapshot = parseCpuTimes("cpu  100 0 100 800 0 0 0 0 0 0");
    expect(cpuPercent(snapshot, snapshot)).toBe(0);
  });
});

describe("parseNvidiaSmi", () => {
  it("разбирает одну строку CSV", () => {
    expect(
      parseNvidiaSmi(
        "NVIDIA GeForce GTX 1650 SUPER, 4096, 4, 0, 0, 40, 550.163.01\n",
      ),
    ).toEqual([
      {
        name: "NVIDIA GeForce GTX 1650 SUPER",
        memoryTotalBytes: 4096 * 2 ** 20,
        memoryUsedBytes: 4 * 2 ** 20,
        utilPercent: 0,
        encoderPercent: 0,
        temperatureC: 40,
        driver: "550.163.01",
      },
    ]);
  });

  it("[N/A] превращается в null по месту", () => {
    expect(
      parseNvidiaSmi(
        "NVIDIA GeForce GTX 1650 SUPER, [N/A], 4, 0, 0, [N/A], 550.163.01\n",
      ),
    ).toEqual([
      {
        name: "NVIDIA GeForce GTX 1650 SUPER",
        memoryTotalBytes: null,
        memoryUsedBytes: 4 * 2 ** 20,
        utilPercent: 0,
        encoderPercent: 0,
        temperatureC: null,
        driver: "550.163.01",
      },
    ]);
  });

  it("пустая строка — пустой массив", () => {
    expect(parseNvidiaSmi("")).toEqual([]);
  });

  it("плейсхолдеры кроме [N/A] ([Not Supported] и т.п.) — тоже null, не NaN", () => {
    expect(
      parseNvidiaSmi(
        "T4, [Not Supported], [Not Supported], 0, 0, 40, 550.1\n",
      ),
    ).toEqual([
      {
        name: "T4",
        memoryTotalBytes: null,
        memoryUsedBytes: null,
        utilPercent: 0,
        encoderPercent: 0,
        temperatureC: 40,
        driver: "550.1",
      },
    ]);
  });
});

describe("classifyBlockDevice", () => {
  it("nvme0n1 (rot 0) → nvme", () => {
    expect(
      classifyBlockDevice("nvme0n1", {
        rotational: 0,
        sizeSectors: 488397168,
        mdLevel: null,
        slaves: [],
      }),
    ).toEqual({
      name: "nvme0n1",
      kind: "nvme",
      sizeBytes: 488397168 * 512,
      raidLevel: null,
      members: [],
    });
  });

  it("md127 (level raid5, slaves sda,sdb,sdd) → raid", () => {
    expect(
      classifyBlockDevice("md127", {
        rotational: 0,
        sizeSectors: 15625000000,
        mdLevel: "raid5",
        slaves: ["sda", "sdb", "sdd"],
      }),
    ).toEqual({
      name: "md127",
      kind: "raid",
      sizeBytes: 15625000000 * 512,
      raidLevel: "raid5",
      members: ["sda", "sdb", "sdd"],
    });
  });

  it("sda (rot 1) → hdd", () => {
    expect(
      classifyBlockDevice("sda", {
        rotational: 1,
        sizeSectors: 1953525168,
        mdLevel: null,
        slaves: [],
      }),
    ).toEqual({
      name: "sda",
      kind: "hdd",
      sizeBytes: 1953525168 * 512,
      raidLevel: null,
      members: [],
    });
  });

  it("loop0 → undefined", () => {
    expect(
      classifyBlockDevice("loop0", {
        rotational: 0,
        sizeSectors: 1000000,
        mdLevel: null,
        slaves: [],
      }),
    ).toBeUndefined();
  });

  it("размер 0 → undefined", () => {
    expect(
      classifyBlockDevice("sdz", {
        rotational: 0,
        sizeSectors: 0,
        mdLevel: null,
        slaves: [],
      }),
    ).toBeUndefined();
  });
});
