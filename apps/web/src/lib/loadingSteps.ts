// Экран загрузки до появления игры (спека 2026-10-27-loading-screen §2, §4.4): список
// этапов, общая полоска и когда экран показывать. Этапы приходят от агента
// (`SessionView.stage`/`installStage`), сайт их не угадывает — по времени только
// ползёт полоска внутри текущего этапа.
import type {
  InstallStage,
  SessionStage,
  SessionState,
  SessionView,
} from "@cg/rpc";

export type StepStatus = "done" | "now" | "next";

export type LoadingStep = {
  readonly label: string;
  readonly status: StepStatus;
};

/** Этапы запуска до появления окна игры (`visible` — уже не этап, а конец экрана). */
type LaunchStage = Exclude<SessionStage, "visible">;

/** Этапы установки, у которых доля полоски — по времени (скачивание — по проценту). */
type TimedInstallStage = Exclude<InstallStage, "downloading">;

/**
 * Ориентировочные длительности этапов, мс (замеры 2026-10-27). Только для полоски
 * внутри этапа: она ползёт к концу этапа, но не доходит до следующего.
 */
export const STAGE_MS: {
  readonly launch: Readonly<Record<LaunchStage, number>>;
  readonly install: Readonly<Record<TimedInstallStage, number>>;
} = {
  launch: {
    computer: 10_000,
    steam: 30_000,
    login: 15_000,
    prepare: 30_000,
    loading: 15_000,
  },
  install: { preparing: 20_000, login: 30_000, moving: 20_000 },
};

/** Потолок доли внутри этапа: полоска не доходит до следующего этапа, пока он не начался. */
const STAGE_CAP = 0.95;

const launchSteps: ReadonlyArray<readonly [LaunchStage, string]> = [
  ["computer", "Готовим компьютер"],
  ["steam", "Запускаем Steam"],
  ["login", "Входим в аккаунт"],
  ["prepare", "Готовим игру"],
  ["loading", "Загружаем игру"],
];

const installSteps: ReadonlyArray<readonly [InstallStage, string]> = [
  ["preparing", "Готовим установщик"],
  ["login", "Входим в Steam"],
  ["downloading", "Скачиваем игру"],
  ["moving", "Переносим игру в библиотеку"],
];

/**
 * Доля общей полоски на установку, если она была. Полоска одна на установку и
 * запуск: пока идёт установка, её строки заполняют `[0, INSTALL_SHARE)`; после
 * неё строка «Игра установлена» занимает тот же отрезок, и запуск продолжает с
 * того места, где кончилась установка, — полоска не отъезжает назад.
 */
const INSTALL_SHARE = 0.5;

/** `n` строк поровну на отрезке `[from, to]`: `n + 1` границ. */
const evenBounds = (n: number, from: number, to: number) =>
  Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);

/**
 * Строки списка, индекс текущей, доля внутри текущей — `fraction(ms)` — и
 * `bounds`: где на общей полоске начинается и кончается каждая строка.
 * - `queued` — «Ждём свободный сервер», дальше этапы запуска;
 * - `installing` — только этапы установки (с этапами запуска список вышел бы
 *   в девять строк), на полоске — `[0, INSTALL_SHARE]`;
 * - дальше — этапы запуска, а после установки перед ними одна строка
 *   «Игра установлена» на месте этапов установки.
 */
function plan(view: SessionView): {
  labels: ReadonlyArray<string>;
  current: number;
  fraction: (msInStage: number) => number;
  bounds: ReadonlyArray<number>;
} {
  const timed = (stageMs: number) => (ms: number) =>
    1 - Math.exp(-Math.max(0, ms) / stageMs);
  const launchLabels = launchSteps.map(([, label]) => label);

  if (view.state === "queued") {
    // Сколько ждать сервер, не знаем — внутри очереди полоска стоит в начале.
    return {
      labels: ["Ждём свободный сервер", ...launchLabels],
      current: 0,
      fraction: () => 0,
      bounds: evenBounds(launchLabels.length + 1, 0, 1),
    };
  }

  if (view.state === "installing") {
    // Этап ещё не пришёл — установщик только создаётся.
    const stage = view.installStage ?? "preparing";
    const percent = view.installPercent ?? 0;
    return {
      labels: installSteps.map(([key, label]) =>
        key === "downloading" && stage === "downloading"
          ? `${label} · ${percent} %`
          : label,
      ),
      current: installSteps.findIndex(([key]) => key === stage),
      fraction:
        stage === "downloading"
          ? () => percent / 100
          : timed(STAGE_MS.install[stage]),
      bounds: evenBounds(installSteps.length, 0, INSTALL_SHARE),
    };
  }

  const prefix = view.hadInstall ? ["Игра установлена"] : [];
  const bounds = view.hadInstall
    ? [0, ...evenBounds(launchLabels.length, INSTALL_SHARE, 1)]
    : evenBounds(launchLabels.length, 0, 1);
  const stage = view.stage ?? "computer";
  if (stage === "visible") {
    return {
      labels: [...prefix, ...launchLabels],
      current: prefix.length + launchLabels.length,
      fraction: () => 0,
      bounds,
    };
  }
  return {
    labels: [...prefix, ...launchLabels],
    current: prefix.length + launchSteps.findIndex(([key]) => key === stage),
    fraction: timed(STAGE_MS.launch[stage]),
    bounds,
  };
}

/** Строки экрана загрузки: сделанные, текущая, будущие. */
export function loadingSteps(view: SessionView): ReadonlyArray<LoadingStep> {
  const { labels, current } = plan(view);
  return labels.map((label, i) => ({
    label,
    status: i < current ? "done" : i === current ? "now" : "next",
  }));
}

/**
 * Общая полоска, 0..1: начало текущей строки плюс доля её отрезка. Внутри этапа
 * по времени — `1 − exp(−msInStage / STAGE_MS)`, не больше `STAGE_CAP`;
 * скачивание — по `installPercent`.
 */
export function loadingProgress(view: SessionView, msInStage: number): number {
  const { labels, current, fraction, bounds } = plan(view);
  if (current >= labels.length) return 1;
  const from = bounds[current] ?? 0;
  const to = bounds[current + 1] ?? 1;
  const inStage = Math.min(STAGE_CAP, Math.max(0, fraction(msInStage)));
  return from + (to - from) * inStage;
}

/** Состояния, где трансляции ещё нет вовсе: экран загрузки — единственное, что показать. */
const noStream: ReadonlySet<SessionState> = new Set(["queued", "installing"]);

/**
 * Показывать ли экран загрузки. `revealed` — игрок нажал «Показать экран»: тогда
 * трансляция, кроме `queued`/`installing`, где её нет. `playing` — пока игра не
 * видна (`stage` не `visible`); `stage === null` — старая сессия или агент
 * без этапов: сразу трансляция, как раньше.
 */
export function showsLoading(view: SessionView, revealed: boolean): boolean {
  if (noStream.has(view.state)) return true;
  if (revealed) return false;
  if (view.state === "starting") return true;
  return (
    view.state === "playing" && view.stage !== null && view.stage !== "visible"
  );
}
