import { describe, expect, it, mock } from "bun:test";
import {
  type LibraryEntry,
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
import { IdlePrompt } from "../src/components/IdlePrompt";
import {
  type LibraryPlay,
  LibraryContent,
} from "../src/components/LibraryContent";
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
    playedSeconds: 0,
    createdAt: "2026-10-17T10:00:00.000Z",
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
    const queued = renderPlayer(view("queued", { streamReady: false }));
    expect(screen.getByText("Ждём свободный сервер…")).toBeTruthy();
    expect(streamFrame(queued.container)).toBeNull();
    queued.unmount();

    const starting = renderPlayer(view("starting", { streamReady: false }));
    expect(screen.getByText("Запускаем игру…")).toBeTruthy();
    expect(streamFrame(starting.container)).toBeNull();
    starting.unmount();

    const startingStream = renderPlayer(view("starting"));
    expectStream(startingStream.container);
    expect(
      screen.getByText(
        "Если появилось окно входа Steam — отсканируйте QR-код в мобильном приложении Steam",
      ),
    ).toBeTruthy();
    startingStream.unmount();

    for (const state of ["playing", "disconnected"] as const) {
      const playing = renderPlayer(view(state));
      expectStream(playing.container);
      expect(
        screen.getByRole("button", { name: "Выйти из игры" }),
      ).toBeTruthy();
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
      view("installing", { streamReady: false, installPercent: 34 }),
    );
    expect(screen.getByText("Устанавливаем игру")).toBeTruthy();
    expect(screen.getByText("34 %")).toBeTruthy();
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

  it("installing screen shows the percent, the not-billed note and cancels via the same stop action", () => {
    const onExit = mock(() => {});
    renderPlayer(
      view("installing", { streamReady: false, installPercent: 34 }),
      { onExit },
    );
    expect(screen.getByText("Устанавливаем игру")).toBeTruthy();
    expect(screen.getByText("34 %")).toBeTruthy();
    expect(
      screen.getByText("Время установки не входит в игровое"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("installing with an unknown total shows 0 %", () => {
    renderPlayer(view("installing", { streamReady: false, installPercent: 0 }));
    expect(screen.getByText("0 %")).toBeTruthy();
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

  it("steam login failure shows QR and plays again after done", () => {
    const onPlayAgain = mock(() => {});
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
        onLibrary={noop}
        onPlayAgain={onPlayAgain}
        QrLogin={QrLogin}
      />,
    );
    expect(screen.getByText("Войдите в Steam ещё раз")).toBeTruthy();
    expect(screen.queryByText("Не удалось запустить игру")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "готово (фейк)" }));
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
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

  it("exit asks for confirmation before stopping", async () => {
    const onExit = mock(() => {});
    renderPlayer(view("playing"), { onExit });
    fireEvent.click(screen.getByRole("button", { name: "Выйти из игры" }));
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

  it("play disabled on other games while a session is active", async () => {
    const game = (appId: number, name: string): LibraryEntry => ({
      appId,
      name,
      playtimeMinutes: 0,
      protonTier: "platinum",
      coverUrl: `https://cdn.example/${appId}.jpg`,
    });
    const onPlay = mock((_appId: number) => {});
    const onResume = mock(() => {});
    const play = (active: SessionView | null): LibraryPlay => ({
      active,
      startingAppId: null,
      onPlay,
      onResume,
    });
    const entries = [game(620, "Portal 2"), game(400, "Portal")];
    const view_ = { _tag: "Ready", entries, syncedAt: null } as const;

    const free = render(
      <LibraryContent
        view={view_}
        onRefresh={noop}
        refreshing={false}
        play={play(null)}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Играть" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);
    expect(onPlay).toHaveBeenCalledWith(400);
    free.unmount();

    render(
      <LibraryContent
        view={view_}
        onRefresh={noop}
        refreshing={false}
        play={play(view("playing"))}
      />,
    );
    const blocked = screen.getByRole("button", { name: "Играть" });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    fireEvent.focus(blocked.parentElement as HTMLElement);
    expect(
      (await screen.findAllByText("Сначала завершите текущую игру")).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Вернуться в игру" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledTimes(1);
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
