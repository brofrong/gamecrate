// Меню сессии на экране стрима (спека §2): кнопки «Меню» и «На весь экран», подсказка новичку,
// панель качества/отладки, выход с подтверждением, полный экран с захватом клавиш, мост к Selkies.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  defaultStreamSettings,
  type SessionView,
  type StreamSettings,
} from "@cg/rpc";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Player } from "../src/components/Player";
import type { SelkiesBridge } from "../src/lib/selkiesBridge";
import type { StreamSettingsControl } from "../src/lib/useStreamSettings";

const sessionId = "0b5c1a52-7f4e-4f1e-9a43-3c1d2e5f6a7b";

const view = (patch: Partial<SessionView> = {}): SessionView => ({
  id: sessionId,
  appId: 620,
  gameName: "Portal 2",
  state: "playing",
  streamReady: true,
  failReason: null,
  idleDeadline: null,
  installPercent: null,
  stage: null,
  installStage: null,
  hadInstall: false,
  playedSeconds: 0,
  createdAt: "2026-10-17T10:00:00.000Z",
  ...patch,
});

const noop = () => {};

type Update = (patch: Partial<StreamSettings>) => void;

const control = (
  patch: Partial<StreamSettings> = {},
  loaded = true,
  update = mock<Update>(() => {}),
) => ({
  settings: { ...defaultStreamSettings, ...patch },
  loaded,
  update,
});

const fakeBridge = () => ({
  attach: mock((_frame: HTMLIFrameElement) => {}),
  update: mock((_prev: StreamSettings, _next: StreamSettings) => {}),
  setStatsOpen: mock((_open: boolean) => {}),
  frameWindow: mock((): Window | null => null),
  detach: mock(() => {}),
});

type Props = {
  view?: SessionView;
  streamSettings: StreamSettingsControl;
  bridge?: SelkiesBridge;
  onExit?: () => void;
  onFrameLoad?: (frame: HTMLIFrameElement) => void;
};

const ui = (props: Props) => (
  <Player
    view={props.view ?? view()}
    onExit={props.onExit ?? noop}
    onHere={noop}
    onLibrary={noop}
    onPlayAgain={noop}
    streamSettings={props.streamSettings}
    bridge={props.bridge ?? fakeBridge()}
    {...(props.onFrameLoad ? { onFrameLoad: props.onFrameLoad } : {})}
  />
);

const renderPlayer = (props: Props) => {
  const result = render(ui(props));
  return {
    ...result,
    main: () => result.container.querySelector("main") as HTMLElement,
    frame: () => result.container.querySelector("iframe") as HTMLIFrameElement,
    rerenderWith: (next: Props) => result.rerender(ui(next)),
  };
};

const menuButton = () => screen.getByRole("button", { name: "Меню" });

/** Клик по «Меню»; позицию панели Radix (floating-ui) считает асинхронно — дожидаемся в `act`. */
const clickMenu = async () => {
  fireEvent.click(menuButton());
  await act(async () => {});
};
const menuShown = () => screen.queryByText("Качество") !== null;
const hintShown = () => screen.queryByText("настройки игры") !== null;

// Полный экран и захват клавиш: happy-dom их не умеет — заглушки на время теста.
let fullscreenElement: Element | null = null;
let calls: Array<{ call: string; target?: Element }> = [];
const originalRequestFullscreen = HTMLElement.prototype.requestFullscreen;

const keyboardStub = () => ({
  lock: mock(async () => {
    calls.push({ call: "lock" });
  }),
  unlock: mock(() => {}),
});

const setKeyboard = (keyboard: ReturnType<typeof keyboardStub> | undefined) =>
  Object.defineProperty(navigator, "keyboard", {
    configurable: true,
    value: keyboard,
  });

const setFullscreen = (element: Element | null) =>
  act(() => {
    fullscreenElement = element;
    document.dispatchEvent(new Event("fullscreenchange"));
  });

beforeEach(() => {
  fullscreenElement = null;
  calls = [];
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  HTMLElement.prototype.requestFullscreen = async function (this: HTMLElement) {
    calls.push({ call: "requestFullscreen", target: this });
  };
});

