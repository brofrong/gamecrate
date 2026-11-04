// Экран загрузки до появления игры (спека 2026-10-27-loading-screen §2): этапы
// списком, общая полоска, «Отменить», запасной фон вместо битой картинки; время
// этапов и «Показать экран» при 2× нормы (спека 2026-10-29-launch-timers, часть 2).
import { describe, expect, it, jest, mock, setSystemTime } from "bun:test";
import type {
  InstallStage,
  SessionStage,
  SessionState,
  SessionTiming,
  SessionView,
  StageTiming,
} from "@cg/rpc";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Player } from "../src/components/Player";
import {
  formatElapsed,
  formatNorm,
  loadingProgress,
  loadingSteps,
  revealDue,
  stageNormMs,
} from "../src/lib/loadingSteps";

const view = (state: SessionState, patch: Partial<SessionView> = {}) =>
  ({
    id: "0b5c1a52-7f4e-4f1e-9a43-3c1d2e5f6a7b",
    appId: 1966900,
    gameName: "20 Minutes Till Dawn",
    state,
    streamReady: false,
    failReason: null,
    idleDeadline: null,
    installPercent: null,
    stage: null,
    installStage: null,
    hadInstall: false,
    timing: null,
    playedSeconds: 0,
    createdAt: "2026-10-27T10:00:00.000Z",
    ...patch,
  }) satisfies SessionView;

const noop = () => {};

const renderPlayer = (v: SessionView, onExit: () => void = noop) =>
  render(
    <Player
      view={v}
      onExit={onExit}
      onHere={noop}
      onLibrary={noop}
      onPlayAgain={noop}
    />,
  );

const launch = [
  "Готовим компьютер",
  "Запускаем Steam",
  "Входим в аккаунт",
  "Готовим игру",
  "Загружаем игру",
];

