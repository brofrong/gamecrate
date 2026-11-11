// `QueueWatcher` (спека §5, бриф задачи 11): пока есть активная сессия — heartbeat
// `queueOnly` раз в 5 с (сервер учтёт его только пока сессия `queued`); при переходе
// `queued → другое`, если вкладка скрыта, короткий сигнал и уведомление браузера.
//
// `../src/rpc` открывает реальный WebSocket, поэтому он подменяется целиком через
// `mock.module` (как в `myGamesPage.test.tsx`) — `rpcStub()` даёт все имена настоящего
// модуля, поверх — свои атомы этого файла.
import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import type { SessionState, SessionView } from "@cg/rpc";
import { act, render } from "@testing-library/react";
import { RegistryProvider, useAtomSet } from "@effect/atom-react";
import { Effect } from "effect";
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

const activeSessionAtom = Atom.make(
  AsyncResult.initial<SessionView | null, { readonly _tag: string }>(),
);
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

afterEach(() => {
  heartbeatCalls = [];
  delete (globalThis as { Notification?: unknown }).Notification;
});

describe("QueueWatcher", () => {
  it("sends a queueOnly heartbeat every 5 s while a session is active", () => {
    jest.useFakeTimers();
    try {
      render(
        <RegistryProvider
          initialValues={[
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

  it("notifies when the session leaves queued while the tab is hidden", () => {
    const originalHidden = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "hidden",
    );
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });

    const requestPermission = mock(
      async (): Promise<NotificationPermission> => "granted",
    );
    const notifyCtor = mock(function FakeNotification(_title: string) {});
    (globalThis as { Notification?: unknown }).Notification = Object.assign(
      notifyCtor,
      { permission: "granted" as NotificationPermission, requestPermission },
    );

    const apiRef: { set?: (v: SessionView) => void } = {};
    try {
      render(
        <RegistryProvider
          initialValues={[
            [activeSessionAtom, AsyncResult.success(view("queued"))],
            [
              sessionWatchAtom(sessionId),
              AsyncResult.success(view("queued")),
            ],
          ]}
        >
          <Driver apiRef={apiRef} />
        </RegistryProvider>,
      );

      act(() => apiRef.set?.(view("starting")));

      expect(notifyCtor).toHaveBeenCalledWith(
        "Сервер готов — возвращайтесь в игру",
      );
    } finally {
      if (originalHidden) {
        Object.defineProperty(document, "hidden", originalHidden);
      }
    }
  });

  it("does not notify when the tab is visible, or when leaving a non-queued state", () => {
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    const notifyCtor = mock(function FakeNotification(_title: string) {});
    (globalThis as { Notification?: unknown }).Notification = Object.assign(
      notifyCtor,
      { permission: "granted" as NotificationPermission },
    );

    const apiRef: { set?: (v: SessionView) => void } = {};
    render(
      <RegistryProvider
        initialValues={[
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
});
