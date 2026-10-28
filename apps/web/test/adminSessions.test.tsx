// Вкладка «Сессии» (`/admin?tab=sessions`, Task 6): «Сейчас идут» со столбцом «Воркер»
// и пустым состоянием, «История за 7 дней» с переключателем «Только сбои» (у сбоя —
// причина красным бейджем, тумблер переключается туда и обратно).
//
// `../src/rpc` подменяется целиком (см. комментарий в `appPages.test.tsx` про
// `mock.module`). `adminSessionsAtom` — семейный атом (`Atom.family`), поэтому для него,
// как для `timeSummaryAtom` в `appPages.test.tsx`, нужен `Atom.keepAlive`: без него узел
// для `failedOnly: true` (который тест засевает заранее, пока вкладка показывает
// `failedOnly: false`) снимается сразу после монтажа без подписчика, и засеянное
// значение пропадает до переключения тумблера.
//
// Отдельный тест ниже (`polls the shared...`) — регрессия на баг «двойного опроса»:
// «Сейчас идут» и «История» при `failedOnly: false` читают один и тот же атом
// (`adminSessionsAtom(false)`), и раньше оба ставили свой `setInterval(…, 5000)` на
// него же — тот же атом опрашивался дважды в 5 с. Спайим `setInterval`/`clearInterval`
// тем же приёмом, что и тест 30-секундного опроса в `appPages.test.tsx`: перехватываем
// только вызовы с `timeout === 5000` (`usePolling`'s default), остальные — настоящим
// таймерам (их использует сама `@testing-library` внутри `findByText`/`waitFor`).
import { describe, expect, it, mock, spyOn } from "bun:test";
import type { AdminSession, CurrentUserShape } from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Cause, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";

/** Элемент `initialValues` у `RegistryProvider` — без своего `any` в этом файле. */
type InitialValue =
  NonNullable<
    Parameters<typeof RegistryProvider>[0]["initialValues"]
  > extends Iterable<infer T>
    ? T
    : never;

type SessionsList = { active: AdminSession[]; recent: AdminSession[] };

const meAtom = Atom.make(
  AsyncResult.initial<CurrentUserShape, { readonly _tag: string }>(),
);
const adminPingAtom = Atom.make(
  AsyncResult.success<"pong", { readonly _tag: string }>("pong"),
);
// `keepAlive` — см. комментарий в начале файла.
const adminSessionsAtom = Atom.family((_failedOnly: boolean) =>
  Atom.keepAlive(
    Atom.make(AsyncResult.initial<SessionsList, { readonly _tag: string }>()),
  ),
);
const adminWorkersAtom = Atom.make(AsyncResult.initial());
const sessionSettingsAtom = Atom.make(AsyncResult.initial());
const adminStopSessionAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed(true),
);
const adminSetDrainingAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed(true),
);
const updateSessionSettingsAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed(undefined),
);

const errorTag = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.getOrUndefined(
    Option.map(Cause.findErrorOption(cause), (error) => error._tag),
  );
const resultErrorTag = <A, E extends { readonly _tag: string }>(
  result: AsyncResult.AsyncResult<A, E>,
) => (AsyncResult.isFailure(result) ? errorTag(result.cause) : undefined);

mock.module("../src/rpc", () => ({
  meAtom,
  adminPingAtom,
  adminSessionsAtom,
  adminStopSessionAtom,
  adminStopSessionArgs: (sessionId: string) => ({
    payload: { sessionId },
    reactivityKeys: ["admin"],
  }),
  adminWorkersAtom,
  adminSetDrainingAtom,
  adminSetDrainingArgs: (workerId: string, draining: boolean) => ({
    payload: { workerId, draining },
    reactivityKeys: ["admin"],
  }),
  sessionSettingsAtom,
  updateSessionSettingsAtom,
  updateSessionSettingsArgs: (payload: unknown) => ({
    payload,
    reactivityKeys: ["settings"],
  }),
  errorTag,
  resultErrorTag,
}));

const { adminRoute } = await import("../src/routes/admin");
const { rootRoute } = await import("../src/routes/__root");

const admin: CurrentUserShape = {
  id: "u1",
  name: "Админ",
  image: null,
  role: "admin",
  steamId: null,
  email: "admin@example.com",
  emailVerified: true,
};

const session = (
  patch: Partial<AdminSession> & { id: string },
): AdminSession => ({
  userId: "u2",
  userName: "Игрок",
  appId: 1,
  gameName: "Hades",
  workerId: null,
  slot: null,
  state: "playing",
  stage: null,
  createdAt: new Date("2026-10-27T10:00:00Z").toISOString(),
  endedAt: null,
  lastInputAt: null,
  failReason: null,
  ...patch,
});

