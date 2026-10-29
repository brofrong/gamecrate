// «Мои игры» (`/app`) целиком: секции по статусу облака, «Нужен вход в Steam» без
// облачного профиля, поиск скрывает «Запускал недавно» и фильтрует секции, Private/
// `steamId: null`/заголовочная строка со сводкой.
//
// `../src/rpc` открывает реальный WebSocket, поэтому он подменяется целиком через
// `mock.module` — глобально на весь прогон `bun test` для этого модуля (любой импорт
// `../src/rpc`/`@/rpc`, в этом файле или в другом, получает эту подмену). Все имена
// настоящего `rpc.ts` даёт `rpcStub()` (`moduleStubs.ts`), поверх — атомы этого файла.
// Сами данные (`meAtom`, `libraryAtom`, ...) — простые писуемые атомы (`Atom.make`),
// их значение на каждый тест задаёт `RegistryProvider` через `initialValues` — так
// тесты не делят состояние между собой, хотя атомы создаются один раз на файл.
import { describe, expect, it } from "bun:test";
import type {
  CurrentUserShape,
  LibraryEntry,
  LibraryView,
  RecentEntry,
  SessionView,
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
import { mock } from "bun:test";
import { rpcStub } from "./moduleStubs";

const meAtom = Atom.make(
  AsyncResult.initial<CurrentUserShape, { readonly _tag: string }>(),
);
const libraryAtom = Atom.make(
  AsyncResult.initial<LibraryView, { readonly _tag: string }>(),
);
const recentAtom = Atom.make(
  AsyncResult.initial<ReadonlyArray<RecentEntry>, { readonly _tag: string }>(),
);
const activeSessionAtom = Atom.make(
  AsyncResult.initial<SessionView | null, { readonly _tag: string }>(),
);
const providersAtom = Atom.make(AsyncResult.initial());
const trendingAtom = Atom.make(AsyncResult.initial());
const adminPingAtom = Atom.make(AsyncResult.initial());
const sessionSettingsAtom = Atom.make(AsyncResult.initial());
const timeSummaryAtom = Atom.family((_month: string) =>
  Atom.make(AsyncResult.success({ totalMinutes: 0, byGame: [], sessions: [] })),
);
const sessionWatchAtom = Atom.family((_sessionId: string) =>
  Atom.make(AsyncResult.initial()),
);
const startSessionAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed({ id: "stub-session" }),
);
const refreshLibraryAtom = Atom.fn(() =>
  Effect.succeed({
    _tag: "Ready",
    entries: [],
    syncedAt: null,
    steamProfile: true,
  } as LibraryView),
);
const heartbeatAtom = Atom.fn((_arg: unknown) => Effect.succeed(undefined));
const stopSessionAtom = Atom.fn((_arg: unknown) => Effect.succeed(undefined));
const startSteamLoginAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed({ attemptId: "attempt-1" }),
);
const steamLoginStatusAtom = Atom.fn((_arg: unknown) =>
  Effect.succeed({
    attemptId: "attempt-1",
    status: "waiting" as const,
    qrUrl: "https://s.team/q/1/abc",
    reason: null,
  }),
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
  ...rpcStub(),
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
  startSteamLoginAtom,
  steamLoginStatusAtom,
  sessionSettingsAtom,
  updateSessionSettingsAtom,
  updateSessionSettingsArgs: (payload: unknown) => ({
    payload,
    reactivityKeys: ["settings"],
  }),
  errorTag,
  resultErrorTag,
}));

// `appIndexRoute.component` (routes/app.tsx) уже указывает на `MyGamesPage` — роутер
// рендерит её сам, импортировать компонент напрямую не нужно.
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

