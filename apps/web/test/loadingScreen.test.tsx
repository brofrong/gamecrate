// Экран загрузки до появления игры (спека 2026-10-27-loading-screen §2): этапы
// списком, общая полоска, «Отменить», запасной фон вместо битой картинки.
import { describe, expect, it, mock } from "bun:test";
import type {
  InstallStage,
  SessionStage,
  SessionState,
  SessionView,
} from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import { Player } from "../src/components/Player";
import { loadingProgress, loadingSteps } from "../src/lib/loadingSteps";

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

  it("cancel calls onExit", () => {
    for (const v of [
      view("queued"),
      view("installing", { installStage: "login" }),
      view("starting", { stage: "login", streamReady: true }),
      view("playing", { stage: "loading", streamReady: true }),
    ]) {
      const onExit = mock(() => {});
      const r = renderPlayer(v, onExit);
      fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
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
