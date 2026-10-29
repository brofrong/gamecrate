// Чистые разборщики данных хоста для снимков железа/версий/загрузки воркера
// (админка, спека 2026-10-28): `/proc/stat`, `/proc/meminfo`, `/proc/cpuinfo`,
// вывод `nvidia-smi` и атрибуты `/sys/block/*`. Сами файлы читает и опрашивает
// вызывающий код (WorkerMonitor, Task 2) — здесь только разбор строк в схемы.
import type { WorkerHardware, WorkerStats } from "@cg/rpc";

/** Аргументы `nvidia-smi` для {@link parseNvidiaSmi}: одна строка CSV на GPU. */
export const NVIDIA_SMI_ARGS = [
  "--query-gpu=name,memory.total,memory.used,utilization.gpu,utilization.encoder,temperature.gpu,driver_version",
  "--format=csv,noheader,nounits",
];

/**
 * Аргументы `nvidia-smi` для {@link parseGpuProcesses}: процессы на GPU в XML.
 * В отличие от `--query-compute-apps` (только `C`/`C+G`) здесь видны и чисто
 * графические (`G`: Xwayland, labwc, часть игр) — «Итоги Task 1» плана.
 */
export const NVIDIA_SMI_PROCESSES_ARGS = ["-q", "-x", "-d", "PIDS"];

/** Снимок счётчиков CPU для {@link cpuPercent}: сумма всех полей и «простой» (idle + iowait). */
export type CpuTimes = { readonly idle: number; readonly total: number };

/**
 * Поля агрегатной строки `cpu  ...` из `/proc/stat` (не `cpu0`/`cpu1` —
 * у них после имени нет второго пробела). Порядок полей: user nice system
 * idle iowait irq softirq steal guest guest_nice; `idle` здесь — idle + iowait,
 * как считает `free`/`top`. Строки нет — нулевой снимок (на первый вызов,
 * если `/proc/stat` временно недоступен).
 */
export const parseCpuTimes = (procStat: string): CpuTimes => {
  const line = procStat.split("\n").find((l) => l.startsWith("cpu "));
  if (line === undefined) return { idle: 0, total: 0 };
  const fields = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((value) => Number(value) || 0);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, value) => sum + value, 0);
  return { idle, total };
};

/**
 * Загрузка CPU между двумя снимками `parseCpuTimes`: `100 * (1 - Δidle/Δtotal)`,
 * округление до целого. `Δtotal = 0` (повтор того же снимка или сбой чтения) —
 * 0, а не `NaN`/деление на ноль.
 */
export const cpuPercent = (prev: CpuTimes, next: CpuTimes): number => {
  const deltaTotal = next.total - prev.total;
  if (deltaTotal <= 0) return 0;
  const deltaIdle = next.idle - prev.idle;
  return Math.round(100 * (1 - deltaIdle / deltaTotal));
};

/** Значение поля `/proc/meminfo` в кБ по имени; нет строки — 0. */
const meminfoField = (lines: ReadonlyArray<string>, key: string): number => {
  const line = lines.find((l) => l.startsWith(`${key}:`));
  if (line === undefined) return 0;
  const match = /(\d+)/.exec(line.slice(key.length + 1));
  return match === null ? 0 : Number(match[1]);
};

/**
 * Память из `/proc/meminfo`, как считает `free`: `cache` = `Buffers` + `Cached`
 * + `SReclaimable`, `used` = `MemTotal` − `MemFree` − `cache` (кБ переводятся
 * в байты × 1024). Поля `/proc/meminfo` не всегда согласованы (например,
 * `SReclaimable` временно больше реального кэша) — формула может уйти в
 * минус; тогда берём `MemTotal` − `MemFree` без вычета кэша, а если и это
 * отрицательно — 0 (схема RPC не пропускает отрицательные байты, см.
 * WorkerMonitor.ts).
 */
export const parseMeminfo = (text: string): WorkerStats["memory"] => {
  const lines = text.split("\n");
  const totalKb = meminfoField(lines, "MemTotal");
  const freeKb = meminfoField(lines, "MemFree");
  const cacheKb =
    meminfoField(lines, "Buffers") +
    meminfoField(lines, "Cached") +
    meminfoField(lines, "SReclaimable");
  const usedKb = totalKb - freeKb - cacheKb;
  const safeUsedKb = usedKb >= 0 ? usedKb : Math.max(totalKb - freeKb, 0);
  return {
    totalBytes: totalKb * 1024,
    usedBytes: safeUsedKb * 1024,
    cacheBytes: cacheKb * 1024,
  };
};

/**
 * Модель и число ядер/потоков CPU из `/proc/cpuinfo`: `threads` — число строк
 * `processor` (одна на логическое ядро), `cores` — поле `cpu cores` первой
 * записи; поля нет (виртуалка, некоторые ARM) — `cores = threads`. `model` —
 * `model name` первой записи.
 */
export const parseCpuInfo = (
  text: string,
): { model: string; cores: number; threads: number } => {
  let model = "";
  let cores: number | undefined;
  let threads = 0;
  let modelSeen = false;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "processor") threads++;
    else if (key === "model name" && !modelSeen) {
      model = value;
      modelSeen = true;
    } else if (key === "cpu cores" && cores === undefined) cores = Number(value);
  }
  return { model, cores: cores ?? threads, threads };
};

/** МиБ в байты (`nvidia-smi` отдаёт память в МиБ). */
const MiB = 2 ** 20;