const entry = (
  patch: Partial<LibraryEntry> & { appId: number; name: string },
): LibraryEntry => ({
  playtimeMinutes: 0,
  protonTier: "pending",
  coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${patch.appId}/library_600x900_2x.jpg`,
  cloud: { _tag: "Missing" },
  lastPlayedAt: null,
  ...patch,
});

const ready = (
  entries: ReadonlyArray<LibraryEntry>,
  patch: Partial<Extract<LibraryView, { _tag: "Ready" }>> = {},
): LibraryView => ({
  _tag: "Ready",
  entries,
  syncedAt: "2026-10-23T10:00:00.000Z",
  steamProfile: true,
  ...patch,
});

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    appIndexRoute,
    appTrendingRoute,
    appCrateRoute,
    appTimeRoute,
  ]),
]);

function renderMyGames(
  path: string,
  values: {
    me?: CurrentUserShape;
    library?: LibraryView;
    recent?: ReadonlyArray<RecentEntry>;
    active?: SessionView | null;
  } = {},
) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <RegistryProvider
      initialValues={[
        [meAtom, AsyncResult.success(values.me ?? user)],
        [libraryAtom, AsyncResult.success(values.library ?? ready([]))],
        [recentAtom, AsyncResult.success(values.recent ?? [])],
        [activeSessionAtom, AsyncResult.success(values.active ?? null)],
      ]}
    >
      <RouterProvider router={router} />
    </RegistryProvider>,
  );
}

describe("MyGamesPage", () => {
  it("splits a ready library into «готовы к запуску» and «нужна установка»", async () => {
    const entries = [
      entry({ appId: 1, name: "Balatro", cloud: { _tag: "Ready" } }),
      entry({ appId: 2, name: "Hades", cloud: { _tag: "Ready" } }),
      entry({ appId: 3, name: "Elden Ring", cloud: { _tag: "Missing" } }),
      entry({
        appId: 4,
        name: "Baldur's Gate 3",
        cloud: { _tag: "Installing", percent: 40 },
      }),
    ];
    renderMyGames("/app", { library: ready(entries) });

    expect(
      await screen.findByRole("heading", { name: /^Готовы к запуску/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /^Нужна установка/ }),
    ).toBeTruthy();
    expect(screen.getAllByText("(2)")).toHaveLength(2);
    expect(
      screen.queryByRole("heading", { name: /Нужен вход в Steam/ }),
    ).toBeNull();
  });

  it("shows one «нужен вход в Steam» section without a cloud profile", async () => {
    const entries = [
      entry({ appId: 1, name: "Balatro", cloud: { _tag: "Ready" } }),
      entry({ appId: 2, name: "Hades", cloud: { _tag: "Ready" } }),
      entry({ appId: 3, name: "Elden Ring", cloud: { _tag: "Missing" } }),
      entry({
        appId: 4,
        name: "Baldur's Gate 3",
        cloud: { _tag: "Installing", percent: 40 },
      }),
    ];
    renderMyGames("/app", {
      library: ready(entries, { steamProfile: false }),
    });

    expect(
      await screen.findByRole("heading", { name: /^Нужен вход в Steam/ }),
    ).toBeTruthy();
    expect(screen.getByText("(4)")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /^Готовы к запуску/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: /^Нужна установка/ }),
    ).toBeNull();
  });

  it("hides «Запускал недавно» and filters sections when q is set", async () => {
    const entries = [
      entry({ appId: 1, name: "Hades", cloud: { _tag: "Ready" } }),
      entry({ appId: 2, name: "Elden Ring", cloud: { _tag: "Missing" } }),
    ];
    const recent: ReadonlyArray<RecentEntry> = [
      {
        appId: 1,
        name: "Hades",
        coverUrl: entries[0]!.coverUrl,
        cloud: { _tag: "Ready" },
        lastPlayedAt: "2026-10-22T10:00:00.000Z",
        lastDurationMinutes: 30,
      },
    ];
    renderMyGames("/app?q=hades", { library: ready(entries), recent });

    expect(
      await screen.findByRole("heading", { name: /^Готовы к запуску/ }),
    ).toBeTruthy();
    expect(screen.queryByText("Запускал недавно")).toBeNull();
    expect(screen.getByText("Hades")).toBeTruthy();
    expect(screen.queryByText("Elden Ring")).toBeNull();
  });

  it("renders «Запускал недавно» as regular tiles with date · duration caption", async () => {
    const entries = [
      entry({ appId: 620, name: "Portal 2", cloud: { _tag: "Ready" } }),
    ];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent: ReadonlyArray<RecentEntry> = [
      {
        appId: 620,
        name: "Portal 2",
        coverUrl: entries[0]!.coverUrl,
        cloud: { _tag: "Ready" },
        lastPlayedAt: yesterday,
        lastDurationMinutes: 80,
      },
    ];
    renderMyGames("/app", { library: ready(entries), recent });

    expect(await screen.findByText("Запускал недавно")).toBeTruthy();
    expect(screen.getByText("вчера · 1 ч 20 м")).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "Игра: Portal 2" }),
    ).toHaveLength(2);
    expect(screen.getByRole("link", { name: "все сессии →" })).toBeTruthy();
  });

  it("caps a section at 24 tiles and leaves a sentinel for the rest", async () => {
    // Другие файлы набора подменяют IntersectionObserver «всегда виден» (глобально
    // на прогон) — здесь маячок не должен срабатывать, иначе секция догрузит всё.
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    const entries = Array.from({ length: 30 }, (_, i) =>
      entry({ appId: 1000 + i, name: `Game ${i}` }),
    );
    renderMyGames("/app", { library: ready(entries) });

    expect(
      await screen.findAllByRole("link", { name: /^Игра: / }),
    ).toHaveLength(24);
    expect(screen.getByRole("status").textContent).toBe("ещё 6");
    expect(screen.queryByRole("button", { name: /Показать ещё/ })).toBeNull();
  });

  it("shows the private-profile notice for a private Steam library", async () => {
    renderMyGames("/app", { library: { _tag: "Private" } });
    expect(
      await screen.findByText("Откройте „Сведения об играх“"),
    ).toBeTruthy();
  });

  it("shows ConnectSteam when the user has no steamId", async () => {
    renderMyGames("/app", { me: { ...user, steamId: null } });
    expect(await screen.findByText("Подключите Steam")).toBeTruthy();
  });

  it("одна строка поиска и одна кнопка «Фильтры» на всех экранах, без отдельных иконок в шапке", async () => {
    renderMyGames("/app", { library: ready([entry({ appId: 1, name: "A" })]) });
    const input = await screen.findByLabelText("Найти игру");
    expect(screen.getAllByRole("button", { name: /Фильтры/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Поиск" })).toBeNull();
    // Строка поиска не прячется на телефоне (раньше её оборачивал `hidden md:flex`).
    const wrapper =
      input.closest("div")?.parentElement?.parentElement?.parentElement;
    expect(Array.from(wrapper?.classList ?? [])).not.toContain("hidden");
  });

  it("на узком экране кнопка «Фильтры» открывает шторку", async () => {
    // Узкий экран — подменой `matchMedia` (исходный вернёт `test/setup.ts`).
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes("max-width"),
      }) as MediaQueryList) as typeof window.matchMedia;
    renderMyGames("/app", {
      library: ready([entry({ appId: 1, name: "A" })]),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Фильтры/ }));
    expect(screen.getByRole("dialog", { name: "Фильтры" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Показать 1 игр/ })).toBeTruthy();
  });

  it("shows the header summary line", async () => {
    const entries = Array.from({ length: 148 }, (_, i) =>
      entry({
        appId: 1000 + i,
        name: `Game ${i}`,
        cloud: i < 12 ? { _tag: "Ready" } : { _tag: "Missing" },
      }),
    );
    renderMyGames("/app", { library: ready(entries) });
    expect(
      await screen.findByText(/148 игр · 12 готовы · обновлено/),
    ).toBeTruthy();
  });
});
