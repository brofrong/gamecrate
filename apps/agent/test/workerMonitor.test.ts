import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReport } from "@cg/rpc";
import { Context, Duration, Effect, Layer, Queue, References } from "effect";
import { TestClock } from "effect/testing";
import { AgentConfig } from "../src/config";
import {
  defaultHostProbe,
  HostProbe,
  type HostProbeShape,
  STATS_INTERVAL,
  WorkerMonitor,
  type WorkerMonitorShape,
} from "../src/WorkerMonitor";
import { testConfig } from "./fakes";

const GiB = 2 ** 30;
const MiB = 2 ** 20;

/** `/proc/cpuinfo` brofrong: Ryzen 5 2600X, 6 ядер / 12 потоков. */
const cpuinfo = Array.from({ length: 12 }, (_, i) =>
  [
    `processor\t: ${i}`,
    "vendor_id\t: AuthenticAMD",
    "model name\t: AMD Ryzen 5 2600X Six-Core Processor",
    "cpu cores\t: 6",
    "",
  ].join("\n"),
).join("\n");

const meminfo = [
  "MemTotal:       32795732 kB",
  "MemFree:         2586332 kB",
  "MemAvailable:   20000000 kB",
  "Buffers:          512984 kB",
  "Cached:         20599344 kB",
  "SReclaimable:    1000000 kB",
  "",
].join("\n");

const smi = "NVIDIA GeForce GTX 1650 SUPER, 4096, 4, 7, 3, 40, 550.163.01\n";

/** Блочные устройства brofrong (+ loop0, который не показываем). */
const blockDevices: Record<
  string,
  { size: number; rotational: 0 | 1; level?: string; slaves?: string[] }
> = {
  loop0: { size: 1000000, rotational: 0 },
  md127: {
    size: 15625000000,
    rotational: 0,
    level: "raid5",
    slaves: ["sda", "sdb", "sdd"],
  },
  nvme0n1: { size: 488397168, rotational: 0 },
  sda: { size: 1953525168, rotational: 1 },
  sdb: { size: 1953525168, rotational: 1 },
  sdc: { size: 976773168, rotational: 0 },
  sdd: { size: 1953525168, rotational: 1 },
};

type FsInfo = {
  dev: number;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
};

/** Фейковый хост brofrong; поля можно поменять до старта монитора. */
const makeHost = () => {
  const host = {
    /** Снимки `/proc/stat` по порядку чтения (последний повторяется). */
    procStat: [
      "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3",
      "cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 1 2 3",
      "cpu  250 0 250 900 0 0 0 0 0 0\ncpu0 1 2 3",
      "cpu  250 0 250 1100 0 0 0 0 0 0\ncpu0 1 2 3",
    ],
    statReads: 0,
    uptimeReads: 0,
    smi: smi as string | undefined,
    /** Сколько раз прочитан nvidia-smi (проверка, что snapshot зовёт его один раз). */
    smiReads: 0,
    fs: new Map<string, FsInfo>([
      [
        "/scratch",
        {
          dev: 2049,
          totalBytes: 400 * GiB,
          usedBytes: 100 * GiB,
          freeBytes: 280 * GiB,
        },
      ],
      [
        "/raid/cloud-gaming/steam-client",
        {
          dev: 2049,
          totalBytes: 400 * GiB,
          usedBytes: 100 * GiB,
          freeBytes: 280 * GiB,
        },
      ],
      [
        "/raid/cloud-gaming/library",
        {
          dev: 2431,
          totalBytes: 7000 * GiB,
          usedBytes: 1000 * GiB,
          freeBytes: 6000 * GiB,
        },
      ],
    ]),
    mtimes: new Map<string, Date>([
      ["/raid/cloud-gaming/steam-client", new Date("2026-10-27T23:11:00.000Z")],
    ]),
  };
  const sys = (path: string): string | undefined => {
    const match = /^\/sys\/block\/([^/]+)\/(.+)$/.exec(path);
    if (match === null) return undefined;
    const device = blockDevices[match[1]!];
    if (device === undefined) return undefined;
    switch (match[2]) {
      case "size":
        return `${device.size}\n`;
      case "queue/rotational":
        return `${device.rotational}\n`;
      case "md/level":
        return device.level === undefined ? undefined : `${device.level}\n`;
      default:
        return undefined;
    }
  };
  const probe: HostProbeShape = {
    readText: (path) =>
      Effect.sync(() => {
        switch (path) {
          case "/proc/cpuinfo":
            return cpuinfo;
          case "/proc/meminfo":
            return meminfo;
          case "/proc/stat":
            return host.procStat[
              Math.min(host.statReads++, host.procStat.length - 1)
            ];
          case "/proc/uptime":
            return `${1000 + 5 * ++host.uptimeReads}.37 20000.00\n`;
          default:
            return sys(path);
        }
      }),
    listDir: (path) =>
      Effect.sync(() => {
        if (path === "/sys/block") return Object.keys(blockDevices);
        const match = /^\/sys\/block\/([^/]+)\/md\/slaves$/.exec(path);
        return match === null ? [] : (blockDevices[match[1]!]?.slaves ?? []);
      }),
    fsInfo: (dir) => Effect.sync(() => host.fs.get(dir)),
    mtime: (path) => Effect.sync(() => host.mtimes.get(path)),
    nvidiaSmi: Effect.sync(() => {
      host.smiReads++;
      return host.smi;
    }),
  };
  return { host, probe };
};