describe("loading screen", () => {
  it("steps for a launch at prepare", () => {
    expect(loadingSteps(view("starting", { stage: "prepare" }))).toEqual([
      { label: "Готовим компьютер", status: "done" },
      { label: "Запускаем Steam", status: "done" },
      { label: "Входим в аккаунт", status: "done" },
      { label: "Готовим игру", status: "now" },
      { label: "Загружаем игру", status: "next" },
    ]);
    // `playing` до появления окна — те же этапы.
    expect(loadingSteps(view("playing", { stage: "loading" })).at(-1)).toEqual({
      label: "Загружаем игру",
      status: "now",
    });
    // Этап ещё не пришёл — первый.
    expect(loadingSteps(view("starting"))[0]).toEqual({
      label: "Готовим компьютер",
      status: "now",
    });
  });

  it("queued shows Ждём свободный сервер as the current step", () => {
    expect(loadingSteps(view("queued"))).toEqual([
      { label: "Ждём свободный сервер", status: "now" },
      ...launch.map((label) => ({ label, status: "next" as const })),
    ]);
    renderPlayer(view("queued"));
    expect(screen.getByText("Ждём свободный сервер")).toBeTruthy();
    expect(screen.getByText("20 Minutes Till Dawn")).toBeTruthy();
  });

  it("install steps show the percent and collapse to Игра установлена after install", () => {
    const installing = view("installing", {
      installStage: "downloading",
      installPercent: 42,
      hadInstall: true,
    });
    expect(loadingSteps(installing)).toEqual([
      { label: "Готовим установщик", status: "done" },
      { label: "Входим в Steam", status: "done" },
      { label: "Steam готовит загрузку", status: "done" },
      { label: "Скачиваем игру · 42 %", status: "now" },
      { label: "Переносим игру в библиотеку", status: "next" },
    ]);
    renderPlayer(installing);
    expect(screen.getByText("Скачиваем игру · 42 %")).toBeTruthy();
    expect(
      screen.getByText("Время установки не входит в игровое"),
    ).toBeTruthy();

    expect(
      loadingSteps(view("starting", { stage: "steam", hadInstall: true })),
    ).toEqual([
      { label: "Игра установлена", status: "done" },
      { label: "Готовим компьютер", status: "done" },
      { label: "Запускаем Steam", status: "now" },
      { label: "Входим в аккаунт", status: "next" },
      { label: "Готовим игру", status: "next" },
      { label: "Загружаем игру", status: "next" },
    ]);
  });

  it("progress never reaches the next stage before it starts", () => {
    const forever = 10 ** 9;
    const launchStages: ReadonlyArray<SessionStage> = [
      "computer",
      "steam",
      "login",
      "prepare",
      "loading",
    ];
    for (const hadInstall of [false, true]) {
      for (const [i, stage] of launchStages.entries()) {
        const late = loadingProgress(
          view("starting", { stage, hadInstall }),
          forever,
        );
        const next = launchStages[i + 1];
        const bound =
          next === undefined
            ? 1
            : loadingProgress(view("playing", { stage: next, hadInstall }), 0);
        expect(late).toBeLessThan(bound);
        expect(late).toBeGreaterThan(
          loadingProgress(view("starting", { stage, hadInstall }), 0),
        );
      }
    }

    const installStages: ReadonlyArray<InstallStage> = [
      "preparing",
      "login",
      "library",
      "downloading",
      "moving",
    ];
    for (const [i, installStage] of installStages.entries()) {
      const late = loadingProgress(
        view("installing", { installStage, installPercent: 100 }),
        forever,
      );
      const next = installStages[i + 1];
      const bound =
        next === undefined
          ? 1
          : loadingProgress(
              view("installing", { installStage: next, installPercent: 0 }),
              0,
            );
      expect(late).toBeLessThan(bound);
    }

    // Скачивание — по проценту, а не по времени.
    const at = (installPercent: number) =>
      loadingProgress(
        view("installing", { installStage: "downloading", installPercent }),
        0,
      );
    expect(at(42)).toBeGreaterThan(at(10));
    expect(at(10)).toBeGreaterThan(at(0));
  });

  it("library: Steam prepares the download, the bar creeps without a percent", () => {
    const library = view("installing", {
      installStage: "library",
      installPercent: 0,
    });
    expect(loadingSteps(library)).toEqual([
      { label: "Готовим установщик", status: "done" },
      { label: "Входим в Steam", status: "done" },
      { label: "Steam готовит загрузку", status: "now" },
      { label: "Скачиваем игру", status: "next" },
      { label: "Переносим игру в библиотеку", status: "next" },
    ]);
    // Внутри этапа — по времени: через 30 с заметно дальше начала.
    expect(loadingProgress(library, 30_000)).toBeGreaterThan(
      loadingProgress(library, 0) + 0.02,
    );
  });

  it("one bar across install and launch: it does not slide back after install", () => {
    const forever = 10 ** 9;
    const moving = loadingProgress(
      view("installing", { installStage: "moving", hadInstall: true }),
      forever,
    );
    const launched = loadingProgress(
      view("starting", { stage: "computer", hadInstall: true }),
      0,
    );
    expect(moving).toBeLessThanOrEqual(launched);
    // Весь путь по порядку — полоска не убывает ни на одном переходе.
    const path: ReadonlyArray<SessionView> = [
      view("queued"),
      view("installing", { hadInstall: true }),
      view("installing", { installStage: "login", hadInstall: true }),
      view("installing", { installStage: "library", hadInstall: true }),
      view("installing", {
        installStage: "downloading",
        installPercent: 100,
        hadInstall: true,
      }),
      view("installing", { installStage: "moving", hadInstall: true }),
      // После установки сессия ненадолго снова в очереди, пока её не назначат.
      view("queued", { hadInstall: true }),
      view("starting", { stage: "computer", hadInstall: true }),
      view("starting", { stage: "login", hadInstall: true }),
      view("playing", { stage: "loading", hadInstall: true }),
    ];
    for (const [i, v] of path.entries()) {
      const next = path[i + 1];
      if (next === undefined) break;
      expect(loadingProgress(v, forever)).toBeLessThanOrEqual(
        loadingProgress(next, 0),
      );
    }
    // В очереди после установки «Игра установлена» остаётся.
    expect(loadingSteps(view("queued", { hadInstall: true }))).toEqual([
      { label: "Игра установлена", status: "done" },
      { label: "Ждём свободный сервер", status: "now" },
      ...launch.map((label) => ({ label, status: "next" as const })),
    ]);
  });

  it("cancel asks for confirmation before calling onExit", async () => {
    for (const [v, title] of [
      [view("queued"), "Отменить запуск игры?"],
      [view("installing", { installStage: "login" }), "Отменить установку?"],
      [
        view("starting", { stage: "login", streamReady: true }),
        "Отменить запуск игры?",
      ],
      [
        view("playing", { stage: "loading", streamReady: true }),
        "Отменить запуск игры?",
      ],
    ] as const) {
      const onExit = mock(() => {});
      const r = renderPlayer(v, onExit);
      fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
      expect(await screen.findByText(title)).toBeTruthy();
      expect(onExit).not.toHaveBeenCalled();
      // «Ждать дальше» — экран загрузки остаётся, сессия идёт.
      fireEvent.click(screen.getByRole("button", { name: "Ждать дальше" }));
      expect(onExit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Да, отменить" }),
      );
      expect(onExit).toHaveBeenCalledTimes(1);
      r.unmount();
    }
  });

  it("cover falls back to the brand background when the image fails", () => {
    const { container } = renderPlayer(view("starting", { stage: "steam" }));
    const cover = () =>
      container.querySelector(
        'img[src="https://cdn.cloudflare.steamstatic.com/steam/apps/1966900/library_600x900.jpg"]',
      );
    const backdrop = () =>
      container.querySelector(
        'img[src="https://cdn.cloudflare.steamstatic.com/steam/apps/1966900/library_hero.jpg"]',
      );
    expect(cover()).not.toBeNull();
    expect(backdrop()).not.toBeNull();

    fireEvent.error(cover() as Element);
    fireEvent.error(backdrop() as Element);
    // Битых картинок нет — остаётся тёмный фон бренда, название и этапы на месте.
    expect(cover()).toBeNull();
    expect(backdrop()).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("20 Minutes Till Dawn")).toBeTruthy();
    expect(screen.getByText("Запускаем Steam")).toBeTruthy();
  });
});

