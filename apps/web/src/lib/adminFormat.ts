// Подписи админки (`/admin`, вкладки «Воркеры», «Сессии» и «Установки»): объёмы,
// «сколько назад», длительности, диски, назначения ФС, роли воркера, этап сессии и
// этап/прогресс установки. Чистая логика, без React и без обращений к сети.
import type {
  AdminInstall,
  AgentRoles,
  InstallStage,
  SessionStage,
  SessionState,
  WorkerHardware,
  WorkerStats,
} from "@cg/rpc";
import { installSteps, launchSteps } from "@/lib/loadingSteps";

type Disk = WorkerHardware["disks"][number];
type Purposes = WorkerStats["filesystems"][number]["purposes"];

const UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"] as const;
/** С этой единицы (ГБ) значения меньше 10 пишем с одной цифрой после запятой. */
const DECIMAL_FROM = 3;

/** Индекс единицы для `n` байт: самая крупная, в которой выходит не меньше 1. */
const unitIndex = (n: number) => {
  let i = 0;
  while (i < UNITS.length - 1 && n >= 1024 ** (i + 1)) i += 1;
  return i;
};

/** Число в единице `i` без подписи: «2,0», «7,3», «233», «317». */
const amount = (n: number, i: number) => {
  const value = n / 1024 ** i;
  return i >= DECIMAL_FROM && value < 10
    ? value.toFixed(1).replace(".", ",")
    : String(Math.round(value));
};

/** «317 МБ», «2,0 ГБ», «233 ГБ», «7,3 ТБ» — по основанию 1024. */
export function formatBytes(n: number): string {
  const i = unitIndex(Math.max(0, n));
  return `${amount(Math.max(0, n), i)} ${UNITS[i]}`;
}

/** Число байт в единице, которую выбрал бы `formatBytes(total)`: «101» для «… из 233 ГБ». */
export function formatAmountLike(n: number, total: number): string {
  return amount(Math.max(0, n), unitIndex(Math.max(0, total)));
}

/** «121 из 233 ГБ», «1,1 из 7,3 ТБ» — обе величины в единице `total`. */
export function formatUsage(used: number, total: number): string {
  const i = unitIndex(Math.max(0, total));
  return `${amount(Math.max(0, used), i)} из ${amount(Math.max(0, total), i)} ${UNITS[i]}`;
}

/** «4 с назад», «12 мин назад», «3 ч назад», «2 дн назад» (отрицательное — как 0). */
export function formatAgo(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} с назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

/** «12 мин», «1 ч 5 мин», «2 ч», «11 дн 17 ч» — сколько идёт сессия или работает сервер. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} дн` : `${days} дн ${rest} ч`;
}

/** «28.10 04:41» — по местному времени (строки «Последних сбоев», дата шаблона Steam). */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const DISK_KINDS: Readonly<Record<Disk["kind"], string>> = {
  nvme: "NVMe",
  ssd: "SSD",
  hdd: "HDD",
  raid: "RAID",
};

/** «NVMe 233 ГБ», «RAID5 (sda, sdb, sdd) 7,3 ТБ», «HDD 3,6 ТБ». */
export function diskLabel(disk: Disk): string {
  const kind =
    disk.kind === "raid" && disk.raidLevel !== null
      ? disk.raidLevel.toUpperCase()
      : DISK_KINDS[disk.kind];
  const members =
    disk.members.length > 0 ? ` (${disk.members.join(", ")})` : "";
  return `${kind}${members} ${formatBytes(disk.sizeBytes)}`;
}

/** Диски без членов RAID: те уже перечислены в скобках у своего массива. */
export function topLevelDisks(disks: ReadonlyArray<Disk>): ReadonlyArray<Disk> {
  const members = new Set(disks.flatMap((disk) => disk.members));
  return disks.filter((disk) => !members.has(disk.name));
}

const PURPOSES: Readonly<Record<Purposes[number], string>> = {
  scratch: "scratch",
  steamClient: "шаблон Steam",
  library: "библиотека игр",
};

/** «scratch и шаблон Steam», «библиотека игр» — что лежит на ФС. */
export function purposeLabel(purposes: Purposes): string {
  const names = purposes.map((purpose) => PURPOSES[purpose]);
  if (names.length === 0) return "диск";
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} и ${names[names.length - 1]}`;
}

/** «сессии + установки» — роли агента воркера. */
export function rolesLabel(roles: AgentRoles): string {
  return roles
    .map((role) => (role === "worker" ? "сессии" : "установки"))
    .join(" + ");
}

const launchLabel = (stage: SessionStage | null) =>
  launchSteps.find(([key]) => key === stage)?.[1];

/**
 * Столбец «Этап»: пока игра запускается — этап как на экране загрузки («Запускаем
 * Steam», «Загружаем игру»), дальше — состояние сессии по-русски.
 */
export function sessionStageLabel(
  state: SessionState,
  stage: SessionStage | null,
): string {
  switch (state) {
    case "queued":
      return "Ждём свободный сервер";
    case "installing":
      return "устанавливается";
    case "starting":
      return launchLabel(stage) ?? "запускается";
    case "playing":
      return launchLabel(stage) ?? "играет";
    case "idle_warning":
      return "нет ввода";
    case "disconnected":
      return "отключился";
    case "stopping":
      return "останавливается";
    case "ended":
      return "завершена";
    case "failed":
      return "сбой";
  }
}

/**
 * Столбец «Этап» вкладки «Установки»: `queued` — «В очереди», иначе подпись этапа
 * установки с экрана загрузки («Готовим установщик», «Скачиваем игру»…); этап ещё
 * не пришёл от агента — «—».
 */
export function installStageLabel(
  state: AdminInstall["state"],
  stage: InstallStage | null,
): string {
  if (state === "queued") return "В очереди";
  return installSteps.find(([key]) => key === stage)?.[1] ?? "—";
}

/** «45 % · 1,2 из 2,0 ГБ» — прогресс закачки; размеры ещё не пришли от Steam — «—». */
export function installProgressLabel(
  bytesDownloaded: number | null,
  bytesTotal: number | null,
): string {
  if (bytesDownloaded === null || bytesTotal === null || bytesTotal <= 0) {
    return "—";
  }
  const percent = Math.round((bytesDownloaded / bytesTotal) * 100);
  return `${percent} % · ${formatUsage(bytesDownloaded, bytesTotal)}`;
}