/** Поле строки `nvidia-smi --format=csv,noheader,nounits`: `[N/A]`/пусто → `null`. */
const smiField = (raw: string | undefined): string | null => {
  const value = raw?.trim() ?? "";
  return value === "" || value === "[N/A]" ? null : value;
};

/**
 * Числовое поле `nvidia-smi`: `[N/A]`/пусто — `null` (см. {@link smiField}), а
 * любое другое неразборчивое значение (`[Not Supported]`, `[Unknown Error]`,
 * `[Insufficient Permissions]` и т.п. placeholder'ы драйвера) — тоже `null`, а
 * не `NaN`: `NaN` не проходит схему RPC (`NonNegativeNumber`), и некорректный
 * снимок уронил бы соединение агента (см. WorkerMonitor.ts).
 */
const smiNumber = (raw: string | undefined): number | null => {
  const value = smiField(raw);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Разбор вывода `nvidia-smi` с аргументами {@link NVIDIA_SMI_ARGS}: одна строка
 * CSV на GPU, память — в МиБ (переводится в байты). `[N/A]`/пустое поле — на
 * этом же месте `null` (GPU без энкодера, не поддерживаемый счётчик и т.п.).
 * Пустой вывод (нет GPU или `nvidia-smi` не поставлен) — пустой массив.
 */
export const parseNvidiaSmi = (
  csv: string,
): Array<{
  name: string;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  utilPercent: number | null;
  encoderPercent: number | null;
  temperatureC: number | null;
  driver: string | null;
}> =>
  csv
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [name, memTotal, memUsed, util, encoder, temp, driver] =
        line.split(",");
      const memTotalMib = smiNumber(memTotal);
      const memUsedMib = smiNumber(memUsed);
      return {
        name: name?.trim() ?? "",
        memoryTotalBytes: memTotalMib === null ? null : memTotalMib * MiB,
        memoryUsedBytes: memUsedMib === null ? null : memUsedMib * MiB,
        utilPercent: smiNumber(util),
        encoderPercent: smiNumber(encoder),
        temperatureC: smiNumber(temp),
        driver: smiField(driver),
      };
    });

/** Текст первого `<tag>…</tag>` в `xml` (без вложенных тегов); нет — `undefined`. */
const xmlField = (xml: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1]?.trim();

/**
 * Процессы на GPU из вывода `nvidia-smi` с {@link NVIDIA_SMI_PROCESSES_ARGS}:
 * все `<process_info>` всех карт, любого типа (`C`, `G`, `C+G`). `pid` — PID
 * в пространстве хоста (так отдаёт NVML и в контейнере агента), `usedBytes` —
 * `<used_memory>` (`1885 MiB`) в байтах; `N/A` и прочее неразборчивое — `null`.
 * Запись без числового PID пропускается; пустой вывод или нет процессов — `[]`.
 */
export const parseGpuProcesses = (
  xml: string,
): ReadonlyArray<{ pid: number; usedBytes: number | null }> => {
  const result: Array<{ pid: number; usedBytes: number | null }> = [];
  for (const [, body = ""] of xml.matchAll(
    /<process_info>([\s\S]*?)<\/process_info>/g,
  )) {
    const pid = Number(xmlField(body, "pid"));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const used = /^(\d+(?:\.\d+)?)\s*MiB$/.exec(
      xmlField(body, "used_memory") ?? "",
    );
    result.push({
      pid,
      usedBytes: used === null ? null : Number(used[1]) * MiB,
    });
  }
  return result;
};

/** Атрибуты блочного устройства из `/sys/block/<name>/*`, которые нужны {@link classifyBlockDevice}. */
export type BlockDeviceInfo = {
  readonly rotational: 0 | 1;
  readonly sizeSectors: number;
  readonly mdLevel: string | null;
  readonly slaves: ReadonlyArray<string>;
};

/** Служебные/виртуальные устройства, которые не показываем как физические диски. */
const virtualDevice = /^(loop|ram|zram|dm-|sr)/;

/**
 * Диск или RAID-массив блока «Железо» по атрибутам из `/sys/block/<name>`.
 * `loop*`/`ram*`/`zram*`/`dm-*`/`sr*` и нулевой размер — `undefined` (не
 * физический диск или не подключён); `nvme*` → `nvme`, `md*` → `raid`
 * (уровень — `md/level`, члены — имена из `md/slaves/`), иначе `rotational`
 * решает hdd/ssd. Размер — секторы × 512 (размер сектора `/sys/block` всегда
 * сообщает в 512-байтных единицах, даже для устройств с другим физическим блоком).
 */
export const classifyBlockDevice = (
  name: string,
  info: BlockDeviceInfo,
): WorkerHardware["disks"][number] | undefined => {
  if (info.sizeSectors === 0) return undefined;
  if (virtualDevice.test(name)) return undefined;
  const sizeBytes = info.sizeSectors * 512;
  if (name.startsWith("nvme"))
    return { name, kind: "nvme", sizeBytes, raidLevel: null, members: [] };
  if (name.startsWith("md"))
    return {
      name,
      kind: "raid",
      sizeBytes,
      raidLevel: info.mdLevel,
      members: [...info.slaves],
    };
  return {
    name,
    kind: info.rotational === 1 ? "hdd" : "ssd",
    sizeBytes,
    raidLevel: null,
    members: [],
  };
};