/** «Сейчас» сервера в тестах времени. */
const T = Date.parse("2026-10-29T10:00:00.000Z");
/** ISO момента `ms` от `T` (обычно в прошлом: `at(-12_300)`). */
const at = (ms: number) => new Date(T + ms).toISOString();

const mark = (
  stage: string,
  from: number,
  to: number | null,
  normMs: number | null = null,
): StageTiming => ({
  stage,
  startedAt: at(from),
  endedAt: to === null ? null : at(to),
  normMs,
});

const timing = (patch: Partial<SessionTiming> = {}): SessionTiming => ({
  serverNow: at(0),
  launch: [],
  install: [],
  launchNormMs: null,
  ...patch,
});

/** Запуск на «Запускаем Steam»: компьютер готовили 8 с, Steam идёт `steamMs`. */
const atSteam = (steamMs: number, patch: Partial<SessionView> = {}) =>
  view("starting", {
    stage: "steam",
    timing: timing({
      launch: [
        mark("computer", -steamMs - 8_000, -steamMs),
        mark("steam", -steamMs, null),
      ],
    }),
    ...patch,
  });

const reveal = () => screen.queryByRole("button", { name: "Показать экран" });
const slowHint = "Дольше обычного — загляните на экран";
const qrHint =
  "Если появилось окно входа Steam — отсканируйте QR-код в мобильном приложении Steam";

/** Рендер на поддельных часах: браузер считает «сейчас» = `T + skewMs`. */
const withClock = (skewMs: number, run: () => void) => {
  jest.useFakeTimers();
  setSystemTime(new Date(T + skewMs));
  try {
    run();
  } finally {
    jest.useRealTimers();
    setSystemTime();
  }
};