afterEach(() => {
  HTMLElement.prototype.requestFullscreen = originalRequestFullscreen;
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(navigator, "keyboard");
});

describe("session menu", () => {
  it("menu button replaces the exit button", () => {
    const shown = renderPlayer({ streamSettings: control() });
    expect(menuButton()).toBeTruthy();
    expect(screen.getByRole("button", { name: "На весь экран" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Выйти из игры" })).toBeNull();
    shown.unmount();

    renderPlayer({
      view: view({ state: "starting", stage: "login" }),
      streamSettings: control(),
    });
    expect(screen.queryByRole("button", { name: "Меню" })).toBeNull();
    expect(screen.queryByRole("button", { name: "На весь экран" })).toBeNull();
  });

  it("hint waits for loaded settings and goes away on first open", async () => {
    const update = mock<Update>(() => {});
    const player = renderPlayer({
      streamSettings: control({}, false, update),
    });
    expect(hintShown()).toBe(false);

    player.rerenderWith({ streamSettings: control({}, true, update) });
    expect(hintShown()).toBe(true);
    // Плашка не перехватывает клики по игре.
    expect(
      screen.getByText("настройки игры").closest(".pointer-events-none"),
    ).not.toBeNull();

    await clickMenu();
    expect(update).toHaveBeenCalledWith({ menuSeen: true });

    player.rerenderWith({
      streamSettings: control({ menuSeen: true }, true, update),
    });
    expect(hintShown()).toBe(false);

    await clickMenu(); // закрыть
    await clickMenu(); // открыть снова
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("auto hides manual controls", async () => {
    const update = mock<Update>(() => {});
    const bridge = fakeBridge();
    const player = renderPlayer({
      streamSettings: control({}, true, update),
      bridge,
    });
    await clickMenu();
    // Панель — внутри `<main>`: в полном экране видно только его поддерево.
    expect(player.main().contains(screen.getByText("Качество"))).toBe(true);
    expect(screen.queryByText("Битрейт")).toBeNull();
    expect(screen.queryByText("Разрешение")).toBeNull();

    fireEvent.click(
      screen.getByRole("switch", { name: "Авто — под вашу сеть" }),
    );
    expect(update).toHaveBeenCalledWith({ quality: "manual" });

    const manual = control({ quality: "manual" }, true, update);
    player.rerenderWith({ streamSettings: manual, bridge });
    expect(screen.getByText("Битрейт")).toBeTruthy();
    expect(screen.getByText("20 Мбит/с")).toBeTruthy();
    expect(
      screen
        .getByRole("slider", { name: "Битрейт" })
        .getAttribute("aria-valuenow"),
    ).toBe("20");
    expect(
      screen.getByText("максимум; при плохой сети будет ниже"),
    ).toBeTruthy();
    expect(screen.getByText("Разрешение")).toBeTruthy();
    const resolutionGroup = screen.getByRole("radiogroup", {
      name: "Разрешение",
    });
    expect(
      Array.from(resolutionGroup.querySelectorAll("button")).map(
        (button) => button.textContent,
      ),
    ).toEqual(["720p", "1080p", "1440p"]);
    expect(screen.queryByText("По окну")).toBeNull();
    expect(screen.getByText("со следующего запуска")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "720p" }));
    expect(update).toHaveBeenCalledWith({ resolution: "720p" });

    // Разрешение только сохраняется; мост получает новые настройки и сам решает, что слать.
    player.rerenderWith({
      streamSettings: control(
        { quality: "manual", resolution: "720p" },
        true,
        update,
      ),
      bridge,
    });
    const [prev, next] = bridge.update.mock.calls.at(-1) ?? [];
    expect(prev?.resolution).toBe("1080p");
    expect(next?.resolution).toBe("720p");
  });

  it("slider commits on release", async () => {
    const update = mock<Update>(() => {});
    renderPlayer({
      streamSettings: control({ quality: "manual" }, true, update),
    });
    await clickMenu();
    const thumb = screen.getByRole("slider", { name: "Битрейт" });
    act(() => thumb.focus());
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(update).toHaveBeenCalledWith({ bitrateMbps: 21 });
    expect(screen.getByText("21 Мбит/с")).toBeTruthy();
  });

  it("debug mode switch", async () => {
    const update = mock<Update>(() => {});
    renderPlayer({ streamSettings: control({}, true, update) });
    await clickMenu();
    expect(screen.getByText("Отладка")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Выкл" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Коротко" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Подробно" }));
    expect(update).toHaveBeenCalledWith({ debug: "detailed" });

    // Повторный клик по выбранному варианту (пустой выбор) игнорируется.
    update.mockClear();
    fireEvent.click(screen.getByRole("radio", { name: "Выкл" }));
    expect(update).not.toHaveBeenCalled();
  });

  it("end game asks for confirmation", async () => {
    const onExit = mock(() => {});
    const player = renderPlayer({ streamSettings: control(), onExit });
    await clickMenu();
    fireEvent.click(screen.getByRole("button", { name: "Закончить игру" }));
    const title = await screen.findByText(
      "Закончить игру? Прогресс сохранится.",
    );
    expect(player.main().contains(title)).toBe(true);
    expect(
      screen.getByText(
        "Игра закроется, сохранения синхронизируются со Steam Cloud.",
      ),
    ).toBeTruthy();
    expect(menuShown()).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закончить игру" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("closing the menu returns focus to the stream", async () => {
    const player = renderPlayer({ streamSettings: control() });
    await clickMenu();
    expect(menuShown()).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(menuShown()).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(player.frame()));

    await clickMenu();
    fireEvent.click(screen.getByRole("button", { name: "Закончить игру" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Продолжить играть" }),
    );
    expect(
      screen.queryByText("Закончить игру? Прогресс сохранится."),
    ).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(player.frame()));

    // Клик по игре уводит фокус в iframe (окно страницы теряет фокус) — меню закрывается.
    await clickMenu();
    expect(menuShown()).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(menuShown()).toBe(false);
  });

  it("escape does not close the menu in fullscreen", async () => {
    const player = renderPlayer({ streamSettings: control() });
    await clickMenu();
    setFullscreen(player.main());
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(menuShown()).toBe(true);
  });

  it("fullscreen locks the keyboard and hides its button", async () => {
    const keyboard = keyboardStub();
    setKeyboard(keyboard);
    const player = renderPlayer({ streamSettings: control() });
    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));
    await waitFor(() => expect(keyboard.lock).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => c.call)).toEqual(["requestFullscreen", "lock"]);
    expect(calls[0]?.target).toBe(player.main());
    await waitFor(() => expect(document.activeElement).toBe(player.frame()));

    // Без Keyboard Lock API (Safari, Firefox) — просто полный экран, без ошибки.
    setKeyboard(undefined);
    calls = [];
    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));
    await waitFor(() =>
      expect(calls.map((c) => c.call)).toEqual(["requestFullscreen"]),
    );

    setKeyboard(keyboard);
    setFullscreen(player.main());
    expect(screen.queryByRole("button", { name: "На весь экран" })).toBeNull();
    expect(menuButton()).toBeTruthy();

    setFullscreen(null);
    expect(keyboard.unlock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "На весь экран" })).toBeTruthy();
  });

  it("frame load attaches the bridge and input", () => {
    const bridge = fakeBridge();
    const onFrameLoad = mock((_frame: HTMLIFrameElement) => {});
    const player = renderPlayer({
      streamSettings: control(),
      bridge,
      onFrameLoad,
    });
    fireEvent.load(player.frame());
    expect(bridge.attach).toHaveBeenCalledWith(player.frame());
    expect(onFrameLoad).toHaveBeenCalledWith(player.frame());
    fireEvent.load(player.frame());
    expect(bridge.attach).toHaveBeenCalledTimes(2);
    expect(onFrameLoad).toHaveBeenCalledTimes(2);

    expect(bridge.update).not.toHaveBeenCalled();
    player.rerenderWith({
      streamSettings: control({ debug: "short" }),
      bridge,
      onFrameLoad,
    });
    expect(bridge.update).toHaveBeenCalledTimes(1);
    const [prev, next] = bridge.update.mock.calls[0] ?? [];
    expect(prev?.debug).toBe("off");
    expect(next?.debug).toBe("short");

    player.unmount();
    expect(bridge.detach).toHaveBeenCalledTimes(1);
  });
});
