// WorkerMonitor: железо, версии и текущая загрузка воркера для админки (спека
// 2026-10-28). Железо и версии снимаются при каждом подключении к оркестратору
// (`AgentConnect`), загрузка — фоновым циклом раз в STATS_INTERVAL отчётом
// `WorkerStats`. Агент работает в контейнере, но `/proc/{stat,meminfo,cpuinfo,
// uptime}` и `/sys/block` там показывают хост; каталоги SCRATCH_DIR,
// STEAM_CLIENT_DIR и LIBRARY_DIR смонтированы по тем же путям, что на хосте.
// С ролью gamestore снимок несёт и список игр общей библиотеки (`library`); с
// заданным GAMES_DIR — список пакетов своих игр (`ownGames`).
import { readdir, readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentReport,
  WorkerHardware,
  WorkerStats,
  WorkerVersions,
} from "@cg/rpc";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
} from "effect";
import { AgentConfig } from "./config";
import { scanLibrary } from "./GameRemoval";
import { scanOwnGames } from "./OwnGames";
import {
  classifyBlockDevice,
  NVIDIA_SMI_ARGS,
  NVIDIA_SMI_PROCESSES_ARGS,
  parseCpuInfo,
  parseCpuTimes,
  parseMeminfo,
  parseNvidiaSmi,
  cpuPercent as percentBetween,
} from "./hostProbe";

/** Период снимка загрузки (оркестратор считает воркер онлайн по его свежести). */
export const STATS_INTERVAL = Duration.seconds(5);

/** Сколько ждать `nvidia-smi` (завис драйвер — снимок без GPU, а не без всего). */
export const NVIDIA_SMI_TIMEOUT = Duration.seconds(5);

/** Размер и заполненность ФС каталога; `dev` — устройство (`stat().dev`) для группировки. */
export type FsInfo = {
  readonly dev: number;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
};

/**
 * Доступ к хосту для монитора. Ничего не падает: недоступный файл/каталог,
 * сбой `statfs` или `nvidia-smi` — `undefined` (список — пустой), снимок
 * просто покажет «нет данных».
 */