describe("loading screen timers", () => {
  it("formats norms rounded to 5 s and elapsed as m:ss", () => {
    expect(formatNorm(29_999)).toBe("~30 с");
    expect(formatNorm(12_400)).toBe("~10 с");
    expect(formatNorm(100_000)).toBe("~1:40");
    expect(formatNorm(57_600)).toBe("~1:00");
    // Не «~0 с»: норма хотя бы 5 с.
    expect(formatNorm(0)).toBe("~5 с");
    expect(formatElapsed(12_300)).toBe("0:12");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(-3_000)).toBe("0:00");
  });

  it("stage norm: the server's, else the built-in estimate", () => {
    const t = timing({
      launch: [
        mark("computer", -20_000, -5_000, 12_000),
        mark("steam", -5_000, null),
      ],
      install: [mark("login", -50_000, null, 40_000)],
    });
    expect(stageNormMs(t, "launch", "computer")).toBe(12_000);
    // Нормы с сервера нет — ориентировочная `STAGE_MS`.
    expect(stageNormMs(t, "launch", "steam")).toBe(30_000);
    expect(stageNormMs(t, "launch", "login")).toBe(15_000);
    // `login` есть и у запуска, и у установки — нормы у них свои.
    expect(stageNormMs(t, "install", "login")).toBe(40_000);
    expect(stageNormMs(timing(), "install", "login")).toBe(45_000);
    // У скачивания нормы нет — там процент.
    expect(stageNormMs(t, "install", "downloading")).toBeNull();
  });

  it("steps show done durations and the current stage's norm and elapsed", () => {
    expect(loadingSteps(atSteam(12_300), T)).toEqual([
      { label: "Готовим компьютер · 0:08", status: "done" },
      { label: "Запускаем Steam · обычно ~30 с · 0:12", status: "now" },
      { label: "Входим в аккаунт", status: "next" },
      { label: "Готовим игру", status: "next" },
      { label: "Загружаем игру", status: "next" },
    ]);
    // Норма с сервера.
    const prepare = view("playing", {
      stage: "prepare",
      timing: timing({ launch: [mark("prepare", -5_000, null, 98_000)] }),
    });
    expect(loadingSteps(prepare, T)[3]).toEqual({
      label: "Готовим игру · обычно ~1:40 · 0:05",
      status: "now",
    });
    // Пропущенный агентом этап — без времени.
    expect(loadingSteps(prepare, T)[0]).toEqual({
      label: "Готовим компьютер",
      status: "done",
    });
  });

  it("bar inside a marked stage follows the server time, not the client's msInStage", () => {
    const steam = atSteam(12_300);
    // Клиент видит этап 0 мс (перезагрузил страницу) или минуту — полоска та же:
    // от `startedAt` отметки до «сейчас» сервера.
    expect(loadingProgress(steam, 0, T)).toBe(
      loadingProgress(steam, 60_000, T),
    );
    expect(loadingProgress(steam, 0, T)).toBeGreaterThan(
      loadingProgress(steam, 0),
    );
    // Этап идёт дольше — полоска дальше, при том же `msInStage`.
    expect(loadingProgress(atSteam(25_000), 0, T)).toBeGreaterThan(
      loadingProgress(steam, 0, T),
    );
    // Норма этапа с сервера: при норме вдвое больше — доля меньше.
    const slowNorm = view("starting", {
      stage: "steam",
      timing: timing({ launch: [mark("steam", -12_300, null, 60_000)] }),
    });
    expect(loadingProgress(slowNorm, 0, T)).toBeLessThan(
      loadingProgress(steam, 0, T),
    );
    // Установка — тоже по отметке, по норме установки.
    const library = view("installing", {
      installStage: "library",
      timing: timing({ install: [mark("library", -30_000, null)] }),
    });
    expect(loadingProgress(library, 0, T)).toBe(
      loadingProgress(library, 30_000),
    );
  });

  it("bar without the stage's mark creeps by msInStage as before", () => {
    const unmarked = view("starting", {
      stage: "steam",
      timing: timing({ launch: [mark("computer", -20_000, -10_000)] }),
    });
    expect(loadingProgress(unmarked, 12_300, T)).toBe(
      loadingProgress(unmarked, 12_300),
    );
    expect(loadingProgress(unmarked, 30_000, T)).toBeGreaterThan(
      loadingProgress(unmarked, 0, T),
    );
    // Без `timing` вовсе — так же.
    const old = view("starting", { stage: "steam" });
    expect(loadingProgress(old, 12_300, T)).toBe(loadingProgress(old, 12_300));
    // Скачивание — по проценту, отметка его не меняет.
    const downloading = view("installing", {
      installStage: "downloading",
      installPercent: 40,
      timing: timing({ install: [mark("downloading", -90_000, null)] }),
    });
    expect(loadingProgress(downloading, 0, T)).toBe(
      loadingProgress(downloading, 0),
    );
  });

  it("header: launch total with its norm, install total without one", () =>
    withClock(0, () => {
      const launchView = view("starting", {
        stage: "login",
        timing: timing({
          launch: [
            mark("computer", -65_000, -57_000),
            mark("steam", -57_000, -3_000),
            mark("login", -3_000, null),
          ],
        }),
      });
      // Нормы всего запуска с сервера нет — сумма норм этапов (10+30+15+30+15 с).
      const r = renderPlayer(launchView);
      expect(screen.getByText("Запуск идёт 1:05 · обычно ~1:40")).toBeTruthy();
      expect(screen.getByText("Готовим компьютер · 0:08")).toBeTruthy();
      expect(screen.getByText("Запускаем Steam · 0:54")).toBeTruthy();
      expect(
        screen.getByText("Входим в аккаунт · обычно ~15 с · 0:03"),
      ).toBeTruthy();
      r.unmount();

      const withNorm = renderPlayer(
        view("starting", {
          stage: "computer",
          timing: timing({
            launch: [mark("computer", -4_000, null)],
            launchNormMs: 93_000,
          }),
        }),
      );
      expect(screen.getByText("Запуск идёт 0:04 · обычно ~1:35")).toBeTruthy();
      withNorm.unmount();

      const installing = view("installing", {
        installStage: "downloading",
        installPercent: 42,
        hadInstall: true,
        timing: timing({
          install: [
            mark("preparing", -130_000, -120_000),
            mark("login", -120_000, -100_000),
            mark("library", -100_000, -72_000),
            mark("downloading", -72_000, null),
          ],
        }),
      });
      renderPlayer(installing);
      expect(screen.getByText("Установка идёт 2:10")).toBeTruthy();
      expect(screen.getByText("Скачиваем игру · 42 % · 1:12")).toBeTruthy();
      expect(screen.getByText("Готовим установщик · 0:10")).toBeTruthy();
      expect(screen.queryByText(/обычно/)).toBeNull();
    }));

  it("show screen appears only past twice the stage norm, with a hint", () =>
    withClock(0, () => {
      // «Запускаем Steam» (норма 30 с) идёт 57 с — 1,9×: кнопки нет.
      const { rerender } = renderPlayer(atSteam(57_000, { streamReady: true }));
      expect(reveal()).toBeNull();
      expect(screen.queryByText(slowHint)).toBeNull();
      // Ещё 6 с — 2,1×: кнопка и подсказка.
      act(() => jest.advanceTimersByTime(6_000));
      expect(reveal()).toBeTruthy();
      expect(screen.getByText(slowHint)).toBeTruthy();
      expect(
        screen.getByText("Запускаем Steam · обычно ~30 с · 1:03"),
      ).toBeTruthy();

      // Этап сменился, норма нового ещё не превышена — кнопка остаётся, подсказки нет.
      rerender(
        <Player
          view={view("playing", {
            stage: "prepare",
            streamReady: true,
            timing: timing({
              serverNow: at(6_000),
              launch: [
                mark("steam", -63_000, 6_000),
                mark("prepare", 6_000, null),
              ],
            }),
          })}
          onExit={noop}
          onHere={noop}
          onLibrary={noop}
          onPlayAgain={noop}
        />,
      );
      expect(
        screen.getByText("Готовим игру · обычно ~30 с · 0:00"),
      ).toBeTruthy();
      expect(reveal()).toBeTruthy();
      expect(screen.queryByText(slowHint)).toBeNull();
    }));

  it("no show screen without a stream, even past twice the norm", () =>
    withClock(0, () => {
      renderPlayer(atSteam(90_000));
      expect(reveal()).toBeNull();
      expect(revealDue(atSteam(90_000), T)).toBe(false);
      expect(revealDue(atSteam(90_000, { streamReady: true }), T)).toBe(true);
      expect(revealDue(atSteam(57_000, { streamReady: true }), T)).toBe(false);
    }));

  it("login shows the button and the QR hint right away", () =>
    withClock(0, () => {
      renderPlayer(
        view("starting", {
          stage: "login",
          streamReady: true,
          timing: timing({ launch: [mark("login", -1_000, null)] }),
        }),
      );
      expect(reveal()).toBeTruthy();
      expect(screen.getByText(qrHint)).toBeTruthy();
      expect(screen.queryByText(slowHint)).toBeNull();
    }));

  it("the browser clock does not change the times (serverNow)", () =>
    withClock(120_000, () => {
      renderPlayer(atSteam(12_300, { streamReady: true }));
      expect(
        screen.getByText("Запускаем Steam · обычно ~30 с · 0:12"),
      ).toBeTruthy();
      expect(screen.getByText("Запуск идёт 0:20 · обычно ~1:40")).toBeTruthy();
      // Часы браузера на 2 минуты впереди — но 2× по серверу не превышено.
      expect(reveal()).toBeNull();
      act(() => jest.advanceTimersByTime(2_000));
      expect(
        screen.getByText("Запускаем Steam · обычно ~30 с · 0:14"),
      ).toBeTruthy();
    }));

  it("without timing the screen looks as before: no times, button with a stream", () =>
    withClock(0, () => {
      renderPlayer(view("starting", { stage: "steam", streamReady: true }));
      expect(screen.getByText("Запускаем Steam")).toBeTruthy();
      expect(screen.queryByText(/Запуск идёт/)).toBeNull();
      expect(screen.queryByText(/обычно/)).toBeNull();
      expect(reveal()).toBeTruthy();
    }));

  it("queued has no timers", () =>
    withClock(0, () => {
      renderPlayer(
        view("queued", {
          timing: timing({ launch: [] }),
        }),
      );
      expect(screen.getByText("Ждём свободный сервер")).toBeTruthy();
      expect(screen.queryByText(/идёт/)).toBeNull();
      expect(screen.queryByText(/обычно/)).toBeNull();
    }));
});