const routeTree = rootRoute.addChildren([adminRoute]);

function renderSessions(sessions: {
  unfiltered: SessionsList;
  failedOnly?: SessionsList;
}) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: ["/admin?tab=sessions"],
    }),
  });
  const initialValues: Array<InitialValue> = [
    [meAtom, AsyncResult.success(admin)],
    [adminSessionsAtom(false), AsyncResult.success(sessions.unfiltered)],
  ];
  if (sessions.failedOnly !== undefined) {
    initialValues.push([
      adminSessionsAtom(true),
      AsyncResult.success(sessions.failedOnly),
    ]);
  }
  return render(
    <RegistryProvider initialValues={initialValues}>
      <RouterProvider router={router} />
    </RegistryProvider>,
  );
}

describe("SessionsTab", () => {
  it("shows active sessions with the worker column", async () => {
    const active = session({
      id: "s1",
      userName: "Вася",
      gameName: "Hades",
      workerId: "brofrong",
      state: "playing",
    });
    renderSessions({ unfiltered: { active: [active], recent: [] } });

    expect(await screen.findByText("Сейчас идут")).toBeTruthy();
    expect(screen.getByText("Вася")).toBeTruthy();
    expect(screen.getByText("brofrong")).toBeTruthy();
  });

  it("shows the empty state when no one is playing", async () => {
    renderSessions({ unfiltered: { active: [], recent: [] } });
    expect(
      await screen.findByText("Сейчас никто не играет"),
    ).toBeTruthy();
  });

  it("shows the unfiltered empty-history message", async () => {
    renderSessions({ unfiltered: { active: [], recent: [] } });
    expect(
      await screen.findByText("За 7 дней сессий не было"),
    ).toBeTruthy();
  });

  it("filters history to only failed sessions and back, with the reason as a red badge", async () => {
    const ended = session({
      id: "s2",
      userName: "Петя",
      gameName: "Portal 2",
      state: "ended",
      endedAt: new Date("2026-10-26T12:00:00Z").toISOString(),
    });
    const failed = session({
      id: "s3",
      userName: "Коля",
      gameName: "Dota 2",
      state: "failed",
      endedAt: new Date("2026-10-26T13:00:00Z").toISOString(),
      failReason: "Не удалось остановить игровой сервер",
    });
    renderSessions({
      unfiltered: { active: [], recent: [ended, failed] },
      failedOnly: { active: [], recent: [failed] },
    });

    expect(await screen.findByText("История за 7 дней")).toBeTruthy();
    expect(screen.getByText("Петя")).toBeTruthy();
    expect(screen.getByText("Коля")).toBeTruthy();

    const toggle = screen.getByRole("button", { name: "Только сбои" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);

    expect(
      await screen.findByText("Не удалось остановить игровой сервер"),
    ).toBeTruthy();
    expect(screen.getByText("Коля")).toBeTruthy();
    expect(screen.queryByText("Петя")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    // Назад: тумблер выключен — снова обе строки, реакция на отключённый фильтр.
    fireEvent.click(toggle);
    expect(await screen.findByText("Петя")).toBeTruthy();
    expect(screen.getByText("Коля")).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("polls the shared active/history request only once (regression: it used to poll twice)", async () => {
    // Приёмы те же, что у «sets up a 30s setInterval...» в `appPages.test.tsx`: свой
    // узкий интерфейс вместо перегрузок DOM/Node/Bun, перехват только нужного таймаута,
    // остальное — настоящим таймерам (их использует сама testing-library).
    interface IntervalGlobals {
      setInterval(handler: () => void, timeout?: number): number;
      clearInterval(id?: number): void;
    }
    const globals = globalThis as unknown as IntervalGlobals;
    const realSetInterval = globals.setInterval.bind(globals);
    const realClearInterval = globals.clearInterval.bind(globals);
    const pollIntervalId = 555_555;
    let pollSetupCalls = 0;

    const setIntervalSpy = spyOn(globals, "setInterval").mockImplementation(
      (handler, timeout) => {
        if (timeout === 5000) {
          pollSetupCalls += 1;
          return pollIntervalId;
        }
        return realSetInterval(handler, timeout);
      },
    );
    const clearIntervalSpy = spyOn(globals, "clearInterval").mockImplementation(
      (id) => {
        if (id !== pollIntervalId) realClearInterval(id);
      },
    );

    try {
      renderSessions({ unfiltered: { active: [], recent: [] } });
      expect(await screen.findByText("Сейчас никто не играет")).toBeTruthy();

      // «Сейчас идут» и «История» (не отфильтрованная) читают один и тот же атом —
      // должен стоять ровно один `setInterval(…, 5000)`, не два.
      expect(pollSetupCalls).toBe(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