type Host = ReturnType<typeof makeHost>["host"];

/** Монитор на фейковом хосте и TestClock. */
const run = (
  body: (h: {
    readonly host: Host;
    readonly monitor: WorkerMonitorShape;
    readonly tick: (duration: Duration.Input) => Effect.Effect<void>;
  }) => Effect.Effect<void, unknown>,
  setup: (host: Host) => void = () => {},
) => {
  const { host, probe } = makeHost();
  setup(host);
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      WorkerMonitor.layer.pipe(
        Layer.provide(
          Layer.succeed(AgentConfig, testConfig({ agentCommit: "abc1234" })),
        ),
      ),
    );
    const monitor = Context.get(context, WorkerMonitor);
    const tick = (duration: Duration.Input) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(duration);
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      });
    yield* tick("0 seconds");
    yield* body({ host, monitor, tick });
  }).pipe(
    Effect.scoped,
    Effect.provide(TestClock.layer()),
    Effect.provideService(HostProbe, probe),
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.runPromise,
  );
};

const statsOf = (reports: ReadonlyArray<AgentReport>) =>
  reports.map((report) => {
    if (report._tag !== "WorkerStats")
      throw new Error(`unexpected report ${report._tag}`);
    return report.stats;
  });

describe("WorkerMonitor", () => {
  it("hardware: CPU, память, GPU и диски brofrong", () =>
    run(({ monitor }) =>
      Effect.gen(function* () {
        const { hardware } = yield* monitor.snapshot;
        if (hardware === undefined) throw new Error("hardware is undefined");
        expect(hardware.cpuModel).toBe("AMD Ryzen 5 2600X Six-Core Processor");
        expect(hardware.cpuCores).toBe(6);
        expect(hardware.cpuThreads).toBe(12);
        expect(hardware.memoryBytes).toBe(32795732 * 1024);
        expect(hardware.gpus).toEqual([
          { name: "NVIDIA GeForce GTX 1650 SUPER", memoryBytes: 4096 * MiB },
        ]);
        // loop0 — не физический диск.
        expect(hardware.disks.map((d) => d.name)).toEqual([
          "md127",
          "nvme0n1",
          "sda",
          "sdb",
          "sdc",
          "sdd",
        ]);
        const byName = new Map(hardware.disks.map((d) => [d.name, d]));
        expect(byName.get("nvme0n1")).toEqual({
          name: "nvme0n1",
          kind: "nvme",
          sizeBytes: 488397168 * 512,
          raidLevel: null,
          members: [],
        });
        expect(byName.get("md127")).toEqual({
          name: "md127",
          kind: "raid",
          sizeBytes: 15625000000 * 512,
          raidLevel: "raid5",
          members: ["sda", "sdb", "sdd"],
        });
        expect(byName.get("sda")).toEqual({
          name: "sda",
          kind: "hdd",
          sizeBytes: 1953525168 * 512,
          raidLevel: null,
          members: [],
        });
        expect(byName.get("sdc")?.kind).toBe("ssd");
      }),
    ));

  it("versions: коммит агента, образ сессии, драйвер, сборка клиента Steam", () =>
    run(({ monitor }) =>
      Effect.gen(function* () {
        expect((yield* monitor.snapshot).versions).toEqual({
          agentCommit: "abc1234",
          sessionImage: "cg-session:550.163.01",
          driver: "550.163.01",
          steamClientBuiltAt: "2026-10-27T23:11:00.000Z",
        });
      }),
    ));

  it("каталог клиента Steam недоступен — steamClientBuiltAt null", () =>
    run(
      ({ monitor }) =>
        Effect.gen(function* () {
          expect((yield* monitor.snapshot).versions?.steamClientBuiltAt).toBeNull();
        }),
      (host) => host.mtimes.clear(),
    ));

  it("nvidia-smi недоступен — нет GPU, драйвер null, в снимке gpus пуст", () =>
    run(
      ({ monitor, tick }) =>
        Effect.gen(function* () {
          const { hardware, versions } = yield* monitor.snapshot;
          expect(hardware?.gpus).toEqual([]);
          expect(versions?.driver).toBeNull();
          yield* tick(STATS_INTERVAL);
          const [stats] = statsOf(yield* Queue.clear(monitor.reports));
          expect(stats?.gpus).toEqual([]);
        }),
      (host) => {
        host.smi = undefined;
      },
    ));

  it("nvidia-smi зовётся один раз на snapshot (не по разу на hardware и versions)", () =>
    run(({ host, monitor }) =>
      Effect.gen(function* () {
        const before = host.smiReads;
        yield* monitor.snapshot;
        expect(host.smiReads - before).toBe(1);
      }),
    ));

  it("плейсхолдеры nvidia-smi (не [N/A]) — null на своём месте, снимок схемно валиден", () =>
    run(
      ({ monitor, tick }) =>
        Effect.gen(function* () {
          const { hardware } = yield* monitor.snapshot;
          // memoryTotalBytes null → в hardware.gpus.memoryBytes это 0 (не nullable там).
          expect(hardware?.gpus).toEqual([{ name: "Tesla T4", memoryBytes: 0 }]);
          yield* tick(STATS_INTERVAL);
          const [stats] = statsOf(yield* Queue.clear(monitor.reports));
          expect(stats?.gpus).toEqual([
            {
              utilPercent: 0,
              encoderPercent: 0,
              temperatureC: 40,
              memoryUsedBytes: null,
              memoryTotalBytes: null,
            },
          ]);
        }),
      (host) => {
        host.smi =
          "Tesla T4, [Not Supported], [Not Supported], 0, 0, 40, 550.1\n";
      },
    ));

  it("схемно невалидный снимок WorkerStats не кладётся в очередь", () =>
    run(
      ({ monitor, tick }) =>
        Effect.gen(function* () {
          yield* tick(STATS_INTERVAL);
          expect(yield* Queue.clear(monitor.reports)).toEqual([]);
        }),
      (host) => {
        // Отрицательный usedBytes ФС (statfs отдал что-то странное) — вне
        // хост-разборщиков агента, но WorkerStats.filesystems его не пропустит.
        host.fs.set("/scratch", {
          dev: 2049,
          totalBytes: 400 * GiB,
          usedBytes: -1,
          freeBytes: 280 * GiB,
        });
      },
    ));

  it("первый снимок — через STATS_INTERVAL, по двум замерам CPU", () =>
    run(({ monitor, tick }) =>
      Effect.gen(function* () {
        expect(yield* Queue.clear(monitor.reports)).toEqual([]);
        yield* tick(Duration.subtract(STATS_INTERVAL, Duration.millis(1)));
        expect(yield* Queue.clear(monitor.reports)).toEqual([]);
        yield* tick(Duration.millis(1));
        const all = statsOf(yield* Queue.clear(monitor.reports));
        expect(all).toHaveLength(1);
        expect(all[0]).toEqual({
          // cpu  100 0 100 800 → cpu  150 0 150 900: Δtotal 200, Δidle 100.
          cpuPercent: 50,
          memory: {
            totalBytes: 32795732 * 1024,
            usedBytes:
              (32795732 - 2586332 - (512984 + 20599344 + 1000000)) * 1024,
            cacheBytes: (512984 + 20599344 + 1000000) * 1024,
          },
          gpus: [
            {
              utilPercent: 7,
              encoderPercent: 3,
              temperatureC: 40,
              memoryUsedBytes: 4 * MiB,
              memoryTotalBytes: 4096 * MiB,
            },
          ],
          // scratch и клиент Steam на одной ФС, библиотека — на другой.
          filesystems: [
            {
              purposes: ["scratch", "steamClient"],
              totalBytes: 400 * GiB,
              usedBytes: 100 * GiB,
              freeBytes: 280 * GiB,
            },
            {
              purposes: ["library"],
              totalBytes: 7000 * GiB,
              usedBytes: 1000 * GiB,
              freeBytes: 6000 * GiB,
            },
          ],
          uptimeSeconds: 1005,
        });
      }),
    ));

  it("недоступный каталог пропускается в filesystems", () =>
    run(
      ({ monitor, tick }) =>
        Effect.gen(function* () {
          yield* tick(STATS_INTERVAL);
          const [stats] = statsOf(yield* Queue.clear(monitor.reports));
          expect(stats?.filesystems.map((fs) => fs.purposes)).toEqual([
            ["scratch"],
            ["library"],
          ]);
        }),
      (host) => {
        host.fs.delete("/raid/cloud-gaming/steam-client");
      },
    ));

  it("очередь отчётов скользящая: после трёх интервалов — только последний снимок", () =>
    run(({ monitor, tick }) =>
      Effect.gen(function* () {
        yield* tick(Duration.times(STATS_INTERVAL, 3));
        const all = statsOf(yield* Queue.clear(monitor.reports));
        expect(all).toHaveLength(1);
        // Третий замер: cpu  250 0 250 900 → cpu  250 0 250 1100 — простой.
        expect(all[0]?.cpuPercent).toBe(0);
        expect(all[0]?.uptimeSeconds).toBe(1015);
      }),
    ));
});