describe("own game loading screen", () => {
  const own = (state: SessionState, patch: Partial<SessionView> = {}) =>
    view(state, {
      appId: 1900000001,
      gameName: "The Legend of Zelda: Ocarina of Time",
      ...patch,
    });

  it("own game loading screen has two steps and no Steam QR hint", () => {
    expect(loadingSteps(own("starting", { stage: "computer" }))).toEqual([
      { label: "Готовим компьютер", status: "now" },
      { label: "Запускаем игру", status: "next" },
    ]);
    expect(loadingSteps(own("playing", { stage: "loading" }))).toEqual([
      { label: "Готовим компьютер", status: "done" },
      { label: "Запускаем игру", status: "now" },
    ]);
    expect(loadingSteps(own("queued"))).toEqual([
      { label: "Ждём свободный сервер", status: "now" },
      { label: "Готовим компьютер", status: "next" },
      { label: "Запускаем игру", status: "next" },
    ]);
    // Полоска: «Запускаем игру» — вторая половина.
    expect(
      loadingProgress(own("playing", { stage: "loading" }), 0),
    ).toBeCloseTo(0.5);

    // Без `timing` у Steam-игры в `starting` подсказка про QR есть всегда — у своей нет.
    renderPlayer(own("starting", { stage: "computer", streamReady: true }));
    expect(screen.getByText("Готовим компьютер")).toBeTruthy();
    expect(screen.getByText("Запускаем игру")).toBeTruthy();
    expect(screen.queryByText(/Steam/)).toBeNull();
    expect(screen.queryByText(qrHint)).toBeNull();
    expect(reveal()).toBeTruthy();
  });

  it("own game: header total sums only its two stage norms", () =>
    withClock(0, () => {
      renderPlayer(
        own("starting", {
          stage: "loading",
          timing: timing({
            launch: [
              mark("computer", -12_000, -4_000),
              mark("loading", -4_000, null),
            ],
          }),
        }),
      );
      // 10 + 15 с, а не сумма всех этапов Steam-запуска.
      expect(screen.getByText("Запуск идёт 0:12 · обычно ~25 с")).toBeTruthy();
      expect(
        screen.getByText("Запускаем игру · обычно ~15 с · 0:04"),
      ).toBeTruthy();
    }));
});
