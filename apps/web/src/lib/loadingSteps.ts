// Экран загрузки до появления игры (спека 2026-10-27-loading-screen §2, §4.4): список
// этапов, общая полоска и когда экран показывать. Этапы приходят от агента
// (`SessionView.stage`/`installStage`), сайт их не угадывает — по времени только
// ползёт полоска внутри текущего этапа. Время этапов, их нормы и когда предложить
// «Показать экран» — по серверным отметкам `SessionView.timing` (спека
// 2026-10-29-launch-timers, часть 2).
import {
  type InstallStage,
  isOwnAppId,
  type SessionStage,
  type SessionState,
  type SessionTiming,
  type SessionView,
  type StageTiming,
} from "@cg/rpc";
import { formatClock } from "./formatTime";
import { queueLine } from "./queueText";

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
 * Ориентировочные длительности этапов, мс (замеры 2026-10-27: запуск — 20 Minutes
 * Till Dawn, установка — Peglin и Balatro). Для полоски внутри этапа (она ползёт к
 * концу этапа, но не доходит до следующего) и норма этапа, пока сервер своей не
 * набрал (`stageNormMs`).
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
  install: { preparing: 5_000, login: 45_000, library: 45_000, moving: 15_000 },
};

/** Потолок доли внутри этапа: полоска не доходит до следующего этапа, пока он не начался. */
const STAGE_CAP = 0.95;

/** Подписи этапов запуска по порядку (их же показывает админка в столбце «Этап»). */
export const launchSteps: ReadonlyArray<readonly [LaunchStage, string]> = [
  ["computer", "Готовим компьютер"],
  ["steam", "Запускаем Steam"],
  ["login", "Входим в аккаунт"],
  ["prepare", "Готовим игру"],
  ["loading", "Загружаем игру"],
];

/**
 * Этапы запуска своей игры (спека 2026-11-03 «Бесплатные игры» §4.3): Steam нет —
 * агент шлёт только `computer`, `loading` и `visible`.
 */
export const ownLaunchSteps: ReadonlyArray<readonly [LaunchStage, string]> = [
  ["computer", "Готовим компьютер"],
  ["loading", "Запускаем игру"],
];

/** Этапы запуска этой сессии: у своей игры — `ownLaunchSteps`. */
const launchStepsOf = (view: SessionView) =>
  isOwnAppId(view.appId) ? ownLaunchSteps : launchSteps;

