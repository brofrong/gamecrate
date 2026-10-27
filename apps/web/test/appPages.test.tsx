// «В тренде», «Из ящика», «Время» (`/app/trending`, `/app/crate`, `/app/time`, Task 12):
// секции тренда с подписями числа игроков, заглушка «Из ящика», сводка месяца
// с переключателем, долями по играм и лентой сессий (с «показать ещё N»).
//
// `../src/rpc` открывает реальный WebSocket, поэтому он подменяется целиком через
// `mock.module` — как в `myGamesPage.test.tsx` (см. его комментарий к `mock.module`
// про то, что подмена общая на весь прогон `bun test`, но каждый файл всё равно
// получает свой собственный граф модулей при собственном динамическом `import()`,
// так что атомы `myGamesPage.test.tsx` и этого файла не пересекаются).
//
// `trendingAtom` в этом файле — обычный писуемый атом (`Atom.make`), поэтому
// `registry.refresh` (который зовёт `useAtomRefresh`) не умеет пересчитать его из
// сети — он просто восстанавливает значение, с которым атом был создан (так
// работает `invalidate()` для не-эффектного атома), отбрасывая то, что до этого
// задал `RegistryProvider` через `initialValues`. Тест на 30-секундный опрос
// («requeries trending...») использует это намеренно: «после» зашито в сам атом,
// «до» приходит через `initialValues`. Сам интервал там же проверяется через
// `spyOn(globalThis, "setInterval"/"clearInterval")` — без фейковых таймеров:
// связка bun + React 19 + `act()` + `jest.useFakeTimers()` однажды дала
// интервалу сработать на 1 мс раньше срока (воспроизвели на синтетическом
// компоненте без атомов — баг самой связки, не этого кода), так что фейковый
// таймер здесь не нужен — важно, с каким `timeout` вызван `setInterval` и что
// `clearInterval` снимает ровно этот `id` при размонтировании.
import { describe, expect, it, mock, spyOn } from "bun:test";
import type {
  CurrentUserShape,
  SessionView,
  TimeSummary,
  TrendingEntry,
} from "@cg/rpc";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Cause, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";
import { currentMonth, formatMonth, monthShift } from "../src/lib/formatTime";

/** Элемент `initialValues` у `RegistryProvider` — без своего `any` в этом файле. */
type InitialValue =
  NonNullable<
    Parameters<typeof RegistryProvider>[0]["initialValues"]
  > extends Iterable<infer T>
    ? T
    : never;

