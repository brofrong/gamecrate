// Страница игры `/app/game/<appId>` (спека 2026-10-27 §3.5): шапка с чипами и
// кнопкой, совместимость, факты, сессии, состояния без описания и `GameNotFound`.
//
// `../src/rpc` открывает реальный WebSocket, поэтому подменяется целиком через
// `mock.module` — тот же набор имён, что в `myGamesPage.test.tsx` (см. комментарий там),
// плюс `gameAtom`. Значения атомов на каждый тест — через `RegistryProvider`.
import { describe, expect, it, mock, spyOn } from "bun:test";
import {
  accessDeniedReason,
  type CurrentUserShape,
  type GameView,
  type LibraryView,
  type RecentEntry,
  type SessionView,
} from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Cause, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryProvider } from "@effect/atom-react";
import { toast } from "sonner";
import { testRouter } from "./router";

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
const gameAtom = Atom.family((_appId: number) =>
  Atom.make(AsyncResult.initial<GameView, { readonly _tag: string }>()),
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
// По умолчанию «Играть» всегда успешен; тест ошибки `usePlaySession.onPlay` (ниже)
// на время своего прогона подставляет сюда ошибку и возвращает `null` в `finally`,
// чтобы не задеть остальные тесты файла.
let startSessionFailure: { readonly _tag: string } | null = null;
const startSessionAtom = Atom.fn((_arg: unknown) =>
  startSessionFailure !== null
    ? Effect.fail(startSessionFailure)
    : Effect.succeed({ id: "stub-session" }),
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
  meAtom,
  providersAtom,
  libraryAtom,
  refreshLibraryAtom,
  refreshLibraryArgs: { payload: undefined, reactivityKeys: ["library"] },
  recentAtom,
  trendingAtom,
  timeSummaryAtom,
  gameAtom,
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

const { GamePage } = await import("../src/components/app/game/GamePage");
const { appRoute, appIndexRoute, appGameRoute } =
  await import("../src/routes/app");
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

const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const details: NonNullable<GameView["details"]> = {
  shortDescription: "Собери отряд и вернись в Забытые Королевства.",
  aboutTheGame: "<p>Длинное описание.</p>",
  developers: ["Larian Studios"],
  publishers: ["Larian Studios"],
  genres: ["Ролевые игры", "Приключенческие игры"],
  releaseDate: "3 авг. 2023 г.",
  metacriticScore: 96,
  metacriticUrl: "https://www.metacritic.com/game/pc/baldurs-gate-3",
  controllerSupport: "full",
  linux: false,
  achievementsTotal: 54,
  screenshots: [],
  movies: [],
};

const view = (patch: Partial<GameView> = {}): GameView => ({
  appId: 1086940,
  name: "Baldur's Gate 3",
  coverUrl: "https://example.com/cover.jpg",
  cloud: { _tag: "Ready" },
  protonTier: "platinum",
  inLibrary: true,
  playtimeMinutes: 2460,
  sizeBytes: 122 * 2 ** 30,
  lastSession: { id: "s1", startedAt: yesterday, minutes: 80 },
  sessions: [
    { id: "s1", startedAt: yesterday, minutes: 80 },
    { id: "s0", startedAt: "2026-01-05T10:00:00.000Z", minutes: 125 },
  ],
  details,
  achievements: { _tag: "None" },
  ...patch,
});

function renderGame(
  result: AsyncResult.AsyncResult<GameView, { readonly _tag: string }>,
) {
  render(
    <RegistryProvider
      initialValues={[
        [gameAtom(1086940), result],
        [activeSessionAtom, AsyncResult.success(null)],
      ]}
    >
      <RouterProvider router={testRouter(<GamePage appId={1086940} />)} />
    </RegistryProvider>,
  );
}

describe("GamePage", () => {
  it("renders hero with name, cloud chip, proton, hours, last session and «Играть»", async () => {
    renderGame(AsyncResult.success(view()));
    expect(
      await screen.findByRole("heading", { name: "Baldur's Gate 3" }),
    ).toBeTruthy();
    expect(screen.getByText("В облаке")).toBeTruthy();
    expect(screen.getByText("ProtonDB: platinum")).toBeTruthy();
    expect(screen.getByText("41 ч сыграно")).toBeTruthy();
    expect(screen.getByText("последний запуск: вчера, 1 ч 20 м")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Играть: Baldur's Gate 3" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "← Мои игры" }).getAttribute("href"),
    ).toBe("/app");
  });

  it("«Играть» shows «Доступ закрыт» when the user is blocked (usePlaySession.onPlay)", async () => {
    const toastError = spyOn(toast, "error").mockImplementation(
      () => "" as never,
    );
    startSessionFailure = { _tag: "AccessDenied" };
    try {
      renderGame(AsyncResult.success(view()));
      const play = await screen.findByRole("button", {
        name: "Играть: Baldur's Gate 3",
      });
      fireEvent.click(play);

      await waitFor(() => {
        expect(toastError).toHaveBeenCalledWith(accessDeniedReason);
      });
    } finally {
      startSessionFailure = null;
      toastError.mockRestore();
    }
  });

  it("«Установить» for a missing game", async () => {
    renderGame(
      AsyncResult.success(
        view({ cloud: { _tag: "Missing" }, sizeBytes: null }),
      ),
    );
    expect(
      await screen.findByRole("button", {
        name: "Установить: Baldur's Gate 3",
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("не установлена").length).toBeGreaterThan(0);
  });

  it("no play button and no sessions panel for a game not in library", async () => {
    renderGame(
      AsyncResult.success(
        view({
          inLibrary: false,
          playtimeMinutes: 0,
          sessions: [],
          lastSession: null,
        }),
      ),
    );
    await screen.findByRole("heading", { name: "Baldur's Gate 3" });
    expect(
      screen.queryByRole("button", { name: /Baldur's Gate 3$/ }),
    ).toBeNull();
    expect(screen.queryByText("Мои сессии")).toBeNull();
    expect(screen.queryByText(/сыграно/)).toBeNull();
  });

  it("renders facts and compat from details", async () => {
    renderGame(AsyncResult.success(view()));
    await screen.findByRole("heading", { name: "Baldur's Gate 3" });
    expect(screen.getByText("Larian Studios")).toBeTruthy();
    expect(screen.getByText("3 авг. 2023 г.")).toBeTruthy();
    expect(screen.getByText("Ролевые игры, Приключенческие игры")).toBeTruthy();
    expect(screen.getByRole("link", { name: "96" }).getAttribute("href")).toBe(
      "https://www.metacritic.com/game/pc/baldurs-gate-3",
    );
    expect(
      screen
        .getByRole("link", { name: "Открыть в Steam ↗" })
        .getAttribute("href"),
    ).toBe("https://store.steampowered.com/app/1086940");
    expect(screen.getByText("установлена, 122.0 ГБ")).toBeTruthy();
    expect(screen.getByText("полная поддержка")).toBeTruthy();
    expect(screen.getByText("Работает идеально")).toBeTruthy();
    expect(screen.queryByText("Linux")).toBeNull();
  });

  it("without details still renders hero, compat, «Открыть в Steam» and the notice", async () => {
    renderGame(AsyncResult.success(view({ details: null })));
    await screen.findByRole("heading", { name: "Baldur's Gate 3" });
    expect(screen.getByText("Steam не дал описание этой игры")).toBeTruthy();
    expect(screen.getByText("установлена, 122.0 ГБ")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Открыть в Steam ↗" }),
    ).toBeTruthy();
    expect(screen.queryByText("Геймпад")).toBeNull();
  });

  it("about panel shows «Читать дальше» for long text and expands", async () => {
    const long = `<p>${"Очень длинное описание игры. ".repeat(40)}</p>`;
    renderGame(
      AsyncResult.success(
        view({ details: { ...details, aboutTheGame: long } }),
      ),
    );
    // Два заголовка «Об игре» (описание и факты) — ждём текст описания.
    await screen.findByText("Собери отряд и вернись в Забытые Королевства.");
    fireEvent.click(screen.getByRole("button", { name: "Читать дальше" }));
    expect(screen.getByRole("button", { name: "Свернуть" })).toBeTruthy();
  });

  it("short about text has no «Читать дальше»", async () => {
    renderGame(AsyncResult.success(view()));
    await screen.findByRole("heading", { name: "Baldur's Gate 3" });
    expect(screen.queryByRole("button", { name: "Читать дальше" })).toBeNull();
  });

  it("GameNotFound → «Этой игры нет в твоей библиотеке»", async () => {
    renderGame(AsyncResult.failure(Cause.fail({ _tag: "GameNotFound" })));
    expect(
      await screen.findByText("Этой игры нет в твоей библиотеке"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "К моим играм" }).getAttribute("href"),
    ).toBe("/app");
  });

  it("sessions panel lists sessions; empty → notice", async () => {
    renderGame(AsyncResult.success(view()));
    await screen.findByText("Мои сессии");
    expect(screen.getByText("2 ч 5 м")).toBeTruthy();
    expect(screen.getByText("5 янв")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "все сессии →" }).getAttribute("href"),
    ).toBe("/app/time");
  });

  it("empty sessions → «Ты ещё не запускал эту игру в облаке»", async () => {
    renderGame(AsyncResult.success(view({ sessions: [], lastSession: null })));
    expect(
      await screen.findByText("Ты ещё не запускал эту игру в облаке"),
    ).toBeTruthy();
    expect(screen.queryByText(/последний запуск/)).toBeNull();
  });
});

describe("appGameRoute", () => {
  const routeTree = rootRoute.addChildren([
    appRoute.addChildren([appIndexRoute, appGameRoute]),
  ]);

  function renderAt(
    path: string,
    gameResult: AsyncResult.AsyncResult<GameView, { readonly _tag: string }>,
  ) {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    const rendered = render(
      <RegistryProvider
        initialValues={[
          [meAtom, AsyncResult.success(user)],
          [
            libraryAtom,
            AsyncResult.success({
              _tag: "Ready",
              entries: [],
              syncedAt: null,
              steamProfile: true,
            } as LibraryView),
          ],
          [recentAtom, AsyncResult.success([])],
          [activeSessionAtom, AsyncResult.success(null)],
          [gameAtom(620), gameResult],
        ]}
      >
        <RouterProvider router={router} />
      </RegistryProvider>,
    );
    return Object.assign(router, { container: rendered.container });
  }

  it("/app/game/abc redirects to /app", async () => {
    const router = renderAt("/app/game/abc", AsyncResult.initial());
    await waitFor(() => expect(router.state.location.pathname).toBe("/app"));
  });

  it("/app/game/620 renders GamePage for appId 620", async () => {
    renderAt(
      "/app/game/620",
      AsyncResult.success(view({ appId: 620, name: "Portal 2" })),
    );
    expect(
      await screen.findByRole("heading", { name: "Portal 2" }),
    ).toBeTruthy();
  });

  it("страница игры занимает всю ширину: у оболочки нет правой колонки", async () => {
    const { container } = renderAt(
      "/app/game/620",
      AsyncResult.success(view({ appId: 620, name: "Portal 2" })),
    );
    await screen.findByRole("heading", { name: "Portal 2" });
    const classList = Array.from(
      container.querySelector(".min-h-dvh")?.classList ?? [],
    );
    expect(classList).toContain("xl:grid-cols-[84px_minmax(0,1fr)]");
    expect(classList).not.toContain("xl:grid-cols-[84px_minmax(0,1fr)_330px]");
  });

  it("shows the action button in the sticky slot on mobile", async () => {
    renderAt(
      "/app/game/620",
      AsyncResult.success(view({ appId: 620, name: "Portal 2" })),
    );
    await screen.findByRole("heading", { name: "Portal 2" });
    // Одна кнопка в шапке (десктоп), вторая — в закреплённом слоте над нижней панелью.
    expect(
      screen.getAllByRole("button", { name: "Играть: Portal 2" }),
    ).toHaveLength(2);
  });
});