/** Подписи этапов установки по порядку (переиспользует и админка — столбец «Этап»). */
export const installSteps: ReadonlyArray<readonly [InstallStage, string]> = [
  ["preparing", "Готовим установщик"],
  ["login", "Входим в Steam"],
  ["library", "Steam готовит загрузку"],
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
 * Строки списка, индекс текущей, доля внутри текущей — `fraction(msInStage,
 * nowServerMs)` — и `bounds`: где на общей полоске начинается и кончается каждая
 * строка.
 * - `queued` — «Ждём свободный сервер», дальше этапы запуска (после установки
 *   перед ними «Игра установлена»);
 * - `installing` — только этапы установки (с этапами запуска список вышел бы
 *   в девять строк), на полоске — `[0, INSTALL_SHARE]`;
 * - дальше — этапы запуска, а после установки перед ними одна строка
 *   «Игра установлена» на месте этапов установки.
 */
function plan(view: SessionView): {
  labels: ReadonlyArray<string>;
  /** Этап каждой строки (у «Ждём свободный сервер» и «Игра установлена» — null). */
  stages: ReadonlyArray<Timed | null>;
  current: number;
  fraction: (msInStage: number, nowServerMs?: number) => number;
  bounds: ReadonlyArray<number>;
} {
  const creep = (ms: number, stageMs: number) =>
    1 - Math.exp(-Math.max(0, ms) / stageMs);
  // Есть отметка этапа и «сейчас» сервера — по ним и норме этапа (как у таймера
  // этапа: перезагрузка страницы полоску не обнуляет); нет — сколько этап видит
  // клиент, по `STAGE_MS`.
  const timed =
    (stage: Timed, stageMs: number) =>
    (msInStage: number, nowServerMs?: number) => {
      const timing = view.timing;
      if (timing === null || nowServerMs === undefined) {
        return creep(msInStage, stageMs);
      }
      const mark = markOf(timing, stage);
      if (!mark) return creep(msInStage, stageMs);
      return creep(
        msIn(mark, nowServerMs),
        stageNormMs(timing, stage.kind, stage.stage) ?? stageMs,
      );
    };
  const steps = launchStepsOf(view);
  const launchLabels = steps.map(([, label]) => label);
  const launchStages = steps.map(([stage]): Timed => ({
    kind: "launch",
    stage,
  }));
  // После установки — строка «Игра установлена» на её отрезке полоски.
  const prefix = view.hadInstall ? ["Игра установлена"] : [];
  const prefixStages = view.hadInstall ? [null] : [];
  const from = view.hadInstall ? INSTALL_SHARE : 0;
  const prefixBounds = view.hadInstall ? [0] : [];

  if (view.state === "queued") {
    // Сколько ждать сервер, не знаем — внутри очереди полоска стоит в начале
    // строки (после установки сессия ждёт сервер ещё раз — на `INSTALL_SHARE`).
    // Место в очереди приходит не сразу (снимок планировщика) — до него строка
    // прежняя.
    const queueLabel =
      view.queue === null ? "Ждём свободный сервер" : queueLine(view.queue);
    return {
      labels: [...prefix, queueLabel, ...launchLabels],
      // В очереди времени этапов не показываем.
      stages: [],
      current: prefix.length,
      fraction: () => 0,
      bounds: [
        ...prefixBounds,
        ...evenBounds(launchLabels.length + 1, from, 1),
      ],
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
      stages: installSteps.map(([stage]): Timed => ({
        kind: "install",
        stage,
      })),
      current: installSteps.findIndex(([key]) => key === stage),
      fraction:
        stage === "downloading"
          ? () => percent / 100
          : timed({ kind: "install", stage }, STAGE_MS.install[stage]),
      bounds: evenBounds(installSteps.length, 0, INSTALL_SHARE),
    };
  }

  const bounds = [...prefixBounds, ...evenBounds(launchLabels.length, from, 1)];
  const stage = view.stage ?? "computer";
  if (stage === "visible") {
    return {
      labels: [...prefix, ...launchLabels],
      stages: [...prefixStages, ...launchStages],
      current: prefix.length + launchLabels.length,
      fraction: () => 0,
      bounds,
    };
  }
  return {
    labels: [...prefix, ...launchLabels],
    stages: [...prefixStages, ...launchStages],
    current: prefix.length + steps.findIndex(([key]) => key === stage),
    fraction: timed({ kind: "launch", stage }, STAGE_MS.launch[stage]),
    bounds,
  };
}

/**
 * Строки экрана загрузки: сделанные, текущая, будущие. С `nowServerMs` («сейчас»
 * сервера) и `view.timing` — со временем: у сделанной — сколько заняла
 * («Готовим компьютер · 0:08»), у текущей — норма и сколько идёт («Запускаем
 * Steam · обычно ~30 с · 0:12»; у скачивания вместо нормы процент). Этап без
 * отметки (агент его пропустил, ещё не пришёл) — без времени.
 */
export function loadingSteps(
  view: SessionView,
  nowServerMs?: number,
): ReadonlyArray<LoadingStep> {
  const { labels, stages, current } = plan(view);
  const timing = nowServerMs === undefined ? null : view.timing;
  return labels.map((label, i) => {
    const status = i < current ? "done" : i === current ? "now" : "next";
    const stage = stages[i];
    if (timing === null || nowServerMs === undefined || !stage) {
      return { label, status };
    }
    const mark = markOf(timing, stage);
    if (status === "done") {
      return mark?.endedAt
        ? {
            label: `${label} · ${formatElapsed(Date.parse(mark.endedAt) - Date.parse(mark.startedAt))}`,
            status,
          }
        : { label, status };
    }
    if (status === "next") return { label, status };
    const norm = stageNormMs(timing, stage.kind, stage.stage);
    const parts = [
      label,
      ...(norm === null ? [] : [`обычно ${formatNorm(norm)}`]),
      ...(mark ? [formatElapsed(msIn(mark, nowServerMs))] : []),
    ];
    return { label: parts.join(" · "), status };
  });
}

/**
 * Общий таймер над списком: «Запуск идёт 1:05 · обычно ~1:40» — от первой отметки
 * запуска; норма — `launchNormMs`, без неё — сумма норм этапов. В установке —
 * «Установка идёт 2:10» без нормы. В очереди, без `timing` или без отметок — null.
 */
export function loadingTotal(
  view: SessionView,
  nowServerMs: number,
): string | null {
  const timing = view.timing;
  if (timing === null || view.state === "queued") return null;
  if (view.state === "installing") {
    const first = timing.install[0];
    return first
      ? `Установка идёт ${formatElapsed(nowServerMs - Date.parse(first.startedAt))}`
      : null;
  }
  const first = timing.launch[0];
  if (!first) return null;
  const norm =
    timing.launchNormMs ??
    launchStepsOf(view).reduce(
      (sum, [stage]) => sum + (stageNormMs(timing, "launch", stage) ?? 0),
      0,
    );
  return `Запуск идёт ${formatElapsed(nowServerMs - Date.parse(first.startedAt))} · обычно ${formatNorm(norm)}`;
}

/** Этап запуска или установки (у них есть общий `login`, но нормы у каждого свои). */
type Timed =
  | { readonly kind: "launch"; readonly stage: LaunchStage }
  | { readonly kind: "install"; readonly stage: InstallStage };

/** Отметка этапа в `timing` (последняя, если этап отмечен не раз). */
const markOf = (
  timing: SessionTiming,
  { kind, stage }: Timed,
): StageTiming | undefined =>
  timing[kind].findLast((mark) => mark.stage === stage);

/** Сколько мс этап шёл (законченный) или идёт к `nowServerMs`. */
const msIn = (mark: StageTiming, nowServerMs: number) =>
  (mark.endedAt === null ? nowServerMs : Date.parse(mark.endedAt)) -
  Date.parse(mark.startedAt);

/**
 * Норма этапа, мс: с сервера (`normMs`), иначе ориентировочная `STAGE_MS`; у
 * скачивания нормы нет (там процент) — null.
 */
export function stageNormMs(
  timing: SessionTiming,
  kind: "launch" | "install",
  stage: LaunchStage | InstallStage,
): number | null {
  const server = timing[kind].findLast((mark) => mark.stage === stage)?.normMs;
  if (server !== null && server !== undefined) return server;
  if (kind === "launch") {
    return STAGE_MS.launch[stage as LaunchStage] ?? null;
  }
  return stage === "downloading"
    ? null
    : (STAGE_MS.install[stage as TimedInstallStage] ?? null);
}

/** Норма: «~30 с» до минуты, дальше «~1:40»; округление до 5 с, не меньше 5 с. */
export function formatNorm(ms: number): string {
  const seconds = Math.max(5, Math.round(ms / 5_000) * 5);
  return seconds < 60 ? `~${seconds} с` : `~${formatClock(seconds)}`;
}

/** Прошедшее время: «0:12», «1:05» (отрицательное — «0:00»). */
export function formatElapsed(ms: number): string {
  return formatClock(Math.max(0, ms) / 1000);
}

/** Сколько норм текущего этапа нужно пройти, чтобы предложить «Показать экран». */
const REVEAL_FACTOR = 2;

/**
 * Текущий этап запуска идёт дольше `REVEAL_FACTOR` своих норм (по серверным
 * отметкам). Без `timing`, без этапа или без его отметки — нет.
 */
export function stageOverdue(view: SessionView, nowServerMs: number): boolean {
  const timing = view.timing;
  const stage = view.stage;
  if (timing === null || stage === null || stage === "visible") return false;
  const mark = markOf(timing, { kind: "launch", stage });
  const norm = stageNormMs(timing, "launch", stage);
  return (
    mark !== undefined &&
    mark.endedAt === null &&
    norm !== null &&
    msIn(mark, nowServerMs) > REVEAL_FACTOR * norm
  );
}

/**
 * Пора ли предложить «Показать экран» (без «залипания» — его держит `Player`):
 * только при готовом стриме; на «Входим в аккаунт» — сразу (окно входа Steam с
 * QR); иначе — когда текущий этап идёт дольше 2× нормы. Без `timing` (старый
 * api) или без отметки текущего этапа мерить нечем — сразу, как было до норм:
 * игрок не должен застрять без выхода к окну на сервере.
 */
export function revealDue(view: SessionView, nowServerMs: number): boolean {
  if (!view.streamReady) return false;
  if (view.stage === "login") return true;
  const timing = view.timing;
  if (timing === null || view.stage === null || view.stage === "visible") {
    return true;
  }
  if (!markOf(timing, { kind: "launch", stage: view.stage })) return true;
  return stageOverdue(view, nowServerMs);
}

/**
 * Общая полоска, 0..1: начало текущей строки плюс доля её отрезка, не больше
 * `STAGE_CAP`. Внутри этапа по времени: есть отметка этапа в `view.timing` и
 * `nowServerMs` — `1 − exp(−(nowServerMs − startedAt) / stageNormMs)`, без
 * отметки — `1 − exp(−msInStage / STAGE_MS)`; скачивание — по `installPercent`.
 */
export function loadingProgress(
  view: SessionView,
  msInStage: number,
  nowServerMs?: number,
): number {
  const { labels, current, fraction, bounds } = plan(view);
  if (current >= labels.length) return 1;
  const from = bounds[current] ?? 0;
  const to = bounds[current + 1] ?? 1;
  const inStage = Math.min(
    STAGE_CAP,
    Math.max(0, fraction(msInStage, nowServerMs)),
  );
  return from + (to - from) * inStage;
}

/** Состояния, где трансляции ещё нет вовсе: экран загрузки — единственное, что показать. */
const noStream: ReadonlySet<SessionState> = new Set(["queued", "installing"]);

/** Этапы, когда процесс игры уже есть, а окна ещё нет: экран загрузки и в `playing`. */
const gameStarting: ReadonlySet<SessionStage> = new Set(["prepare", "loading"]);

/**
 * Показывать ли экран загрузки. `revealed` — игрок нажал «Показать экран»: тогда
 * трансляция, кроме `queued`/`installing`, где её нет. `playing` — пока игра не
 * видна (`prepare`/`loading`); `stage === null` — старая сессия или агент
 * без этапов: сразу трансляция, как раньше. Этап раньше `prepare` при уже
 * запущенной игре — источник этапов сломан (в образе нет скрипта): тоже трансляция.
 */
export function showsLoading(view: SessionView, revealed: boolean): boolean {
  if (noStream.has(view.state)) return true;
  if (revealed) return false;
  if (view.state === "starting") return true;
  return (
    view.state === "playing" &&
    view.stage !== null &&
    gameStarting.has(view.stage)
  );
}
