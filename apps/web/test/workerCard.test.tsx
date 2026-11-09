// Карточка воркера в админке (макет `mockup-workers.html`): железо, версии, загрузка,
// слоты с сессиями, выбор класса (спека §5.1) и кнопки — на фикстуре brofrong; без
// снимка/офлайн — «нет данных».
import { describe, expect, it, mock } from "bun:test";
import type { AdminSession, AdminWorker, AdminWorkerClass } from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkerCard } from "../src/components/admin/WorkerCard";

const GiB = 2 ** 30;
const now = Date.parse("2026-10-28T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

const session: AdminSession = {
  id: "s1",
  userId: "u1",
  userName: "Дмитрий",
  appId: 1794680,
  gameName: "Vampire Survivors",
  workerId: "brofrong",
  slot: 0,
  state: "playing",
  stage: "visible",
  createdAt: ago(12 * 60_000),
  endedAt: null,
  lastInputAt: ago(4000),
  failReason: null,
};

const classes: ReadonlyArray<AdminWorkerClass> = [
  { id: "c-fast", name: "Быстрое", rank: 2, workers: 0 },
  { id: "c-standard", name: "Стандарт", rank: 1, workers: 1 },
];

const brofrong: AdminWorker = {
  id: "brofrong",
  publicIp: "37.153.14.138",
  slots: 1,
  roles: ["worker", "gamestore"],
  online: true,
  lastSeenAt: ago(3000),
  draining: false,
  classId: "c-standard",
  regionId: null,
  enrolled: true,
  pendingCode: null,
  hardware: {
    cpuModel: "AMD Ryzen 5 2600X Six-Core Processor",
    cpuCores: 6,
    cpuThreads: 12,
    memoryBytes: 31 * GiB,
    gpus: [{ name: "GeForce GTX 1650 Super", memoryBytes: 4 * GiB }],
    disks: [
      {
        name: "nvme0n1",
        kind: "nvme",
        sizeBytes: 233 * GiB,
        raidLevel: null,
        members: [],
      },
      {
        name: "md127",
        kind: "raid",
        sizeBytes: 15625000000 * 512,
        raidLevel: "raid5",
        members: ["sda", "sdb", "sdd"],
      },
      {
        name: "sda",
        kind: "hdd",
        sizeBytes: 3.6 * 2 ** 40,
        raidLevel: null,
        members: [],
      },
    ],
  },
  versions: {
    agentCommit: "9842cbd",
    sessionImage: "cg-session:550.163.01",
    driver: "550.163.01",
    steamClientBuiltAt: "2026-10-27T02:11:00Z",
  },
  stats: {
    cpuPercent: 38,
    memory: { totalBytes: 31 * GiB, usedBytes: 7 * GiB, cacheBytes: 23 * GiB },
    gpus: [
      {
        utilPercent: 61,
        encoderPercent: 22,
        temperatureC: 67,
        memoryUsedBytes: 2.1 * GiB,
        memoryTotalBytes: 4 * GiB,
      },
    ],
    filesystems: [
      {
        purposes: ["scratch", "steamClient"],
        totalBytes: 233 * GiB,
        usedBytes: 121 * GiB,
        freeBytes: 101 * GiB,
      },
      {
        purposes: ["library"],
        totalBytes: 7.3 * 2 ** 40,
        usedBytes: 1.1 * 2 ** 40,
        freeBytes: 5.8 * 2 ** 40,
      },
    ],
    uptimeSeconds: (11 * 24 + 17) * 3600,
  },
  sessions: [session],
};

const renderCard = (worker: AdminWorker = brofrong) => {
  const onStop = mock((_sessionId: string) => {});
  const onDraining = mock((_draining: boolean) => {});
  const onSetClass = mock((_classId: string | null) => {});
  render(
    <WorkerCard
      worker={worker}
      now={now}
      classes={classes}
      onStop={onStop}
      onDraining={onDraining}
      onSetClass={onSetClass}
    />,
  );
  return { onStop, onDraining, onSetClass };
};

/** Значения строк «Железа» с подписью `label` (`dt` → соседний `dd`). */
const rowValue = (label: string) =>
  screen
    .getAllByText(label, { selector: "dt" })
    .map((node) => node.nextElementSibling?.textContent ?? "");

describe("WorkerCard", () => {
  it("железо, версии, загрузка и слоты brofrong", () => {
    renderCard();
    expect(screen.getByText("brofrong")).toBeTruthy();
    expect(
      screen.getByText(
        "онлайн · сигнал 3 с назад · 37.153.14.138 · сессии + установки",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/AMD Ryzen 5 2600X/)).toBeTruthy();
    expect(screen.getByText(/12 потоков/)).toBeTruthy();
    expect(screen.getByText(/GeForce GTX 1650 Super/)).toBeTruthy();
    // Диски-члены RAID отдельно не показываются — они в скобках у массива.
    expect(rowValue("Диски")).toEqual([
      "NVMe 233 ГБ · RAID5 (sda, sdb, sdd) 7,3 ТБ",
    ]);
    expect(screen.getByText(/агент 9842cbd/)).toBeTruthy();
    expect(screen.getByText("сервер работает 11 дн 17 ч")).toBeTruthy();
    expect(screen.getByText("scratch и шаблон Steam")).toBeTruthy();
    expect(screen.getByText("библиотека игр")).toBeTruthy();
    expect(screen.getByText("121 из 233 ГБ · свободно 101")).toBeTruthy();
    expect(screen.getByText("38 %")).toBeTruthy();
    expect(screen.getByText("Слоты · занят 1 из 1")).toBeTruthy();
    expect(screen.getByText("Дмитрий")).toBeTruthy();
    expect(screen.getByText("Vampire Survivors")).toBeTruthy();
    expect(screen.getByText("играет")).toBeTruthy();
    expect(screen.getByText("12 мин")).toBeTruthy();
    expect(screen.getByText("4 с назад")).toBeTruthy();
    expect(screen.queryByText("нет данных")).toBeNull();
  });

  it("выбор класса зовёт onSetClass, без класса — предупреждение", () => {
    const { onSetClass } = renderCard();
    const select = screen.getByLabelText("Класс воркера") as HTMLSelectElement;
    expect(select.value).toBe("c-standard");
    expect(screen.queryByText("Без класса — сессий не берёт")).toBeNull();

    fireEvent.change(select, { target: { value: "c-fast" } });
    expect(onSetClass).toHaveBeenCalledWith("c-fast");

    renderCard({ ...brofrong, classId: null });
    expect(screen.getByText("Без класса — сессий не берёт")).toBeTruthy();
  });

  it("«Остановить» и «На обслуживание» зовут колбэки", () => {
    const { onStop, onDraining } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Остановить" }));
    expect(onStop).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "На обслуживание" }));
    expect(onDraining).toHaveBeenCalledWith(true);
  });

  it("на обслуживании — бейдж и «Вернуть в работу»", () => {
    const { onDraining } = renderCard({ ...brofrong, draining: true });
    expect(screen.getByText("на обслуживании")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Вернуть в работу" }));
    expect(onDraining).toHaveBeenCalledWith(false);
  });

  it("нет снимка загрузки — «нет данных» вместо полос", () => {
    renderCard({ ...brofrong, stats: null });
    expect(screen.getByText("нет данных")).toBeTruthy();
    expect(screen.queryByText("scratch и шаблон Steam")).toBeNull();
    expect(screen.queryByText("38 %")).toBeNull();
  });

  it("офлайн — «офлайн · сигнал … назад», полосы не показываются", () => {
    renderCard({ ...brofrong, online: false, lastSeenAt: ago(5 * 60_000) });
    expect(
      screen.getByText(
        "офлайн · сигнал 5 мин назад · 37.153.14.138 · сессии + установки",
      ),
    ).toBeTruthy();
    expect(screen.getByText("нет данных")).toBeTruthy();
    expect(screen.queryByText("38 %")).toBeNull();
  });

  it("нет GPU — строка GPU «нет данных»", () => {
    const hardware = brofrong.hardware;
    if (hardware === null) throw new Error("fixture");
    renderCard({ ...brofrong, hardware: { ...hardware, gpus: [] } });
    expect(rowValue("GPU")).toContain("нет данных");
  });

  it("нет снимка железа и версий — «нет данных», карточка не падает", () => {
    renderCard({
      ...brofrong,
      hardware: null,
      versions: null,
      stats: null,
      lastSeenAt: null,
      online: false,
      sessions: [],
    });
    expect(screen.getAllByText("нет данных").length).toBe(3);
    expect(screen.getByText("Слоты · занято 0 из 1")).toBeTruthy();
  });
});