export interface HostProbeShape {
  readonly readText: (path: string) => Effect.Effect<string | undefined>;
  /** Имена в каталоге по алфавиту. */
  readonly listDir: (path: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly fsInfo: (dir: string) => Effect.Effect<FsInfo | undefined>;
  readonly mtime: (path: string) => Effect.Effect<Date | undefined>;
  /** Вывод `nvidia-smi` с {@link NVIDIA_SMI_ARGS}. */
  readonly nvidiaSmi: Effect.Effect<string | undefined>;
  /** XML `nvidia-smi` с {@link NVIDIA_SMI_PROCESSES_ARGS} (замеры сессий). */
  readonly nvidiaSmiProcesses: Effect.Effect<string | undefined>;
}

/** Промис хоста; отказ — `undefined`. */
const attempt = <A>(
  promise: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A | undefined> =>
  Effect.tryPromise({ try: promise, catch: () => undefined }).pipe(
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Вывод `nvidia-smi args`; нет бинаря — `Bun.spawn` бросает, ненулевой код —
 * `undefined`; по таймауту прерывание снимает `signal`, и Bun убивает процесс.
 */
const runNvidiaSmi = (args: ReadonlyArray<string>) =>
  attempt(async (signal) => {
    const proc = Bun.spawn(["nvidia-smi", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      signal,
    });
    const [text, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return code === 0 ? text : undefined;
  }).pipe(
    Effect.timeout(NVIDIA_SMI_TIMEOUT),
    Effect.orElseSucceed(() => undefined),
  );

/** Реальный хост: `node:fs` и `nvidia-smi` из PATH. */
export const defaultHostProbe: HostProbeShape = {
  readText: (path) => attempt(() => readFile(path, "utf8")),
  listDir: (path) =>
    attempt(() => readdir(path)).pipe(
      Effect.map((names) => (names ?? []).sort()),
    ),
  fsInfo: (dir) =>
    attempt(async () => {
      const [{ dev }, fs] = await Promise.all([stat(dir), statfs(dir)]);
      return {
        dev,
        totalBytes: fs.blocks * fs.bsize,
        usedBytes: (fs.blocks - fs.bfree) * fs.bsize,
        freeBytes: fs.bavail * fs.bsize,
      };
    }),
  mtime: (path) => attempt(async () => (await stat(path)).mtime),
  nvidiaSmi: runNvidiaSmi(NVIDIA_SMI_ARGS),
  nvidiaSmiProcesses: runNvidiaSmi(NVIDIA_SMI_PROCESSES_ARGS),
};

/** Как смотреть на хост (по умолчанию — реальный; тесты подменяют). */
export const HostProbe = Context.Reference<HostProbeShape>(
  "@cg/agent/HostProbe",
  { defaultValue: () => defaultHostProbe },
);

export interface WorkerMonitorShape {
  /**
   * Железо и версии воркера одним снимком (один вызов `nvidia-smi` на двоих —
   * раньше `hardware` и `versions` звали его отдельно, т.е. дважды на каждое
   * подключение). Схемно невалидный результат (неразборчивое значение с хоста
   * проскочило разборщики) — `undefined` с предупреждением в лог: агент
   * подключается без этого поля, а не падает (AgentConnect их не требует).
   */
  readonly snapshot: Effect.Effect<{
    readonly hardware: WorkerHardware | undefined;
    readonly versions: WorkerVersions | undefined;
  }>;
  /** `WorkerStats` раз в STATS_INTERVAL; хранится только последний (скользящая очередь на 1). */
  readonly reports: Queue.Dequeue<AgentReport>;
}

/** Первое число файла (`/sys/block/*\/size`, `/proc/uptime`); нет — 0. */
const firstNumber = (text: string | undefined) =>
  Number.parseFloat(text?.trim().split(/\s+/)[0] ?? "") || 0;

/**
 * Значение по схеме — как есть, иначе `undefined` с `logWarning` (не падаем:
 * разборщики хоста уже стараются не пускать NaN/отрицательные байты дальше,
 * но лишняя проверка перед кодированием в RPC дешевле отвалившегося
 * соединения агента).
 */
const validOrWarn = <A>(
  schema: Schema.Schema<A>,
  value: A,
  what: string,
): Effect.Effect<A | undefined> =>
  Schema.is(schema)(value)
    ? Effect.succeed(value)
    : Effect.logWarning(`Invalid ${what} snapshot, omitting`, { value }).pipe(
        Effect.as(undefined),
      );

const make = Effect.gen(function* () {
  const config = yield* AgentConfig;
  const probe = yield* HostProbe;

  const smi = probe.nvidiaSmi.pipe(
    Effect.map((csv) => parseNvidiaSmi(csv ?? "")),
  );

  /** Физические диски и RAID из `/sys/block` (виртуальные отбрасывает classifyBlockDevice). */
  const disks = Effect.gen(function* () {
    const result: Array<WorkerHardware["disks"][number]> = [];
    for (const name of yield* probe.listDir("/sys/block")) {
      const base = `/sys/block/${name}`;
      const level = (yield* probe.readText(`${base}/md/level`))?.trim();
      const disk = classifyBlockDevice(name, {
        sizeSectors: firstNumber(yield* probe.readText(`${base}/size`)),
        rotational:
          (yield* probe.readText(`${base}/queue/rotational`))?.trim() === "1"
            ? 1
            : 0,
        mdLevel: level === undefined || level === "" ? null : level,
        slaves: yield* probe.listDir(`${base}/md/slaves`),
      });
      if (disk !== undefined) result.push(disk);
    }
    return result;
  });

  // Железо и версии вместе — один вызов nvidia-smi (`smi` читается один раз)
  // на оба, а не по разу на каждый.
  const snapshot = Effect.gen(function* () {
    const cpu = parseCpuInfo((yield* probe.readText("/proc/cpuinfo")) ?? "");
    const memory = parseMeminfo((yield* probe.readText("/proc/meminfo")) ?? "");
    const gpus = yield* smi;
    const hardwareResult = {
      cpuModel: cpu.model,
      cpuCores: cpu.cores,
      cpuThreads: cpu.threads,
      memoryBytes: memory.totalBytes,
      gpus: gpus.map((gpu) => ({
        name: gpu.name,
        memoryBytes: gpu.memoryTotalBytes ?? 0,
      })),
      disks: yield* disks,
    } satisfies WorkerHardware;

    const builtAt = yield* probe.mtime(config.steamClientDir);
    const versionsResult = {
      agentCommit: config.agentCommit,
      sessionImage: config.sessionImage,
      driver: gpus[0]?.driver ?? null,
      steamClientBuiltAt: builtAt?.toISOString() ?? null,
    } satisfies WorkerVersions;

    return {
      hardware: yield* validOrWarn(
        WorkerHardware,
        hardwareResult,
        "worker hardware",
      ),
      versions: yield* validOrWarn(
        WorkerVersions,
        versionsResult,
        "worker versions",
      ),
    };
  });

  /** Каталоги агента по ФС: одна ФС — один элемент; недоступный каталог пропускается. */
  const filesystems = Effect.gen(function* () {
    const byDev = new Map<number, WorkerStats["filesystems"][number]>();
    const dirs = [
      ["scratch", config.scratchDir],
      ["steamClient", config.steamClientDir],
      ["library", config.libraryDir],
    ] as const;
    for (const [purpose, dir] of dirs) {
      const info = yield* probe.fsInfo(dir);
      if (info === undefined) continue;
      const known = byDev.get(info.dev);
      if (known !== undefined) {
        byDev.set(info.dev, {
          ...known,
          purposes: [...known.purposes, purpose],
        });
        continue;
      }
      byDev.set(info.dev, {
        purposes: [purpose],
        totalBytes: info.totalBytes,
        usedBytes: info.usedBytes,
        freeBytes: info.freeBytes,
      });
    }
    return [...byDev.values()];
  });

  const readCpuTimes = probe
    .readText("/proc/stat")
    .pipe(Effect.map((text) => parseCpuTimes(text ?? "")));

  // Загрузка CPU — разность двух замеров, поэтому первый замер сейчас, а
  // первый снимок — через STATS_INTERVAL.
  let previous = yield* readCpuTimes;
  const sample = Effect.gen(function* () {
    const current = yield* readCpuTimes;
    const cpu = percentBetween(previous, current);
    previous = current;
    // Отдельная переменная (не `config.gamesDir` по месту) — иначе
    // `Option.isSome` ниже не сузит тип внутри замыкания `Effect.sync`.
    const gamesDir = config.gamesDir;
    const stats: WorkerStats = {
      cpuPercent: cpu,
      memory: parseMeminfo((yield* probe.readText("/proc/meminfo")) ?? ""),
      gpus: (yield* smi).map((gpu) => ({
        utilPercent: gpu.utilPercent,
        encoderPercent: gpu.encoderPercent,
        temperatureC: gpu.temperatureC,
        memoryUsedBytes: gpu.memoryUsedBytes,
        memoryTotalBytes: gpu.memoryTotalBytes,
      })),
      filesystems: yield* filesystems,
      uptimeSeconds: Math.floor(
        firstNumber(yield* probe.readText("/proc/uptime")),
      ),
      // Библиотека — только у gamestore (её манифесты читаются с диска, а не
      // через HostProbe: тот же разборщик, что у удаления игр).
      ...(config.roles.includes("gamestore")
        ? {
            library: yield* Effect.sync(() =>
              scanLibrary(join(config.libraryDir, "steamapps")),
            ),
          }
        : {}),
      // Пакеты своих игр — только у worker с заданным GAMES_DIR (планировщик
      // сравнивает их со `StartSession.ownGame`; без GAMES_DIR агент своих
      // игр не умеет, поля нет вовсе, не пустой список).
      ...(config.roles.includes("worker") && Option.isSome(gamesDir)
        ? {
            ownGames: yield* Effect.sync(() => scanOwnGames(gamesDir.value)),
          }
        : {}),
    };
    return stats;
  });

  // Старый снимок бесполезен: у монитора лежит только последний, пока его не
  // забрал OrchestratorLink.
  const reports = yield* Queue.sliding<AgentReport>(1);
  yield* Effect.sleep(STATS_INTERVAL).pipe(
    Effect.andThen(sample),
    Effect.flatMap((stats) =>
      // Схемно невалидный снимок (NaN/отрицательные байты просочились мимо
      // разборщиков) не кладём в очередь — иначе AgentConnect/agent.report
      // закодировал бы его и оборвал бы соединение; просто ждём следующий.
      Schema.is(WorkerStats)(stats)
        ? Queue.offer(reports, { _tag: "WorkerStats", stats })
        : Effect.logWarning("Invalid worker stats snapshot, dropping", {
            stats,
          }),
    ),
    // Сбой одного снимка не останавливает цикл.
    Effect.catchCause((cause) =>
      Effect.logWarning("Worker stats sample failed", { cause }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  return { snapshot, reports } satisfies WorkerMonitorShape;
});

export class WorkerMonitor extends Context.Service<
  WorkerMonitor,
  WorkerMonitorShape
>()("@cg/agent/WorkerMonitor") {
  /** Первый замер CPU при старте, дальше — снимок раз в STATS_INTERVAL. */
  static readonly layer: Layer.Layer<WorkerMonitor, never, AgentConfig> =
    Layer.effect(WorkerMonitor, make);
}
