// `QueueWatcher` (спека §5, бриф задачи 11): пока есть активная сессия — heartbeat
// `queueOnly` раз в 5 с (сервер учтёт его только пока сессия `queued`); при переходе
// `queued → starting/playing/idle_warning` (сервер и правда запустил сессию), если
// вкладка скрыта, короткий сигнал и уведомление браузера. Переход в `ended`/`failed`
// (вышел из очереди по таймауту, отмена из другой вкладки) и в `installing` (сессия
// вернётся в очередь после установки) — не «сервер готов»: ревью задачи 11, раунд 1,
// нашло ложное уведомление «Сервер готов» ровно на `queued → ended`.
//
// `../src/rpc` открывает реальный WebSocket, поэтому он подменяется целиком через
// `mock.module` (как в `myGamesPage.test.tsx`) — `rpcStub()` даёт все имена настоящего
// модуля, поверх — свои атомы этого файла.
import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import type { SessionState, SessionView } from "@cg/rpc";
import { act, render } from "@testing-library/react";
import { RegistryProvider, useAtomSet } from "@effect/atom-react";
import { Cause, Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { rpcStub } from "./moduleStubs";

const sessionId = "0b5c1a52-7f4e-4f1e-9a43-3c1d2e5f6a7b";

const view = (state: SessionState, patch: Partial<SessionView> = {}): SessionView => ({
  id: sessionId,
  appId: 620,
  gameName: "Portal 2",
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
  previousPlayedAt: null,
  createdAt: "2026-11-11T10:00:00.000Z",
  queue: null,
  limit: null,
  ...patch,
});

type Active = AsyncResult.AsyncResult<SessionView | null, { readonly _tag: string }>;
/**
 * `session.active`: начальное значение задаёт `initialValues`, а перезапрос
 * (`useAtomRefresh` → `invalidate`) заново зовёт `read` — он считает перезапросы и
 * отдаёт то, что тест положил в `activeOnRefetch` (сервер после конца сессии).
 */
let activeReads = 0;
let activeOnRefetch: Active = AsyncResult.initial();
const activeSessionAtom = Atom.writable(
  (): Active => {
    activeReads += 1;
    return activeOnRefetch;
  },
  (ctx, value: Active) => ctx.setSelf(value),
);
/** `auth.me`: QueueWatcher работает только для вошедшего пользователя (M6). */
const meAtom = Atom.make<
  AsyncResult.AsyncResult<{ readonly id: string }, { readonly _tag: string }>
>(AsyncResult.initial());
const signedIn = [meAtom, AsyncResult.success({ id: "u1" })] as const;
// Явный аргумент типа — иначе `Atom.make` вывел бы по значению только
// `Initial<...>`, и `Driver` не смог бы записать туда `AsyncResult.success`.
const sessionWatchAtom = Atom.family((_id: string) =>
  Atom.make<AsyncResult.AsyncResult<SessionView, { readonly _tag: string }>>(
    AsyncResult.initial(),
  ),
);

type HeartbeatPayload = {
  readonly sessionId: string;
  readonly inputAgeMs: number;
  readonly queueOnly?: boolean;
};
let heartbeatCalls: Array<HeartbeatPayload> = [];
const heartbeatAtom = Atom.fn(
  (arg: { readonly payload: HeartbeatPayload }) => {
    heartbeatCalls.push(arg.payload);
    return Effect.succeed(undefined);
  },
);

mock.module("../src/rpc", () => ({
  ...rpcStub(),
  meAtom,
  activeSessionAtom,
  sessionWatchAtom,
  heartbeatAtom,
}));

const { QueueWatcher } = await import("../src/components/QueueWatcher");

/** Позволяет тесту двигать `session.watch` вручную — тот же приём, что требует push из потока. */
function Driver({
  apiRef,
}: {
  apiRef: { set?: (v: SessionView) => void };
}) {
  const setView = useAtomSet(sessionWatchAtom(sessionId));
  apiRef.set = (v: SessionView) => setView(AsyncResult.success(v));
  return <QueueWatcher />;
}

/** Разрешение дано, конструктор считает, сколько раз показали уведомление. */
function stubNotification(): { readonly ctor: ReturnType<typeof mock> } {
  const ctor = mock(function FakeNotification(_title: string) {});
  (globalThis as { Notification?: unknown }).Notification = Object.assign(
    ctor,
    { permission: "granted" as NotificationPermission },
  );
  return { ctor };
}

/** Фейковый `AudioContext`: `calls` считает, сколько раз его создали (сигнал сыграл). */
function stubAudioContext(): { calls: number } {
  const state = { calls: 0 };
  class FakeOscillator {
    frequency = { value: 0 };
    onended: (() => void) | null = null;
    connect() {}
    start() {}
    stop() {}
  }
  class FakeGain {
    gain = { value: 0 };
    connect() {}
  }
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    constructor() {
      state.calls += 1;
    }
    createOscillator() {
      return new FakeOscillator();
    }
    createGain() {
      return new FakeGain();
    }
    close() {
      return Promise.resolve();
    }
  }
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  return state;
}