const trendingEntry = (
  patch: Partial<TrendingEntry> & { appId: number; name: string },
): TrendingEntry => ({
  coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${patch.appId}/header.jpg`,
  cloud: { _tag: "Missing" },
  players: 0,
  inLibrary: true,
  ...patch,
});

/** Зашитое в `trendingAtom` значение «после перезапроса» — см. комментарий выше. */
const AFTER_REFRESH = {
  now: [
    trendingEntry({
      appId: 99,
      name: "After Refresh Game",
      players: 4,
      inLibrary: true,
    }),
  ],
  week: [],
};

const meAtom = Atom.make(
  AsyncResult.initial<CurrentUserShape, { readonly _tag: string }>(),
);
const libraryAtom = Atom.make(AsyncResult.initial());
const recentAtom = Atom.make(AsyncResult.initial());
const activeSessionAtom = Atom.make(
  AsyncResult.initial<SessionView | null, { readonly _tag: string }>(),
);
const providersAtom = Atom.make(AsyncResult.initial());
const trendingAtom = Atom.make(
  AsyncResult.success<
    { now: TrendingEntry[]; week: TrendingEntry[] },
    { readonly _tag: string }
  >(AFTER_REFRESH),
);
const adminPingAtom = Atom.make(AsyncResult.initial());
const sessionSettingsAtom = Atom.make(AsyncResult.initial());
// `keepAlive`: без подписчика (пока пользователь не переключил месяц) узел
// семейного атома иначе снимается сразу после монтажа (без подписки на него),
// и `initialValues`, которым тест заранее засевает соседний месяц, пропадает
// до того, как `TimePage` до него доберётся.
const timeSummaryAtom = Atom.family((_month: string) =>
  Atom.keepAlive(
    Atom.make(AsyncResult.initial<TimeSummary, { readonly _tag: string }>()),
  ),
);
const sessionWatchAtom = Atom.family((_sessionId: string) =>
  Atom.make(AsyncResult.initial()),
);
const startSessionAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed({ id: "stub-session" }),
);
const refreshLibraryAtom = Atom.fn(() => Effect.succeed(undefined));
const heartbeatAtom = Atom.fn((_arg: unknown) => Effect.succeed(undefined));
const stopSessionAtom = Atom.fn((_arg: unknown) => Effect.succeed(undefined));
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
  providersAtom,
  libraryAtom,
  refreshLibraryAtom,
  refreshLibraryArgs: { payload: undefined, reactivityKeys: ["library"] },
  recentAtom,
  trendingAtom,
  timeSummaryAtom,
  adminPingAtom,
  activeSessionAtom,
  startSessionAtom,
  startSessionArgs: (appId: number) => ({
    payload: { appId },
    reactivityKeys: ["session"],
  }),
  sessionWatchAtom,
  heartbeatAtom,
  stopSessionAtom,
  sessionSettingsAtom,
  updateSessionSettingsAtom,
  updateSessionSettingsArgs: (payload: unknown) => ({
    payload,
    reactivityKeys: ["settings"],
  }),
  errorTag,
  resultErrorTag,
}));

const {
  appRoute,
  appIndexRoute,
  appTrendingRoute,
  appCrateRoute,
  appTimeRoute,
} = await import("../src/routes/app");
const { rootRoute } = await import("../src/routes/__root");

const user: CurrentUserShape = {
  id: "u1",
  name: "Gamer",
  image: null,
  role: "player",
  steamId: "7656",
  email: null,
  emailVerified: false,
};

const timeSummary = (
  patch: Partial<TimeSummary> & { month: string },
): TimeSummary => ({
  totalMinutes: 0,
  sessionCount: 0,
  byGame: [],
  sessions: [],
  ...patch,
});

function sessionsForMonth(
  month: string,
  count: number,
): TimeSummary["sessions"] {
  const [year, mon] = month.split("-");
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `s${i}`,
    appId: 1,
    name: "Hades",
    startedAt: new Date(
      Number(year),
      Number(mon) - 1,
      1 + (i % 28),
      20,
      0,
    ).toISOString(),
    minutes: 30,
  }));
}

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    appIndexRoute,
    appTrendingRoute,
    appCrateRoute,
    appTimeRoute,
  ]),
]);

function renderApp(
  path: string,
  values: {
    me?: CurrentUserShape;
    active?: SessionView | null;
    trending?: { now: TrendingEntry[]; week: TrendingEntry[] };
    time?: ReadonlyArray<readonly [string, TimeSummary]>;
  } = {},
) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const initialValues: Array<InitialValue> = [
    [meAtom, AsyncResult.success(values.me ?? user)],
    [activeSessionAtom, AsyncResult.success(values.active ?? null)],
  ];
  if (values.trending !== undefined) {
    initialValues.push([trendingAtom, AsyncResult.success(values.trending)]);
  }
  for (const [month, summary] of values.time ?? []) {
    initialValues.push([timeSummaryAtom(month), AsyncResult.success(summary)]);
  }
  return render(
    <RegistryProvider initialValues={initialValues}>
      <RouterProvider router={router} />
    </RegistryProvider>,
  );
}

describe("TrendingPage", () => {
  it("shows «Сейчас играют» and «За неделю» with pluralised player captions", async () => {
    const x = trendingEntry({
      appId: 1,
      name: "X Game",
      players: 2,
      inLibrary: true,
    });
    const y = trendingEntry({
      appId: 2,
      name: "Y Game",
      players: 1,
      inLibrary: true,
    });
    renderApp("/app/trending", { trending: { now: [x], week: [x, y] } });

    expect(
      await screen.findByRole("heading", { name: "В тренде" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /^Сейчас играют/ }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^За неделю/ })).toBeTruthy();
    expect(screen.getByText("2 играют")).toBeTruthy();
    expect(screen.getByText("1 игрок")).toBeTruthy();
  });

  it("shows «нет в библиотеке» and no button when inLibrary is false", async () => {
    const outside = trendingEntry({
      appId: 3,
      name: "Outside Game",
      players: 7,
      inLibrary: false,
    });
    renderApp("/app/trending", { trending: { now: [outside], week: [] } });

    expect(await screen.findByText("нет в библиотеке")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Играть/ })).toBeNull();
  });

  it("shows the empty state when both lists are empty", async () => {
    renderApp("/app/trending", { trending: { now: [], week: [] } });
    expect(
      await screen.findByText("Пока тихо. Запусти что-нибудь первым"),
    ).toBeTruthy();
  });

  it("sets up a 30s setInterval for the refresh and clears it on unmount", async () => {
    const before = {
      now: [
        trendingEntry({
          appId: 1,
          name: "Before Game",
          players: 1,
          inLibrary: true,
        }),
      ],
      week: [],
    };

    // `findByText`/`waitFor` из Testing Library сами опрашивают DOM через
    // `setInterval(…, 50)` — мок должен не трогать их, иначе он же и ломает
    // собственные `await screen.findByText(...)` в этом тесте. Перехватываем
    // только вызов с `timeout === 30_000` (ровно `TRENDING_REFRESH_MS` из
    // `TrendingPage.tsx`), остальные — настоящему `setInterval`/`clearInterval`.
    // Смотрим на `globalThis` через свой узкий интерфейс — у настоящих
    // `setInterval`/`clearInterval` в этом проекте смешаны перегрузки DOM,
    // Node и Bun (разные типы id), которые здесь не нужны.
    interface IntervalGlobals {
      setInterval(handler: () => void, timeout?: number): number;
      clearInterval(id?: number): void;
    }
    const globals = globalThis as unknown as IntervalGlobals;
    const realSetInterval = globals.setInterval.bind(globals);
    const realClearInterval = globals.clearInterval.bind(globals);
    let tick: (() => void) | undefined;
    const trendingIntervalId = 999_999;

    const setIntervalSpy = spyOn(globals, "setInterval").mockImplementation(
      (handler, timeout) => {
        if (timeout === 30_000) {
          tick = handler;
          return trendingIntervalId;
        }
        return realSetInterval(handler, timeout);
      },
    );
    const clearIntervalSpy = spyOn(globals, "clearInterval").mockImplementation(
      (id) => {
        if (id !== trendingIntervalId) realClearInterval(id);
      },
    );

    try {
      const { unmount } = renderApp("/app/trending", { trending: before });
      expect(await screen.findByText("Before Game")).toBeTruthy();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(tick).toBeInstanceOf(Function);

      // Срабатывание интервала — руками, внутри `act`, без фейковых таймеров
      // (см. комментарий в начале файла про баг связки bun + React 19).
      act(() => {
        tick?.();
      });
      expect(await screen.findByText("After Refresh Game")).toBeTruthy();
      expect(screen.queryByText("Before Game")).toBeNull();

      unmount();
      expect(clearIntervalSpy).toHaveBeenCalledWith(trendingIntervalId);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});

describe("CratePage", () => {
  it("shows the «Из ящика» intro and three GC placeholder tiles", async () => {
    renderApp("/app/crate");
    expect(
      await screen.findByRole("heading", { name: "Из ящика" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Игры, в которые можно играть без Steam. Скоро"),
    ).toBeTruthy();
    expect(screen.getAllByText("GC")).toHaveLength(3);
  });
});

describe("TimePage", () => {
  it("shows the month total, session count, and the per-game shares", async () => {
    const month = currentMonth(new Date());
    const sessions = sessionsForMonth(month, 35);
    const summary = timeSummary({
      month,
      totalMinutes: 35 * 30,
      sessionCount: 35,
      byGame: [{ appId: 1, name: "Hades", minutes: 35 * 30 }],
      sessions,
    });
    renderApp("/app/time", { time: [[month, summary]] });

    expect(await screen.findByRole("heading", { name: "Время" })).toBeTruthy();
    expect(screen.getByText(formatMonth(month))).toBeTruthy();
    expect(screen.getByText("17 ч 30 м")).toBeTruthy();
    expect(screen.getByText(/35 сессий/)).toBeTruthy();
    expect(screen.getAllByTestId("time-session-row")).toHaveLength(30);

    const more = screen.getByRole("button", { name: "показать ещё 5" });
    fireEvent.click(more);
    expect(screen.getAllByTestId("time-session-row")).toHaveLength(35);
    expect(screen.queryByRole("button", { name: /показать ещё/ })).toBeNull();
  });

  it("resets «показать ещё» when navigating to another month (expanded state must not leak)", async () => {
    const month = currentMonth(new Date());
    const prevMonth = monthShift(month, -1);
    const summaryFor = (m: string) =>
      timeSummary({
        month: m,
        totalMinutes: 35 * 30,
        sessionCount: 35,
        byGame: [{ appId: 1, name: "Hades", minutes: 35 * 30 }],
        sessions: sessionsForMonth(m, 35),
      });
    renderApp("/app/time", {
      time: [
        [month, summaryFor(month)],
        [prevMonth, summaryFor(prevMonth)],
      ],
    });

    expect(await screen.findByText(formatMonth(month))).toBeTruthy();
    expect(screen.getAllByTestId("time-session-row")).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "показать ещё 5" }));
    expect(screen.getAllByTestId("time-session-row")).toHaveLength(35);

    fireEvent.click(screen.getByRole("button", { name: "Предыдущий месяц" }));
    expect(await screen.findByText(formatMonth(prevMonth))).toBeTruthy();
    expect(screen.getAllByTestId("time-session-row")).toHaveLength(30);
    expect(screen.getByRole("button", { name: "показать ещё 5" })).toBeTruthy();
  });

  it("disables the forward arrow on the current month only", async () => {
    const month = currentMonth(new Date());
    renderApp("/app/time", {
      time: [[month, timeSummary({ month })]],
    });
    const forward = await screen.findByRole("button", {
      name: "Следующий месяц",
    });
    expect(forward.hasAttribute("disabled")).toBe(true);
    const back = screen.getByRole("button", { name: "Предыдущий месяц" });
    expect(back.hasAttribute("disabled")).toBe(false);
  });

  it("shows the empty-month notice", async () => {
    const month = currentMonth(new Date());
    const prevMonth = monthShift(month, -1);
    renderApp(`/app/time?month=${prevMonth}`, {
      time: [[prevMonth, timeSummary({ month: prevMonth })]],
    });
    expect(
      await screen.findByText("В этом месяце ты ещё не играл"),
    ).toBeTruthy();
  });
});

describe("works for a user with steamId: null", () => {
  it("renders «В тренде»", async () => {
    renderApp("/app/trending", {
      me: { ...user, steamId: null },
      trending: { now: [], week: [] },
    });
    expect(
      await screen.findByRole("heading", { name: "В тренде" }),
    ).toBeTruthy();
  });

  it("renders «Из ящика»", async () => {
    renderApp("/app/crate", { me: { ...user, steamId: null } });
    expect(
      await screen.findByRole("heading", { name: "Из ящика" }),
    ).toBeTruthy();
  });

  it("renders «Время»", async () => {
    const month = currentMonth(new Date());
    renderApp("/app/time", {
      me: { ...user, steamId: null },
      time: [[month, timeSummary({ month })]],
    });
    expect(await screen.findByRole("heading", { name: "Время" })).toBeTruthy();
  });
});
