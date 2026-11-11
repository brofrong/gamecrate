import { describe, expect, it, mock, spyOn } from "bun:test";
import {
  accessDeniedReason,
  noMinutesReason,
  noServerReason,
  type SessionState,
  type SessionView,
  steamLoginRequiredReason,
} from "@cg/rpc";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { Exit } from "effect";
import { toast } from "sonner";
import { IdlePrompt } from "../src/components/IdlePrompt";
import { cardAction, type LibraryPlay } from "../src/lib/cardAction";
import { Player } from "../src/components/Player";
import { formatPlayed } from "../src/components/SessionStatus";
import {
  createGamepadWatcher,
  GAMEPAD_POLL_MS,
  type GamepadWindow,
  gamepadsChanged,
  snapshotGamepads,
  useInputActivity,
} from "../src/lib/inputActivity";
import { playAgain } from "../src/routes/session.$id";
import { startSessionArgs } from "../src/rpc";

const sessionId = "0b5c1a52-7f4e-4f1e-9a43-3c1d2e5f6a7b";

const view = (state: SessionState, patch: Partial<SessionView> = {}) =>
  ({
    id: sessionId,
    appId: 620,
    gameName: "Portal 2",
    state,
    streamReady: true,
    failReason: null,
    idleDeadline: null,
    installPercent: null,
    stage: null,
    installStage: null,
    hadInstall: false,
    timing: null,
    playedSeconds: 0,
    previousPlayedAt: null,
    createdAt: "2026-10-17T10:00:00.000Z",
    queue: null,
    limit: null,
    ...patch,
  }) satisfies SessionView;

const noop = () => {};

const pad = (axes: number[], pressed: boolean[] = [false]) =>
  ({
    axes,
    buttons: pressed.map((p) => ({ pressed: p, value: p ? 1 : 0 })),
  }) as unknown as Gamepad;

/** Окно с подменными геймпадами (страница или iframe стрима). */
const padWindow = (
  pads: () => ReadonlyArray<Gamepad | null>,
): GamepadWindow => ({
  navigator: { getGamepads: () => [...pads()] },
});

const renderPlayer = (
  v: SessionView,
  handlers: Partial<{
    onExit: () => void;
    onHere: () => void;
    onLibrary: () => void;
    onPlayAgain: () => void;
  }> = {},
) =>
  render(
    <Player
      view={v}
      onExit={handlers.onExit ?? noop}
      onHere={handlers.onHere ?? noop}
      onLibrary={handlers.onLibrary ?? noop}
      onPlayAgain={handlers.onPlayAgain ?? noop}
    />,
  );

const streamFrame = (container: HTMLElement) =>
  container.querySelector("iframe") as HTMLIFrameElement | null;

const expectStream = (container: HTMLElement) => {
  const frame = streamFrame(container);
  expect(frame).not.toBeNull();
  expect(frame?.getAttribute("src")).toBe(`/stream/${sessionId}/`);
  expect(frame?.getAttribute("allow")).toBe(
    "autoplay; fullscreen; gamepad; clipboard-read; clipboard-write",
  );
};

