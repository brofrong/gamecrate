// Меню сессии на экране стрима (спека §2): кнопки «Меню» и «На весь экран», подсказка новичку,
// панель качества/отладки/клавиатуры, выход с подтверждением, полный экран с захватом клавиш и
// мыши, мост к Selkies.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from "bun:test";
import {
  defaultStreamSettings,
  type SessionView,
  type StreamResolution,
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
import { afterBreak } from "../src/components/session/SessionControls";
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
  timing: null,
  playedSeconds: 0,
  previousPlayedAt: null,
  createdAt: "2026-10-17T10:00:00.000Z",
  queue: null,
  limit: null,
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
  qualityLimits?: { maxResolution: StreamResolution; maxBitrateMbps: number };
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
    {...(props.qualityLimits ? { qualityLimits: props.qualityLimits } : {})}
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

// Сенсорный экран без мыши — подменой `matchMedia` (исходный вернёт `test/setup.ts`).
const touchScreen = () => {
  window.matchMedia = ((query: string) =>
    ({
      matches: query === "(pointer: coarse)",
      addEventListener: noop,
      removeEventListener: noop,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
};

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

  it("menu header shows the game and its play time", async () => {
    renderPlayer({
      view: view({ state: "disconnected", playedSeconds: 4325 }),
      streamSettings: control({ menuTourSeen: true }),
    });
    await clickMenu();
    expect(screen.getByText("Portal 2")).toBeTruthy();
    expect(screen.getByTitle("Игровое время").textContent).toBe("1:12:05");
  });

  it("play time ticks between server updates while playing", async () => {
    jest.useFakeTimers();
    try {
      const shown = renderPlayer({
        view: view({ playedSeconds: 725 }),
        streamSettings: control({ menuTourSeen: true }),
      });
      await clickMenu();
      const clock = () => screen.getByTitle("Игровое время").textContent;
      expect(clock()).toBe("12:05");
      act(() => jest.advanceTimersByTime(3_000));
      expect(clock()).toBe("12:08");
      // Пришло значение с сервера — отсчёт от него, а не от прежнего.
      shown.rerenderWith({
        view: view({ playedSeconds: 730 }),
        streamSettings: control({ menuTourSeen: true }),
      });
      expect(clock()).toBe("12:10");
      act(() => jest.advanceTimersByTime(1_000));
      expect(clock()).toBe("12:11");
    } finally {
      jest.useRealTimers();
    }
  });

  it("hint waits for loaded settings and goes away on first open", async () => {
    const update = mock<Update>(() => {});
    const seen = { fullscreenTutorialSeen: true };
    const player = renderPlayer({
      streamSettings: control(seen, false, update),
    });
    expect(hintShown()).toBe(false);

    player.rerenderWith({ streamSettings: control(seen, true, update) });
    expect(hintShown()).toBe(true);

    // Плашку нажимают вместо кнопки — она тоже открывает меню.
    fireEvent.click(screen.getByRole("button", { name: /настройки игры/ }));
    await act(async () => {});
    expect(menuShown()).toBe(true);
    expect(update).toHaveBeenCalledWith({ menuTourSeen: true });
    expect(hintShown()).toBe(false);

    player.rerenderWith({
      streamSettings: control({ ...seen, menuTourSeen: true }, true, update),
    });
    expect(hintShown()).toBe(false);

    await clickMenu(); // закрыть
    await clickMenu(); // открыть снова
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("opening the menu before load does not write menuTourSeen", async () => {
    const update = mock<Update>(() => {});
    renderPlayer({ streamSettings: control({}, false, update) });

    await clickMenu();
    expect(menuShown()).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it("controls do not take clicks meant for the game", () => {
    renderPlayer({ streamSettings: control() });
    const fullscreenButton = screen.getByRole("button", {
      name: "На весь экран",
    });
    // Контейнер кнопок сквозной, клики берут только сами кнопки.
    const bar = screen.getByTestId("menu-row").parentElement as HTMLElement;
    expect(bar.contains(fullscreenButton)).toBe(true);
    expect(bar.classList.contains("pointer-events-none")).toBe(true);
    expect(fullscreenButton.classList.contains("pointer-events-auto")).toBe(
      true,
    );
    expect(menuButton().classList.contains("pointer-events-auto")).toBe(true);
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

  it("locks resolutions above the tariff with «Доступно в тарифе выше» and caps the slider", async () => {
    const update = mock<Update>(() => {});
    renderPlayer({
      streamSettings: control({ quality: "manual", bitrateMbps: 25 }, true, update),
      qualityLimits: { maxResolution: "1080p", maxBitrateMbps: 20 },
    });
    await clickMenu();

    expect(screen.queryByText("Доступно в тарифе выше")).toBeTruthy();
    const allowed = screen.getByRole("radio", { name: "1080p" });
    expect(allowed.hasAttribute("disabled")).toBe(false);
    const locked = screen.getByRole("radio", { name: /1440p/ });
    expect(locked.hasAttribute("disabled")).toBe(true);

    fireEvent.click(locked);
    expect(update).not.toHaveBeenCalledWith({ resolution: "1440p" });

    // Битрейт выше потолка тарифа (25) — показан и зажат на потолке (20), а не выше.
    expect(screen.getByText("20 Мбит/с")).toBeTruthy();
    expect(
      screen.getByRole("slider", { name: "Битрейт" }).getAttribute("aria-valuemax"),
    ).toBe("20");
  });

  it("no tariff loaded — all resolutions unlocked, no lock note", async () => {
    renderPlayer({
      streamSettings: control({ quality: "manual" }, true),
    });
    await clickMenu();
    expect(screen.queryByText("Доступно в тарифе выше")).toBeNull();
    expect(
      screen.getByRole("radio", { name: "1440p" }).hasAttribute("disabled"),
    ).toBe(false);
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

  it("menu tells how to capture the mouse", async () => {
    renderPlayer({ streamSettings: control({ menuTourSeen: true }) });
    await clickMenu();
    const hint = screen.getByText(/захватит мышь/);
    expect(hint.textContent).toContain("Ctrl+Shift+клик");
    expect(hint.textContent).toContain("Esc");
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
    touchScreen();
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

    setFullscreen(null);
    expect(keyboard.unlock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "На весь экран" })).toBeTruthy();
  });

  it("в полном экране с мышью «Меню» нет — мышь захвачена, до кнопки не дотянуться", async () => {
    const player = renderPlayer({
      streamSettings: control({ menuTourSeen: true }),
    });
    await clickMenu();
    expect(menuShown()).toBe(true);

    setFullscreen(player.main());
    expect(screen.queryByRole("button", { name: "Меню" })).toBeNull();
    expect(menuShown()).toBe(false);

    // Вышли — кнопка вернулась, а панель, открытая до входа, сама не всплыла.
    setFullscreen(null);
    expect(menuButton()).toBeTruthy();
    expect(menuShown()).toBe(false);
  });

  it("на сенсорном экране без мыши «Меню» в полном экране остаётся", async () => {
    touchScreen();
    const player = renderPlayer({
      streamSettings: control({ menuTourSeen: true }),
    });
    setFullscreen(player.main());
    await clickMenu();
    expect(menuShown()).toBe(true);
  });

  it("in fullscreen a click on the game locks the pointer", () => {
    const player = renderPlayer({ streamSettings: control() });
    const frame = player.frame();
    const frameDoc = document.implementation.createHTMLDocument("stream");
    const element = frameDoc.createElement("div");
    const requestPointerLock = mock(async () => {});
    element.requestPointerLock = requestPointerLock;
    Object.defineProperty(frame, "contentDocument", { value: frameDoc });
    Object.defineProperty(frame, "contentWindow", {
      value: { webrtcInput: { element } },
    });

    // Документ без своего окна: `fireEvent` его не умеет — событие руками.
    const click = () =>
      frameDoc.body.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true }),
      );

    // В окне захвата нет — курсор как раньше.
    click();
    expect(requestPointerLock).not.toHaveBeenCalled();

    setFullscreen(player.main());
    click();
    expect(requestPointerLock).toHaveBeenCalledTimes(1);

    setFullscreen(null);
    click();
    expect(requestPointerLock).toHaveBeenCalledTimes(1);
  });

  it("entering fullscreen locks the pointer at once", async () => {
    const player = renderPlayer({ streamSettings: control() });
    const frame = player.frame();
    const frameDoc = document.implementation.createHTMLDocument("stream");
    const element = frameDoc.createElement("div");
    const requestPointerLock = mock(async () => {
      calls.push({ call: "requestPointerLock" });
    });
    element.requestPointerLock = requestPointerLock;
    Object.defineProperty(frame, "contentDocument", { value: frameDoc });
    Object.defineProperty(frame, "contentWindow", {
      value: { webrtcInput: { element }, focus: noop },
    });

    // Мышь — раньше полного экрана: Chrome тратит на него жест пользователя.
    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));
    await waitFor(() =>
      expect(calls.map((c) => c.call)).toEqual([
        "requestPointerLock",
        "requestFullscreen",
      ]),
    );

    // Полный экран запрещён — захваченная мышь отпускается.
    calls = [];
    const exitPointerLock = mock(() => {});
    Object.defineProperty(frameDoc, "pointerLockElement", {
      configurable: true,
      get: () => (calls.length > 0 ? element : null),
    });
    frameDoc.exitPointerLock = exitPointerLock;
    HTMLElement.prototype.requestFullscreen = async () => {
      throw new Error("denied");
    };
    fireEvent.click(screen.getByRole("button", { name: "На весь экран" }));
    await waitFor(() => expect(exitPointerLock).toHaveBeenCalledTimes(1));
  });

  it("«На весь экран» — второй строкой под меню", () => {
    renderPlayer({ streamSettings: control() });
    const menuRow = screen.getByTestId("menu-row");
    const fullscreenRow = screen.getByTestId("fullscreen-row");
    expect(menuRow.contains(menuButton())).toBe(true);
    expect(
      fullscreenRow.contains(
        screen.getByRole("button", { name: "На весь экран" }),
      ),
    ).toBe(true);
    expect(menuRow.nextElementSibling).toBe(fullscreenRow);
    expect(menuRow.parentElement?.classList.contains("flex-col")).toBe(true);
  });

  it("длинное название в шапке меню обрезается, а не распирает панель", async () => {
    const long = "The Legend of Zelda: Ocarina of Time — Master Quest Edition";
    renderPlayer({
      view: view({ gameName: long }),
      streamSettings: control({ menuTourSeen: true }),
    });
    await clickMenu();
    const name = screen.getByText(long);
    expect(name.classList.contains("truncate")).toBe(true);
    expect(name.classList.contains("min-w-0")).toBe(true);
    expect(name.getAttribute("title")).toBe(long);
    // Колонка сетки меню — шириной панели, а не по самому длинному тексту.
    const menu = name.parentElement?.parentElement as HTMLElement;
    expect(menu.classList.contains("grid-cols-1")).toBe(true);
  });

  it("keyboard switch toggles the local layout", async () => {
    const update = mock<Update>(() => {});
    renderPlayer({
      streamSettings: control({ menuTourSeen: true }, true, update),
    });
    await clickMenu();
    const layout = screen.getByRole("switch", {
      name: "Печатать на своей раскладке",
    });
    expect(layout.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(layout);
    expect(update).toHaveBeenCalledWith({ localLayout: true });
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

const tutorialHint = () =>
  screen.queryByRole("button", { name: /Играй на весь экран/ });
const stepTwo = () => screen.queryByText(/Чтобы выйти/);
const escBar = () => screen.queryByText(/чтобы выйти из полного экрана/);

/**
 * Окно iframe стрима: клавиши Esc приходят на него (фаза захвата `window` — первая на пути
 * события, там же их ловит Selkies). `focus` — чтобы `enterFullscreen` не падал.
 */
const frameWindow = (frame: HTMLIFrameElement) => {
  const win = Object.assign(new EventTarget(), { focus: noop });
  Object.defineProperty(frame, "contentWindow", { value: win });
  return win;
};

const escape = (
  target: EventTarget,
  type: "keydown" | "keyup",
  repeat = false,
) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent(type, {
        key: "Escape",
        code: "Escape",
        repeat,
        bubbles: true,
      }),
    );
  });

describe("обучение полному экрану", () => {
  it("шаг 1 — плашка у кнопки после загрузки настроек; клик по ней разворачивает", async () => {
    const update = mock<Update>(() => {});
    const player = renderPlayer({ streamSettings: control({}, false, update) });
    expect(tutorialHint()).toBeNull();

    player.rerenderWith({ streamSettings: control({}, true, update) });
    const hint = tutorialHint();
    expect(hint).toBeTruthy();
    expect(
      screen.getByTestId("fullscreen-row").contains(hint as HTMLElement),
    ).toBe(true);

    fireEvent.click(hint as HTMLElement);
    await waitFor(() =>
      expect(calls.map((c) => c.call)).toContain("requestFullscreen"),
    );
  });

  it("× на плашке — обучение пройдено", () => {
    const update = mock<Update>(() => {});
    renderPlayer({ streamSettings: control({}, true, update) });
    fireEvent.click(screen.getByRole("button", { name: "Скрыть подсказку" }));
    expect(update).toHaveBeenCalledWith({ fullscreenTutorialSeen: true });
  });

  it("пройденное обучение не показывается", () => {
    const player = renderPlayer({
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    expect(tutorialHint()).toBeNull();
    setFullscreen(player.main());
    expect(stepTwo()).toBeNull();
  });

  it("шаг 2 — при первом входе «зажми Esc», 6 с, и обучение пройдено", () => {
    jest.useFakeTimers();
    try {
      setKeyboard(keyboardStub());
      const update = mock<Update>(() => {});
      const player = renderPlayer({
        streamSettings: control({}, true, update),
      });
      setFullscreen(player.main());
      expect(update).toHaveBeenCalledWith({ fullscreenTutorialSeen: true });
      expect(stepTwo()?.textContent).toContain("зажми Esc");
      expect(tutorialHint()).toBeNull();

      // Признак записан — шаг 2 всё равно держится свои 6 с.
      player.rerenderWith({
        streamSettings: control({ fullscreenTutorialSeen: true }, true, update),
      });
      act(() => jest.advanceTimersByTime(5_000));
      expect(stepTwo()).toBeTruthy();
      act(() => jest.advanceTimersByTime(1_000));
      expect(stepTwo()).toBeNull();
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("шаг 2 уходит при выходе из полного экрана", () => {
    setKeyboard(keyboardStub());
    const player = renderPlayer({ streamSettings: control() });
    setFullscreen(player.main());
    expect(stepTwo()).toBeTruthy();
    setFullscreen(null);
    expect(stepTwo()).toBeNull();
  });

  it("без Keyboard Lock API — «нажми Esc», без шкалы", () => {
    setKeyboard(undefined);
    const player = renderPlayer({ streamSettings: control() });
    setFullscreen(player.main());
    expect(stepTwo()?.textContent).toContain("нажми Esc");
    expect(screen.queryByTestId("esc-progress")).toBeNull();
  });

  it("на сенсорном экране без мыши шага 2 нет, но обучение пройдено", () => {
    touchScreen();
    const update = mock<Update>(() => {});
    const player = renderPlayer({ streamSettings: control({}, true, update) });
    setFullscreen(player.main());
    expect(stepTwo()).toBeNull();
    expect(update).toHaveBeenCalledWith({ fullscreenTutorialSeen: true });
  });
});

describe("обучение после перерыва в игре", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  it("afterBreak: больше 14 дней — перерыв; не играл совсем — нет", () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    expect(afterBreak(null, now)).toBe(false);
    expect(afterBreak("2026-11-07T12:00:00.000Z", now)).toBe(false);
    expect(afterBreak("2026-11-06T11:00:00.000Z", now)).toBe(true);
  });

  it("пройденное обучение показывается снова после 15 дней без игры, но не после 13", () => {
    const shown = renderPlayer({
      view: view({ previousPlayedAt: ago(15) }),
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    expect(tutorialHint()).toBeTruthy();
    shown.unmount();

    renderPlayer({
      view: view({ previousPlayedAt: ago(13) }),
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    expect(tutorialHint()).toBeNull();
  });

  it("после перерыва — один раз за сессию, признак не перезаписывается", () => {
    setKeyboard(keyboardStub());
    const update = mock<Update>(() => {});
    const player = renderPlayer({
      view: view({ previousPlayedAt: ago(30) }),
      streamSettings: control({ fullscreenTutorialSeen: true }, true, update),
    });
    expect(tutorialHint()).toBeTruthy();

    setFullscreen(player.main());
    expect(stepTwo()?.textContent).toContain("зажми Esc");
    setFullscreen(null);
    expect(tutorialHint()).toBeNull();

    setFullscreen(player.main());
    expect(stepTwo()).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("× после перерыва убирает плашку до конца сессии", () => {
    const update = mock<Update>(() => {});
    renderPlayer({
      view: view({ previousPlayedAt: ago(30) }),
      streamSettings: control({ fullscreenTutorialSeen: true }, true, update),
    });
    fireEvent.click(screen.getByRole("button", { name: "Скрыть подсказку" }));
    expect(tutorialHint()).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("впервые: × убирает плашку сразу, не дожидаясь сохранения признака", () => {
    const update = mock<Update>(() => {});
    renderPlayer({ streamSettings: control({}, true, update) });
    fireEvent.click(screen.getByRole("button", { name: "Скрыть подсказку" }));
    expect(tutorialHint()).toBeNull();
    expect(update).toHaveBeenCalledWith({ fullscreenTutorialSeen: true });
  });
});

describe("полоска «Зажми Esc» в полном экране", () => {
  it("нажатие Esc в игре показывает полоску со шкалой; отпустили — уходит через 3 с", () => {
    jest.useFakeTimers();
    try {
      setKeyboard(keyboardStub());
      const player = renderPlayer({
        streamSettings: control({ fullscreenTutorialSeen: true }),
      });
      const win = frameWindow(player.frame());
      setFullscreen(player.main());
      expect(escBar()).toBeNull();

      escape(win, "keydown");
      expect(escBar()).toBeTruthy();
      const progress = screen.getByTestId("esc-progress");
      expect(progress.style.animation).toContain("gc-fill 1500ms");

      escape(win, "keyup");
      expect(screen.getByTestId("esc-progress").style.animation).toBe("");
      act(() => jest.advanceTimersByTime(2_900));
      expect(escBar()).toBeTruthy();
      act(() => jest.advanceTimersByTime(100));
      expect(escBar()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("Selkies гасит Esc на окне iframe — полоска всё равно появляется", () => {
    setKeyboard(keyboardStub());
    const player = renderPlayer({
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    const win = frameWindow(player.frame());
    // Как `selkies-core.js`: слушатель окна в фазе захвата, подписан раньше нашего.
    const selkies = (event: Event) => event.stopPropagation();
    win.addEventListener("keydown", selkies, true);
    win.addEventListener("keyup", selkies, true);
    fireEvent.load(player.frame());
    setFullscreen(player.main());

    escape(win, "keydown");
    expect(screen.getByTestId("esc-progress").style.animation).toContain(
      "gc-fill",
    );
    escape(win, "keyup");
    expect(screen.getByTestId("esc-progress").style.animation).toBe("");
  });

  it("Esc в окне страницы тоже показывает полоску и заменяет шаг 2", () => {
    setKeyboard(keyboardStub());
    const player = renderPlayer({ streamSettings: control() });
    frameWindow(player.frame());
    setFullscreen(player.main());
    expect(stepTwo()).toBeTruthy();
    escape(document.body, "keydown");
    expect(escBar()).toBeTruthy();
    expect(stepTwo()).toBeNull();
  });

  it("новое нажатие запускает шкалу заново, автоповтор — нет", () => {
    setKeyboard(keyboardStub());
    const player = renderPlayer({
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    const win = frameWindow(player.frame());
    setFullscreen(player.main());
    escape(win, "keydown");
    const first = screen.getByTestId("esc-progress");
    escape(win, "keydown", true);
    expect(screen.getByTestId("esc-progress")).toBe(first);
    escape(win, "keyup");
    escape(win, "keydown");
    expect(screen.getByTestId("esc-progress")).not.toBe(first);
  });

  it("вне полного экрана и без Keyboard Lock API полоски нет", () => {
    setKeyboard(keyboardStub());
    const player = renderPlayer({
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    const win = frameWindow(player.frame());
    escape(win, "keydown");
    expect(escBar()).toBeNull();

    setKeyboard(undefined);
    setFullscreen(player.main());
    escape(win, "keydown");
    expect(escBar()).toBeNull();
  });

  it("выход из полного экрана убирает полоску", () => {
    setKeyboard(keyboardStub());
    const player = renderPlayer({
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    const win = frameWindow(player.frame());
    setFullscreen(player.main());
    escape(win, "keydown");
    expect(escBar()).toBeTruthy();
    setFullscreen(null);
    expect(escBar()).toBeNull();
  });
});

const tourCallout = () => screen.queryByTestId("menu-tour");
/** Раздел меню по заголовку — чтобы проверить подсветку и приглушение. */
const section = (title: string) =>
  screen.getByRole("heading", { name: title }).closest("section");

describe("шаг 3 обучения: подсказка у меню и обход его разделов", () => {
  it("подсказка у меню — только после входа и выхода из полного экрана", () => {
    setKeyboard(keyboardStub());
    const player = renderPlayer({ streamSettings: control() });
    expect(tutorialHint()).toBeTruthy();
    expect(hintShown()).toBe(false);

    setFullscreen(player.main());
    expect(hintShown()).toBe(false);
    setFullscreen(null);
    expect(hintShown()).toBe(true);
  });

  it("× на шаге 1 — подсказка у меню сразу", () => {
    renderPlayer({ streamSettings: control() });
    fireEvent.click(screen.getByRole("button", { name: "Скрыть подсказку" }));
    expect(hintShown()).toBe(true);
  });

  it("обучение полному экрану пройдено раньше — подсказка сразу; обход пройден — её нет", () => {
    const shown = renderPlayer({
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    expect(hintShown()).toBe(true);
    shown.unmount();

    renderPlayer({
      streamSettings: control({
        fullscreenTutorialSeen: true,
        menuTourSeen: true,
      }),
    });
    expect(hintShown()).toBe(false);
  });

  it("обход: четыре раздела по очереди, остальные приглушены, «Понятно» — конец", async () => {
    renderPlayer({ streamSettings: control({ fullscreenTutorialSeen: true }) });
    await clickMenu();

    const steps: Array<[string, RegExp]> = [
      ["Качество", /подстраивается под сеть/],
      ["Клавиатура", /Пишешь в чат по-русски/],
      ["Мышь", /Камера не крутится/],
    ];
    for (const [index, [title, text]] of steps.entries()) {
      const callout = tourCallout() as HTMLElement;
      expect(callout.textContent).toMatch(text);
      expect(callout.textContent).toContain(`${index + 1} из 4`);
      expect(section(title)?.contains(callout)).toBe(true);
      expect(section(title)?.classList.contains("opacity-40")).toBe(false);
      expect(section("Отладка")?.classList.contains("opacity-40")).toBe(true);
      const next = screen.getByRole("button", { name: "Дальше" });
      expect(document.activeElement).toBe(next);
      fireEvent.click(next);
    }

    const last = tourCallout() as HTMLElement;
    expect(last.textContent).toContain("сохранения останутся");
    expect(last.textContent).toContain("4 из 4");
    const endGame = screen.getByRole("button", { name: "Закончить игру" });
    expect(endGame.parentElement?.contains(last)).toBe(true);
    expect(screen.queryByRole("button", { name: "Пропустить" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(tourCallout()).toBeNull();
    expect(section("Отладка")?.classList.contains("opacity-40")).toBe(false);
    expect(menuShown()).toBe(true);
  });

  it("«Пропустить» заканчивает обход; закрыли меню посреди — больше не показывается", async () => {
    const shown = renderPlayer({
      streamSettings: control({ fullscreenTutorialSeen: true }),
    });
    await clickMenu();
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    expect(tourCallout()).toBeNull();
    shown.unmount();

    renderPlayer({ streamSettings: control({ fullscreenTutorialSeen: true }) });
    await clickMenu();
    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    await clickMenu(); // закрыть посреди
    // Фокус в стрим Radix возвращает таймером после закрытия — открываем, когда он вернулся.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    await clickMenu();
    expect(menuShown()).toBe(true);
    expect(tourCallout()).toBeNull();
  });

  it("пройденный обход при открытии меню не показывается", async () => {
    renderPlayer({
      streamSettings: control({
        fullscreenTutorialSeen: true,
        menuTourSeen: true,
      }),
    });
    await clickMenu();
    expect(menuShown()).toBe(true);
    expect(tourCallout()).toBeNull();
  });

  it("после перерыва — подсказка и обход снова, признаки не перезаписываются", async () => {
    const update = mock<Update>(() => {});
    const ago30 = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    renderPlayer({
      view: view({ previousPlayedAt: ago30 }),
      streamSettings: control(
        { fullscreenTutorialSeen: true, menuTourSeen: true },
        true,
        update,
      ),
    });
    expect(hintShown()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Скрыть подсказку" }));
    expect(hintShown()).toBe(true);

    await clickMenu();
    expect(tourCallout()).toBeTruthy();
    expect(hintShown()).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
