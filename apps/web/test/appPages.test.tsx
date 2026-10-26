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
// «до» приходит через `initialValues` — так проверяется настоящий путь
// `useAtomRefresh` → `registry.refresh` → `setInterval`, без подмены React-хуков.
import { describe, expect, it, jest, mock } from "bun:test";
import type {
  CurrentUserShape,
  SessionView,
  TimeSummary,
  TrendingEntry,
} from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
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
const timeSummaryAtom = Atom.family((_month: string) =>
  Atom.make(AsyncResult.initial<TimeSummary, { readonly _tag: string }>()),
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

  it("shows «нет в твоей библиотеке Steam» and no button when inLibrary is false", async () => {
    const outside = trendingEntry({
      appId: 3,
      name: "Outside Game",
      players: 7,
      inLibrary: false,
    });
    renderApp("/app/trending", { trending: { now: [outside], week: [] } });

    expect(
      await screen.findByText("нет в твоей библиотеке Steam"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Играть/ })).toBeNull();
  });

  it("shows the empty state when both lists are empty", async () => {
    renderApp("/app/trending", { trending: { now: [], week: [] } });
    expect(
      await screen.findByText("Пока тихо. Запусти что-нибудь первым"),
    ).toBeTruthy();
  });

  it("requeries trending every 30s while mounted, not sooner", async () => {
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
    jest.useFakeTimers();
    try {
      const { unmount } = renderApp("/app/trending", { trending: before });
      expect(await screen.findByText("Before Game")).toBeTruthy();
      expect(screen.queryByText("After Refresh Game")).toBeNull();

      // Без `act()`: под фейковыми таймерами в этой связке (bun + React 19) оно
      // пересчитывает интервал раньше срока (проверено отдельно — баг именно
      // связки, не нашего кода). До срабатывания ничего не меняется, поэтому
      // синхронная проверка ниже корректна и без `act`; после срабатывания
      // `findByText` сам дождётся настоящего обновления (как и реальный браузер).
      jest.advanceTimersByTime(29_999);
      expect(screen.getByText("Before Game")).toBeTruthy();
      expect(screen.queryByText("After Refresh Game")).toBeNull();

      jest.advanceTimersByTime(1);
      expect(await screen.findByText("After Refresh Game")).toBeTruthy();
      expect(screen.queryByText("Before Game")).toBeNull();

      unmount();
      expect(() => jest.advanceTimersByTime(120_000)).not.toThrow();
    } finally {
      jest.useRealTimers();
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