const originalHidden = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "hidden",
);

afterEach(() => {
  heartbeatCalls = [];
  activeReads = 0;
  activeOnRefetch = AsyncResult.initial();
  delete (globalThis as { Notification?: unknown }).Notification;
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
});

describe("QueueWatcher", () => {
  it("sends a queueOnly heartbeat every 5 s while a session is active", () => {
    jest.useFakeTimers();
    try {
      render(
        <RegistryProvider
          initialValues={[
            signedIn,
            [activeSessionAtom, AsyncResult.success(view("queued"))],
            [sessionWatchAtom(sessionId), AsyncResult.success(view("queued"))],
          ]}
        >
          <QueueWatcher />
        </RegistryProvider>,
      );
      act(() => jest.advanceTimersByTime(0));
      expect(heartbeatCalls).toEqual([
        { sessionId, inputAgeMs: 0, queueOnly: true },
      ]);

      act(() => jest.advanceTimersByTime(5_000));
      expect(heartbeatCalls.length).toBe(2);
      act(() => jest.advanceTimersByTime(10_000));
      expect(heartbeatCalls.length).toBe(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it("sends nothing without an active session", () => {
    jest.useFakeTimers();
    try {
      render(
        <RegistryProvider
          initialValues={[
            signedIn,
            [activeSessionAtom, AsyncResult.success(null)],
          ]}
        >
          <QueueWatcher />
        </RegistryProvider>,
      );
      act(() => jest.advanceTimersByTime(20_000));
      expect(heartbeatCalls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("notifies when the session leaves queued to starting while the tab is hidden", () => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    const { ctor: notifyCtor } = stubNotification();

    const apiRef: { set?: (v: SessionView) => void } = {};
    render(
      <RegistryProvider
        initialValues={[
            signedIn,
          [activeSessionAtom, AsyncResult.success(view("queued"))],
          [sessionWatchAtom(sessionId), AsyncResult.success(view("queued"))],
        ]}
      >
        <Driver apiRef={apiRef} />
      </RegistryProvider>,
    );

    act(() => apiRef.set?.(view("starting")));

    expect(notifyCtor).toHaveBeenCalledWith(
      "Сервер готов — возвращайтесь в игру",
    );
  });

  it("does not notify when the tab is visible, even leaving to a running state", () => {
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    const { ctor: notifyCtor } = stubNotification();

    const apiRef: { set?: (v: SessionView) => void } = {};
    render(
      <RegistryProvider
        initialValues={[
            signedIn,
          [activeSessionAtom, AsyncResult.success(view("queued"))],
          [sessionWatchAtom(sessionId), AsyncResult.success(view("queued"))],
        ]}
      >
        <Driver apiRef={apiRef} />
      </RegistryProvider>,
    );

    act(() => apiRef.set?.(view("starting")));
    expect(notifyCtor).not.toHaveBeenCalled();

    act(() => apiRef.set?.(view("playing")));
    expect(notifyCtor).not.toHaveBeenCalled();
  });

  it("queued → ended while hidden: no notification and no chime (left the queue, not server ready)", () => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    const { ctor: notifyCtor } = stubNotification();
    const audio = stubAudioContext();

    const apiRef: { set?: (v: SessionView) => void } = {};
    render(
      <RegistryProvider
        initialValues={[
            signedIn,
          [activeSessionAtom, AsyncResult.success(view("queued"))],
          [sessionWatchAtom(sessionId), AsyncResult.success(view("queued"))],
        ]}
      >
        <Driver apiRef={apiRef} />
      </RegistryProvider>,
    );

    act(() =>
      apiRef.set?.(view("ended", { failReason: "Вы вышли из очереди" })),
    );

    expect(notifyCtor).not.toHaveBeenCalled();
    expect(audio.calls).toBe(0);
  });

  it("queued → installing: no notification and no chime (returns to the queue afterwards)", () => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    const { ctor: notifyCtor } = stubNotification();
    const audio = stubAudioContext();

    const apiRef: { set?: (v: SessionView) => void } = {};
    render(
      <RegistryProvider
        initialValues={[
            signedIn,
          [activeSessionAtom, AsyncResult.success(view("queued"))],
          [sessionWatchAtom(sessionId), AsyncResult.success(view("queued"))],
        ]}
      >
        <Driver apiRef={apiRef} />
      </RegistryProvider>,
    );

    act(() => apiRef.set?.(view("installing")));

    expect(notifyCtor).not.toHaveBeenCalled();
    expect(audio.calls).toBe(0);
  });

  it("after the watched session turns terminal: re-fetches session.active and stops heartbeating it", () => {
    jest.useFakeTimers();
    try {
      const apiRef: { set?: (v: SessionView) => void } = {};
      render(
        <RegistryProvider
          initialValues={[
            signedIn,
            [activeSessionAtom, AsyncResult.success(view("playing"))],
            [sessionWatchAtom(sessionId), AsyncResult.success(view("playing"))],
          ]}
        >
          <Driver apiRef={apiRef} />
        </RegistryProvider>,
      );
      act(() => jest.advanceTimersByTime(0));
      expect(heartbeatCalls.length).toBe(1);
      const readsBefore = activeReads;

      // Сервер после конца сессии: активной нет.
      activeOnRefetch = AsyncResult.success(null);
      act(() =>
        apiRef.set?.(view("ended", { failReason: "Часы закончились" })),
      );
      act(() => jest.advanceTimersByTime(0));
      expect(activeReads).toBeGreaterThan(readsBefore);

      const beatsAtEnd = heartbeatCalls.length;
      act(() => jest.advanceTimersByTime(20_000));
      expect(heartbeatCalls.length).toBe(beatsAtEnd);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does nothing for a signed-out visitor, even with an active session cached", () => {
    jest.useFakeTimers();
    try {
      render(
        <RegistryProvider
          initialValues={[
            [meAtom, AsyncResult.failure(Cause.fail({ _tag: "Unauthorized" }))],
            [activeSessionAtom, AsyncResult.success(view("queued"))],
          ]}
        >
          <QueueWatcher />
        </RegistryProvider>,
      );
      act(() => jest.advanceTimersByTime(20_000));
      expect(heartbeatCalls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("QueueWatcher in the desktop app", () => {
  const setBridge = () => {
    const invoke = mock(async (_cmd: string, _args?: unknown) => undefined);
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
    return invoke;
  };

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  const renderQueued = (initial: SessionView) => {
    const apiRef: { set?: (v: SessionView) => void } = {};
    const rendered = render(
      <RegistryProvider
        initialValues={[
          signedIn,
          [activeSessionAtom, AsyncResult.success(initial)],
          [sessionWatchAtom(sessionId), AsyncResult.success(initial)],
        ]}
      >
        <Driver apiRef={apiRef} />
      </RegistryProvider>,
    );
    return { apiRef, ...rendered };
  };

  it("server ready while the window is hidden: system notification via the app, not new Notification", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const { ctor: notifyCtor } = stubNotification();
    const invoke = setBridge();
    const { apiRef } = renderQueued(view("queued"));

    act(() => apiRef.set?.(view("starting")));

    expect(invoke).toHaveBeenCalledWith("notify", {
      title: "Сервер готов — возвращайтесь в игру",
      body: "Portal 2",
    });
    expect(notifyCtor).not.toHaveBeenCalled();
  });

  it("server ready while the window is visible but another app is focused: notifies", () => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    const hasFocus = spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      const invoke = setBridge();
      const { apiRef } = renderQueued(view("queued"));
      act(() => apiRef.set?.(view("playing")));
      expect(invoke.mock.calls.some(([cmd]) => cmd === "notify")).toBe(true);
    } finally {
      hasFocus.mockRestore();
    }
  });

  it("server ready while the player looks at the window: no notification", () => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    const hasFocus = spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      const invoke = setBridge();
      const { apiRef } = renderQueued(view("queued"));
      act(() => apiRef.set?.(view("starting")));
      expect(invoke.mock.calls.some(([cmd]) => cmd === "notify")).toBe(false);
    } finally {
      hasFocus.mockRestore();
    }
  });

  it("queue position changes go to the tray via set_status", () => {
    const invoke = setBridge();
    const { apiRef } = renderQueued(
      view("queued", { queue: { position: 3, total: 5, etaMinutes: 4 } }),
    );
    act(() =>
      apiRef.set?.(
        view("queued", { queue: { position: 2, total: 5, etaMinutes: 3 } }),
      ),
    );

    expect(invoke).toHaveBeenCalledWith("set_status", {
      status: { kind: "queued", position: 3, total: 5, etaMinutes: 4 },
    });
    expect(invoke).toHaveBeenCalledWith("set_status", {
      status: { kind: "queued", position: 2, total: 5, etaMinutes: 3 },
    });
  });

  it("leaving the queue for good resets the tray to idle", () => {
    const invoke = setBridge();
    const { apiRef } = renderQueued(view("queued"));
    act(() => apiRef.set?.(view("ended", { failReason: "Вы вышли из очереди" })));
    expect(invoke).toHaveBeenLastCalledWith("set_status", {
      status: { kind: "idle" },
    });
  });
});
