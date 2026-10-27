// Каркас /app: полоска разделов (Rail), нижняя панель (BottomTabs) и сетка AppShell.
// Страницы под маршрутами — заглушки из других задач; здесь проверяем только атомы вёрстки.
//
// `RouterProvider` резолвит первый матч асинхронно — как и в profile.test.tsx, первый
// запрос в каждом тесте через `findBy*`, остальные синхронно.
import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { AppShell } from "../src/components/app/AppShell";
import { BottomTabs } from "../src/components/app/BottomTabs";
import { Rail } from "../src/components/app/Rail";
import { testRouter } from "./router";

describe("Rail", () => {
  it("renders the four sections with their hrefs", async () => {
    render(<RouterProvider router={testRouter(<Rail />)} />);
    expect(
      (await screen.findByRole("link", { name: "Мои игры" })).getAttribute(
        "href",
      ),
    ).toBe("/app");
    expect(
      screen.getByRole("link", { name: "В тренде" }).getAttribute("href"),
    ).toBe("/app/trending");
    expect(
      screen.getByRole("link", { name: "Из ящика" }).getAttribute("href"),
    ).toBe("/app/crate");
    expect(
      screen.getByRole("link", { name: "Время" }).getAttribute("href"),
    ).toBe("/app/time");
  });

  it("marks the active section with aria-current", async () => {
    const root = createRootRoute({
      component: () => <Rail />,
    });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ["/app/trending"] }),
    });
    render(<RouterProvider router={router} />);
    const trending = await screen.findByRole("link", { name: "В тренде" });
    expect(trending.getAttribute("aria-current")).toBe("page");
    const myGames = screen.getByRole("link", { name: "Мои игры" });
    expect(myGames.getAttribute("aria-current")).toBeNull();
  });

  it("has no «Установки» link", async () => {
    render(<RouterProvider router={testRouter(<Rail />)} />);
    await screen.findByRole("link", { name: "Поиск" });
    expect(screen.queryByRole("link", { name: "Установки" })).toBeNull();
  });

  it("is fixed-height and sticky on desktop", async () => {
    render(<RouterProvider router={testRouter(<Rail />)} />);
    const nav = await screen.findByRole("navigation", { name: "Разделы" });
    expect(nav.className).toContain("sticky");
    expect(nav.className).toContain("h-[calc(100dvh-3rem)]");
  });

  it("links the profile avatar to /profile", async () => {
    render(<RouterProvider router={testRouter(<Rail />)} />);
    expect(
      (await screen.findByRole("link", { name: "Профиль" })).getAttribute(
        "href",
      ),
    ).toBe("/profile");
  });
});

describe("BottomTabs", () => {
  it("renders five tabs by label", async () => {
    render(<RouterProvider router={testRouter(<BottomTabs />)} />);
    expect(await screen.findByRole("link", { name: "Мои игры" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "В тренде" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Из ящика" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Время" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Профиль" })).toBeTruthy();
  });
});

describe("AppShell", () => {
  it("places aside after children in the DOM", async () => {
    const { container } = render(
      <RouterProvider
        router={testRouter(
          <AppShell
            user={{
              id: "u1",
              name: "Gamer",
              image: null,
              role: "player",
              steamId: "7656",
              email: null,
              emailVerified: false,
            }}
            aside={<div data-testid="aside">aside</div>}
          >
            <div data-testid="main">main</div>
          </AppShell>,
        )}
      />,
    );
    const main = await screen.findByTestId("main");
    const aside = container.querySelector('[data-testid="aside"]');
    expect(aside).not.toBeNull();
    // `compareDocumentPosition` с битом 4 (FOLLOWING) — aside идёт после main в DOM.
    expect(
      Boolean(
        aside &&
        main.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("средняя колонка сетки — minmax(0,1fr) на md и xl, иначе 1fr не сжимается ниже min-content контента и сетка вылезает за экран (1280 px)", async () => {
    const { container } = render(
      <RouterProvider
        router={testRouter(
          <AppShell
            user={{
              id: "u1",
              name: "Gamer",
              image: null,
              role: "player",
              steamId: "7656",
              email: null,
              emailVerified: false,
            }}
          >
            <div data-testid="main">main</div>
          </AppShell>,
        )}
      />,
    );
    await screen.findByTestId("main");
    const grid = container.querySelector(".min-h-dvh");
    expect(grid).not.toBeNull();
    const classList = Array.from(grid?.classList ?? []);
    expect(classList).toContain("md:grid-cols-[84px_minmax(0,1fr)]");
    expect(classList).toContain("xl:grid-cols-[84px_minmax(0,1fr)_330px]");
  });
});