describe("session", () => {
  it("renders status text for each state", () => {
    // queued/installing/starting — экран загрузки (подробно — loadingScreen.test.tsx).
    const queued = renderPlayer(view("queued", { streamReady: false }));
    expect(screen.getByText("Ждём свободный сервер")).toBeTruthy();
    expect(streamFrame(queued.container)).toBeNull();
    queued.unmount();

    // Стрима ещё нет — показывать нечего, кнопки «Показать экран» нет.
    const starting = renderPlayer(view("starting", { streamReady: false }));
    expect(screen.getByText("Готовим компьютер")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Показать экран" })).toBeNull();
    expect(streamFrame(starting.container)).toBeNull();
    starting.unmount();

    // Стрим готов — он уже подключается под экраном загрузки.
    const startingStream = renderPlayer(view("starting", { stage: "login" }));
    expectStream(startingStream.container);
    expect(screen.getByText("Входим в аккаунт")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Показать экран" })).toBeTruthy();
    startingStream.unmount();

    for (const state of ["playing", "disconnected"] as const) {
      const playing = renderPlayer(view(state));
      expectStream(playing.container);
      expect(screen.getByRole("button", { name: "Меню" })).toBeTruthy();
      playing.unmount();
    }

    const idle = renderPlayer(
      view("idle_warning", {
        idleDeadline: new Date(Date.now() + 90_500).toISOString(),
      }),
    );
    expectStream(idle.container);
    expect(screen.getByText("Вы ещё здесь?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Я здесь" })).toBeTruthy();
    expect(screen.getByText("Сессия закроется через 1:31")).toBeTruthy();
    idle.unmount();

    const stopping = renderPlayer(view("stopping"));
    expect(screen.getByText("Сохраняем прогресс…")).toBeTruthy();
    expect(streamFrame(stopping.container)).toBeNull();
    stopping.unmount();

    const installing = renderPlayer(
      view("installing", {
        streamReady: false,
        installStage: "downloading",
        installPercent: 34,
      }),
    );
    expect(screen.getByText("Скачиваем игру · 34 %")).toBeTruthy();
    expect(
      screen.getByText("Время установки не входит в игровое"),
    ).toBeTruthy();
    expect(streamFrame(installing.container)).toBeNull();
    installing.unmount();

    const onLibrary = mock(() => {});
    const ended = renderPlayer(view("ended", { playedSeconds: 4320 }), {
      onLibrary,
    });
    expect(
      screen.getByText("Сессия завершена. Вы играли 1 ч 12 мин"),
    ).toBeTruthy();
    expect(streamFrame(ended.container)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "В библиотеку" }));
    expect(onLibrary).toHaveBeenCalledTimes(1);
    ended.unmount();

    const failed = renderPlayer(
      view("failed", { failReason: "Сервер с игрой перестал отвечать" }),
    );
    expect(screen.getByText("Не удалось запустить игру")).toBeTruthy();
    expect(screen.getByText("Сервер с игрой перестал отвечать")).toBeTruthy();
    expect(screen.getByRole("button", { name: "В библиотеку" })).toBeTruthy();
    expect(streamFrame(failed.container)).toBeNull();
  });

  it("installing screen shows the percent, the not-billed note and cancels via the same stop action", async () => {
    const onExit = mock(() => {});
    renderPlayer(
      view("installing", {
        streamReady: false,
        installStage: "downloading",
        installPercent: 34,
      }),
      { onExit },
    );
    expect(screen.getByText("Скачиваем игру · 34 %")).toBeTruthy();
    expect(
      screen.getByText("Время установки не входит в игровое"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Да, отменить" }),
    );
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("installing with an unknown total shows 0 %", () => {
    renderPlayer(
      view("installing", {
        streamReady: false,
        installStage: "downloading",
        installPercent: 0,
      }),
    );
    expect(screen.getByText("Скачиваем игру · 0 %")).toBeTruthy();
  });

  it("ended shows played time in hours and minutes", () => {
    expect(formatPlayed(4320)).toBe("1 ч 12 мин");
    expect(formatPlayed(600)).toBe("10 мин");
    expect(formatPlayed(3600 + 5 * 60 + 59)).toBe("1 ч 05 мин");
    expect(formatPlayed(59)).toBe("0 мин");
    renderPlayer(view("ended", { playedSeconds: 600 }));
    expect(screen.getByText("Сессия завершена. Вы играли 10 мин")).toBeTruthy();
  });

  it("ended with a reason shows it with a neutral icon and the played time", () => {
    const onLibrary = mock(() => {});
    const timedOut = renderPlayer(
      view("ended", {
        failReason: "Игра не запустилась за отведённое время",
        playedSeconds: 0,
      }),
      { onLibrary },
    );
    expect(screen.getByText("Сессия завершена")).toBeTruthy();
    expect(
      screen.getByText("Игра не запустилась за отведённое время"),
    ).toBeTruthy();
    expect(screen.getByText("Вы играли 0 мин")).toBeTruthy();
    // Не зелёная галочка успеха.
    expect(timedOut.container.querySelector(".text-emerald-400")).toBeNull();
    expect(
      timedOut.container.querySelector('[data-icon="neutral"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "В библиотеку" }));
    expect(onLibrary).toHaveBeenCalledTimes(1);
    timedOut.unmount();

    // Без причины — прежний экран успеха.
    const ok = renderPlayer(view("ended", { playedSeconds: 600 }));
    expect(screen.getByText("Сессия завершена. Вы играли 10 мин")).toBeTruthy();
    expect(ok.container.querySelector(".text-emerald-400")).not.toBeNull();
  });

  it("steam login failure shows QR, offers a library escape, and plays again after done", () => {
    const onPlayAgain = mock(() => {});
    const onLibrary = mock(() => {});
    const QrLogin = ({
      title,
      onDone,
    }: {
      title: string;
      onDone: () => void;
    }) => (
      <div>
        <p>{title}</p>
        <button onClick={onDone}>готово (фейк)</button>
      </div>
    );
    render(
      <Player
        view={view("failed", {
          failReason: steamLoginRequiredReason,
          streamReady: false,
        })}
        onExit={noop}
        onHere={noop}
        onLibrary={onLibrary}
        onPlayAgain={onPlayAgain}
        QrLogin={QrLogin}
      />,
    );
    expect(screen.getByText("Войдите в Steam ещё раз")).toBeTruthy();
    expect(screen.queryByText("Не удалось запустить игру")).toBeNull();

    // Как у других терминальных состояний — есть путь назад, не только QR.
    fireEvent.click(screen.getByRole("button", { name: "В библиотеку" }));
    expect(onLibrary).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "готово (фейк)" }));
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
  });

  describe("playAgain (route-level handler behind onPlayAgain)", () => {
    it("starts the session with the session's appId and navigates to the new session", async () => {
      const start = mock(async () => Exit.succeed({ id: "new-session-id" }));
      const navigate = mock((_to: unknown) => {});

      await playAgain(620, { start, navigate });

      expect(start).toHaveBeenCalledWith(startSessionArgs(620));
      expect(navigate).toHaveBeenCalledWith({
        to: "/session/$id",
        params: { id: "new-session-id" },
      });
    });

    it("shows a toast and does not navigate when starting the session fails", async () => {
      const toastError = spyOn(toast, "error").mockImplementation(
        () => "" as never,
      );
      const start = mock(async () =>
        Exit.fail({ _tag: "SessionServerUnavailable" } as const),
      );
      const navigate = mock((_to: unknown) => {});

      await playAgain(620, { start, navigate });

      expect(navigate).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(
        "Не удалось начать игру. Попробуйте ещё раз.",
      );
      toastError.mockRestore();
    });

    it("shows «Доступ закрыт» and does not navigate when the user is blocked", async () => {
      const toastError = spyOn(toast, "error").mockImplementation(
        () => "" as never,
      );
      const start = mock(async () =>
        Exit.fail({ _tag: "AccessDenied" } as const),
      );
      const navigate = mock((_to: unknown) => {});

      await playAgain(620, { start, navigate });

      expect(navigate).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(accessDeniedReason);
      toastError.mockRestore();
    });

    it("says the game is not in the Steam library and does not navigate on GameNotOwned", async () => {
      const toastError = spyOn(toast, "error").mockImplementation(
        () => "" as never,
      );
      const start = mock(async () =>
        Exit.fail({ _tag: "GameNotOwned" } as const),
      );
      const navigate = mock((_to: unknown) => {});

      await playAgain(620, { start, navigate });

      expect(navigate).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(
        "Эта игра не найдена в вашей библиотеке Steam",
      );
      toastError.mockRestore();
    });

    it("says there is no suitable server and does not navigate on NoServer", async () => {
      const toastError = spyOn(toast, "error").mockImplementation(
        () => "" as never,
      );
      const start = mock(async () => Exit.fail({ _tag: "NoServer" } as const));
      const navigate = mock((_to: unknown) => {});

      await playAgain(620, { start, navigate });

      expect(navigate).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(noServerReason);
      toastError.mockRestore();
    });

    it("shows «Часы закончились» with a «Докупить» action to /app/plans and does not navigate on NoMinutes", async () => {
      const toastError = spyOn(toast, "error").mockImplementation(
        () => "" as never,
      );
      const start = mock(async () => Exit.fail({ _tag: "NoMinutes" } as const));
      const navigate = mock((_to: unknown) => {});

      await playAgain(620, { start, navigate });

      expect(navigate).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(
        noMinutesReason,
        expect.objectContaining({
          action: expect.objectContaining({ label: "Докупить" }),
        }),
      );
      const [, options] = toastError.mock.calls[0] ?? [];
      const action = (
        options as unknown as { action?: { onClick: () => void } }
      )?.action;
      const assign = spyOn(window.location, "assign").mockImplementation(
        () => {},
      );
      action?.onClick();
      expect(assign).toHaveBeenCalledWith("/app/plans");
      assign.mockRestore();
      toastError.mockRestore();
    });
  });

  it("failed after real play says the game was interrupted and shows played time", () => {
    const played = renderPlayer(
      view("failed", {
        failReason: "Сервер с игрой перестал отвечать",
        playedSeconds: 4320,
      }),
    );
    expect(screen.getByText("Игра прервалась")).toBeTruthy();
    expect(screen.queryByText("Не удалось запустить игру")).toBeNull();
    expect(screen.getByText("Сервер с игрой перестал отвечать")).toBeTruthy();
    expect(screen.getByText("Вы играли 1 ч 12 мин")).toBeTruthy();
    expect(screen.getByRole("button", { name: "В библиотеку" })).toBeTruthy();
    played.unmount();

    renderPlayer(
      view("failed", {
        failReason: "Не удалось запустить игровой сервер",
        playedSeconds: 0,
      }),
    );
    expect(screen.getByText("Не удалось запустить игру")).toBeTruthy();
    expect(screen.queryByText("Игра прервалась")).toBeNull();
    expect(screen.queryByText(/Вы играли/)).toBeNull();
  });

  it("idle prompt counts down to idleDeadline and calls onHere", async () => {
    let now = Date.parse("2026-10-17T12:00:00.000Z");
    const deadline = new Date(now + 65_000).toISOString();
    const onHere = mock(() => {});
    render(<IdlePrompt deadline={deadline} onHere={onHere} now={() => now} />);
    expect(screen.getByText("Сессия закроется через 1:05")).toBeTruthy();

    now += 6_000;
    await waitFor(() =>
      expect(screen.getByText("Сессия закроется через 0:59")).toBeTruthy(),
    );

    now += 120_000;
    await waitFor(() =>
      expect(screen.getByText("Сессия закроется через 0:00")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Я здесь" }));
    expect(onHere).toHaveBeenCalledTimes(1);
  });

  it("limit warning is rendered under the fullscreen root (Player's <main>)", () => {
    // Полный экран запрашивается на `<main>` плеера — видно только его поддерево.
    const deadline = new Date(Date.now() + 5 * 60_000).toISOString();
    const { container } = renderPlayer(
      view("playing", { limit: { deadline, reason: "minutes" } }),
    );
    const root = container.querySelector("main");
    expect(root).not.toBeNull();
    const alert = screen.getByText("Часы заканчиваются — сохранитесь");
    expect(root?.contains(alert)).toBe(true);
  });

  it("exit asks for confirmation before stopping", async () => {
    const onExit = mock(() => {});
    renderPlayer(view("playing"), { onExit });
    fireEvent.click(screen.getByRole("button", { name: "Меню" }));
    fireEvent.click(screen.getByRole("button", { name: "Закончить игру" }));
    expect(
      await screen.findByText("Закончить игру? Прогресс сохранится."),
    ).toBeTruthy();
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закончить игру" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("keeps the same iframe across stream states", () => {
    const { container, rerender } = renderPlayer(view("starting"));
    const first = streamFrame(container);
    expect(first).not.toBeNull();
    const deadline = new Date(Date.now() + 60_000).toISOString();
    for (const v of [
      view("playing"),
      view("idle_warning", { idleDeadline: deadline }),
      view("disconnected"),
      view("playing"),
    ]) {
      rerender(
        <Player
          view={v}
          onExit={noop}
          onHere={noop}
          onLibrary={noop}
          onPlayAgain={noop}
        />,
      );
      expect(streamFrame(container)).toBe(first);
    }
  });

  const rerenderPlayer = (
    rerender: (ui: React.ReactNode) => void,
    v: SessionView,
  ) =>
    rerender(
      <Player
        view={v}
        onExit={noop}
        onHere={noop}
        onLibrary={noop}
        onPlayAgain={noop}
      />,
    );

  /** Экран загрузки на странице: его признак — строка последнего этапа запуска. */
  const loadingShown = () => screen.queryByText("Загружаем игру") !== null;

  it("loading overlay keeps the same iframe", () => {
    const { container, rerender } = renderPlayer(
      view("starting", { stage: "prepare" }),
    );
    const first = streamFrame(container);
    expect(first).not.toBeNull();
    expect(loadingShown()).toBe(true);
    // Пока экран загрузки — своя «Отменить», без меню поверх него.
    expect(screen.queryByRole("button", { name: "Меню" })).toBeNull();

    // Steam запустил игру (`playing`), окна ещё нет — экран загрузки остаётся.
    rerenderPlayer(rerender, view("playing", { stage: "loading" }));
    expect(streamFrame(container)).toBe(first);
    expect(loadingShown()).toBe(true);

    // Скрытая трансляция не получает фокус и клавиши (Tab ушёл бы в рабочий стол).
    expect(first?.hasAttribute("inert")).toBe(true);

    // Окно игры появилось — экран загрузки снят, iframe тот же.
    rerenderPlayer(rerender, view("playing", { stage: "visible" }));
    expect(streamFrame(container)).toBe(first);
    expect(loadingShown()).toBe(false);
    expect(first?.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("button", { name: "Меню" })).toBeTruthy();
  });

  it("show screen reveals the stream and stays revealed", () => {
    const { container, rerender } = renderPlayer(
      view("starting", { stage: "login" }),
    );
    const first = streamFrame(container);
    fireEvent.click(screen.getByRole("button", { name: "Показать экран" }));
    expect(loadingShown()).toBe(false);
    expect(streamFrame(container)).toBe(first);
    expect(first?.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("button", { name: "Меню" })).toBeTruthy();

    // Новые этапы не возвращают экран загрузки.
    for (const stage of ["prepare", "loading", "visible"] as const) {
      rerenderPlayer(rerender, view("playing", { stage }));
      expect(loadingShown()).toBe(false);
      expect(streamFrame(container)).toBe(first);
    }
  });

  it("show screen does not carry over to the next session", () => {
    const { rerender } = renderPlayer(view("starting", { stage: "login" }));
    fireEvent.click(screen.getByRole("button", { name: "Показать экран" }));
    expect(loadingShown()).toBe(false);
    // «Играть снова» — новая сессия в том же `Player`: снова экран загрузки.
    rerenderPlayer(
      rerender,
      view("starting", {
        id: "5f0e3c2a-1b4d-4e6f-8a9b-0c1d2e3f4a5b",
        stage: "computer",
      }),
    );
    expect(loadingShown()).toBe(true);
  });

  it("playing without a stage shows the stream", () => {
    const { container } = renderPlayer(view("playing"));
    expectStream(container);
    expect(loadingShown()).toBe(false);
    expect(screen.getByRole("button", { name: "Меню" })).toBeTruthy();
  });

  it("playing with a stage before prepare shows the stream", () => {
    // Игра уже идёт, а этап раньше `prepare` — источник этапов сломан
    // (например, в образе нет скрипта): трансляция, а не «Запускаем Steam» поверх игры.
    for (const stage of ["computer", "steam", "login"] as const) {
      const { container, unmount } = renderPlayer(view("playing", { stage }));
      expectStream(container);
      expect(loadingShown()).toBe(false);
      expect(screen.getByRole("button", { name: "Меню" })).toBeTruthy();
      unmount();
    }
    // `prepare`/`loading` — игра идёт, окна ещё нет: экран загрузки.
    for (const stage of ["prepare", "loading"] as const) {
      const { unmount } = renderPlayer(view("playing", { stage }));
      expect(loadingShown()).toBe(true);
      unmount();
    }
  });

  it("steam QR hint sits on the loading screen, not over the stream", () => {
    const qr =
      "Если появилось окно входа Steam — отсканируйте QR-код в мобильном приложении Steam";
    renderPlayer(view("starting", { stage: "login" }));
    expect(screen.getByText(qr)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Показать экран" }));
    expect(screen.queryByText(qr)).toBeNull();
  });

  it("cardAction: play for free games, resume for the active one, blocked for the rest", () => {
    const onPlay = mock((_appId: number) => {});
    const onResume = mock(() => {});
    const play = (active: SessionView | null): LibraryPlay => ({
      active,
      startingAppId: null,
      onPlay,
      onResume,
    });

    // Нет активной сессии: у каждой игры «Играть»/«Установить» (запрос один и тот же).
    const free = cardAction({ appId: 400, available: true }, play(null));
    expect(free.kind).toBe("play");
    if (free.kind === "play") free.onPlay();
    expect(onPlay).toHaveBeenCalledWith(400);

    // Активная сессия у Portal 2 (620): у неё «Вернуться в игру», Portal (400) заблокирован.
    const resume = cardAction(
      { appId: 620, available: true },
      play(view("playing")),
    );
    expect(resume.kind).toBe("resume");
    if (resume.kind === "resume") resume.onResume();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(
      cardAction({ appId: 400, available: true }, play(view("playing"))).kind,
    ).toBe("blocked");
  });

  it("gamepad noise inside the dead zone is not input", () => {
    const rest = snapshotGamepads([pad([0.02, -0.03])]);
    expect(gamepadsChanged(rest, snapshotGamepads([pad([0.06, -0.08])]))).toBe(
      false,
    );
    expect(gamepadsChanged(rest, snapshotGamepads([pad([0.6, -0.03])]))).toBe(
      true,
    );
    expect(
      gamepadsChanged(rest, snapshotGamepads([pad([0.02, -0.03], [true])])),
    ).toBe(true);
    // Новый геймпад сам по себе — не ввод; пропавший — тоже.
    expect(gamepadsChanged([], rest)).toBe(false);
    expect(gamepadsChanged(rest, [])).toBe(false);
    expect(gamepadsChanged(rest, snapshotGamepads([null]))).toBe(false);
  });

  it("gamepad input in the focused stream iframe counts, broken windows are skipped", () => {
    // Фокус в iframe: снимок страницы застыл, свежие данные — только у iframe.
    const page = [pad([0, 0])];
    let frame = [pad([0, 0])];
    const onInput = mock(() => {});
    const watcher = createGamepadWatcher(onInput);
    const pageWindow = padWindow(() => page);
    const frameWindow = padWindow(() => frame);
    watcher.poll([pageWindow, frameWindow]);
    expect(onInput).not.toHaveBeenCalled();

    frame = [pad([0, 0], [true])];
    watcher.poll([pageWindow, frameWindow]);
    expect(onInput).toHaveBeenCalledTimes(1);
    watcher.poll([pageWindow, frameWindow]);
    expect(onInput).toHaveBeenCalledTimes(1);

    // Чужой origin (доступ к navigator бросает) и запрет Gamepad API — без ввода и без ошибок.
    const foreign = {
      get navigator(): GamepadWindow["navigator"] {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    };
    const blocked: GamepadWindow = {
      navigator: {
        getGamepads: () => {
          throw new DOMException("Not allowed", "SecurityError");
        },
      },
    };
    expect(() =>
      watcher.poll([pageWindow, foreign, blocked, null, undefined]),
    ).not.toThrow();
    expect(onInput).toHaveBeenCalledTimes(1);

    // Новое окно (iframe перезагрузился) сначала даёт базовый снимок — не ввод.
    const reloaded = padWindow(() => [pad([0.9, 0])]);
    watcher.poll([pageWindow, reloaded]);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("useInputActivity polls gamepads of the attached iframe window", async () => {
    let frame = [pad([0, 0])];
    const fakeFrame = {
      contentDocument: null,
      contentWindow: padWindow(() => frame),
    } as unknown as HTMLIFrameElement;
    const { result, unmount } = renderHook(() => useInputActivity());
    result.current.attachFrame(fakeFrame);
    await Bun.sleep(GAMEPAD_POLL_MS * 2);
    expect(result.current.ageMs()).toBeGreaterThanOrEqual(GAMEPAD_POLL_MS * 2);

    frame = [pad([0, 0], [true])];
    await waitFor(() =>
      expect(result.current.ageMs()).toBeLessThan(GAMEPAD_POLL_MS * 2),
    );
    unmount();
  });
});