describe("defaultHostProbe", () => {
  it("читает файлы, каталоги, ФС и mtime; ошибки — undefined/пусто", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-host-probe-"));
    try {
      await Bun.write(join(dir, "b.txt"), "hello\n");
      await Bun.write(join(dir, "a.txt"), "");
      const probe = defaultHostProbe;
      const result = await Effect.runPromise(
        Effect.all({
          text: probe.readText(join(dir, "b.txt")),
          missingText: probe.readText(join(dir, "nope")),
          list: probe.listDir(dir),
          missingList: probe.listDir(join(dir, "nope")),
          fs: probe.fsInfo(dir),
          missingFs: probe.fsInfo(join(dir, "nope")),
          mtime: probe.mtime(join(dir, "b.txt")),
          missingMtime: probe.mtime(join(dir, "nope")),
        }),
      );
      expect(result.text).toBe("hello\n");
      expect(result.missingText).toBeUndefined();
      expect(result.list).toEqual(["a.txt", "b.txt"]);
      expect(result.missingList).toEqual([]);
      expect(result.fs?.dev).toBe((await stat(dir)).dev);
      expect(result.fs?.totalBytes).toBeGreaterThan(0);
      expect(result.fs?.freeBytes).toBeGreaterThan(0);
      expect(result.fs?.usedBytes).toBeGreaterThanOrEqual(0);
      expect(result.missingFs).toBeUndefined();
      expect(result.mtime).toEqual((await stat(join(dir, "b.txt"))).mtime);
      expect(result.missingMtime).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
