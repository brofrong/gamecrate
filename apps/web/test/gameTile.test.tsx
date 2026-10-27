// Карточка игры (GameTile) и секция сетки (GameSection) на главной `/app`
// (спека 2026-10-27 §3.3–3.4, правка владельца от 2026-10-27): плитка — ссылка на
// страницу игры, название и одно значение — строкой под обложкой, на обложке только
// полоса установки и тег Proton; кнопок на плитке нет («Играть»/«Установить» — только
// на странице игры), цепочка заглушек обложки.
import { describe, expect, it } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import type { CloudStatus } from "@cg/rpc";
import { GameTile, type TileGame } from "../src/components/app/GameTile";
import { GameSection, SECTION_PAGE } from "../src/components/app/GameSection";
import { testRouter } from "./router";

// happy-dom объявляет IntersectionObserver, но никогда не вызывает колбэк — подменяем
// управляемым: `reveal()` сообщает последнему наблюдателю «маячок виден»,
// `alwaysVisible` — каждый `observe` сразу виден (маячок остался на экране после догрузки).
function stubObserver({ alwaysVisible = false } = {}) {
  const state = {
    observed: 0,
    last: null as null | (() => void),
    reveal() {
      state.last?.();
    },
  };
  class Observer {
    constructor(private readonly cb: IntersectionObserverCallback) {}
    observe(target: Element) {
      state.observed += 1;
      const fire = () =>
        this.cb(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as never,
        );
      state.last = fire;
      if (alwaysVisible) fire();
    }
    unobserve() {}
    disconnect() {}
  }
  window.IntersectionObserver = Observer as never;
  return state;
}

const ready: CloudStatus = { _tag: "Ready" };
const missing: CloudStatus = { _tag: "Missing" };
const installing = (percent: number | null): CloudStatus => ({
  _tag: "Installing",
  percent,
});

function game(overrides: Partial<TileGame> = {}): TileGame {
  return {
    appId: 620,
    name: "Portal 2",
    coverUrl: "https://example.com/cover.jpg",
    cloud: ready,
    ...overrides,
  };
}

/** Плитка — `Link`, поэтому ей нужен роутер; первый запрос через `findBy*`. */
function renderTile(element: React.ReactElement) {
  const router = testRouter(element);
  render(<RouterProvider router={router} />);
  return router;
}

describe("GameTile", () => {
  it("is a link to the game page named after the game", async () => {
    renderTile(<GameTile game={game()} />);
    const link = await screen.findByRole("link", { name: "Игра: Portal 2" });
    expect(link.getAttribute("href")).toBe("/app/game/620");
  });

  it("shows hours on the cover for an installed played game and no «ГОТОВА» pill", async () => {
    renderTile(
      <GameTile game={game({ cloud: ready, playtimeMinutes: 2460 })} />,
    );
    await screen.findByText("41 ч");
    expect(screen.queryByText("ГОТОВА")).toBeNull();
    expect(screen.queryByText(/готова/)).toBeNull();
  });

  it("shows «готова» for an installed game never played", async () => {
    renderTile(<GameTile game={game({ cloud: ready, playtimeMinutes: 0 })} />);
    expect(await screen.findByText("готова")).toBeTruthy();
  });

  it("no button on the tile — launching lives on the game page", async () => {
    renderTile(<GameTile game={game()} />);
    await screen.findByRole("link", { name: "Игра: Portal 2" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("missing game: no «не установлена» text", async () => {
    renderTile(<GameTile game={game({ cloud: missing })} />);
    await screen.findByRole("link", { name: "Игра: Portal 2" });
    expect(screen.queryByText("не установлена")).toBeNull();
  });

  it("title and value sit under the cover, not on it", async () => {
    renderTile(
      <GameTile game={game({ cloud: ready, playtimeMinutes: 2460 })} />,
    );
    const link = await screen.findByRole("link", { name: "Игра: Portal 2" });
    const cover = link.querySelector("article")!;
    const title = screen.getByRole("heading", { name: "Portal 2" });
    expect(cover.contains(title)).toBe(false);
    expect(cover.contains(screen.getByText("41 ч"))).toBe(false);
    expect(
      Boolean(
        cover.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("shows percent and a progress bar for an installing game", async () => {
    renderTile(<GameTile game={game({ cloud: installing(42) })} />);
    expect(await screen.findByText("42 %")).toBeTruthy();
    expect(screen.getByTestId("install-bar").style.width).toBe("42%");
  });

  it("caption replaces the status value", async () => {
    renderTile(
      <GameTile
        game={game({ cloud: ready, playtimeMinutes: 2460 })}
        caption="12 играют"
      />,
    );
    expect(await screen.findByText("12 играют")).toBeTruthy();
    expect(screen.queryByText("41 ч")).toBeNull();
  });

  it("dimmed shows «нужен вход в Steam»", async () => {
    renderTile(<GameTile game={game()} dimmed />);
    expect(await screen.findByText("нужен вход в Steam")).toBeTruthy();
  });

  it("обложка: header.jpg → ошибка → coverUrl → ошибка → заглушка", async () => {
    renderTile(<GameTile game={game({ name: "Hades" })} />);
    const header = (await screen.findByAltText("Hades")) as HTMLImageElement;
    expect(header.src).toBe(
      "https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg",
    );

    fireEvent.error(header);
    const cover = screen.getByAltText("Hades") as HTMLImageElement;
    expect(cover.src).toBe("https://example.com/cover.jpg");

    fireEvent.error(cover);
    expect(screen.queryByAltText("Hades")).toBeNull();
    expect(screen.getByRole("img", { name: "Hades" })).toBeTruthy();
  });

  it("тира ProtonDB на плитке нет даже при известном тире", async () => {
    // Запись библиотеки несёт тир, но плитка его больше не показывает.
    const entry = { ...game(), protonTier: "gold" as const };
    renderTile(<GameTile game={entry} />);
    await screen.findByRole("link", { name: "Игра: Portal 2" });
    expect(screen.queryByTestId("proton-tag")).toBeNull();
    expect(screen.queryByText("gold")).toBeNull();
  });
});

describe("GameSection", () => {
  it("заголовок с (count)", () => {
    render(
      <GameSection title="Готовы к запуску" count={12}>
        <div>карточка</div>
      </GameSection>,
    );
    expect(screen.getByText("Готовы к запуску")).toBeTruthy();
    expect(screen.getByText("(12)")).toBeTruthy();
    expect(screen.getByText("карточка")).toBeTruthy();
  });

  it("shows the first `limit` children and loads more as the sentinel scrolls into view", () => {
    const io = stubObserver();
    render(
      <GameSection title="Нужна установка" count={60} limit={24}>
        {Array.from({ length: 60 }, (_, i) => (
          <div key={i} data-testid="tile" />
        ))}
      </GameSection>,
    );
    expect(screen.getAllByTestId("tile")).toHaveLength(24);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("ещё 36");

    act(() => io.reveal());
    expect(screen.getAllByTestId("tile")).toHaveLength(48);
    expect(screen.getByRole("status").textContent).toBe("ещё 12");

    act(() => io.reveal());
    expect(screen.getAllByTestId("tile")).toHaveLength(60);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps loading while the sentinel stays visible after a page is appended", () => {
    const io = stubObserver({ alwaysVisible: true });
    render(
      <GameSection title="Нужна установка" count={60} limit={24}>
        {Array.from({ length: 60 }, (_, i) => (
          <div key={i} data-testid="tile" />
        ))}
      </GameSection>,
    );
    expect(screen.getAllByTestId("tile")).toHaveLength(60);
    expect(io.observed).toBeGreaterThanOrEqual(2);
  });

  it("does not load while the sentinel is out of view", () => {
    stubObserver();
    render(
      <GameSection title="Нужна установка" count={60} limit={24}>
        {Array.from({ length: 60 }, (_, i) => (
          <div key={i} data-testid="tile" />
        ))}
      </GameSection>,
    );
    expect(screen.getAllByTestId("tile")).toHaveLength(24);
  });

  it("renders no sentinel when children fit", () => {
    render(
      <GameSection title="Готовы" count={10} limit={SECTION_PAGE}>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} data-testid="tile" />
        ))}
      </GameSection>,
    );
    expect(SECTION_PAGE).toBe(24);
    expect(screen.getAllByTestId("tile")).toHaveLength(10);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("grid has five columns from 1440px", () => {
    render(
      <GameSection title="Готовы" count={1}>
        <div data-testid="tile" />
      </GameSection>,
    );
    const grid = screen.getByTestId("tile").parentElement!;
    expect(grid.className).toContain("wide:grid-cols-5");
  });

  it("renders the optional action after the title", () => {
    render(
      <GameSection
        title="Запускал недавно"
        count={2}
        action={<a href="/app/time">все сессии →</a>}
      >
        <div />
      </GameSection>,
    );
    expect(screen.getByRole("link", { name: "все сессии →" })).toBeTruthy();
  });
});
