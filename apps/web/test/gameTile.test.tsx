// Карточка игры (GameTile) и секция сетки (GameSection) на главной `/app`
// (спека 2026-10-27 §3.3–3.4): плитка — ссылка на страницу игры, всё на обложке
// (название + одно значение справа, полоса установки, тег Proton), кнопка
// «Играть»/«Установить» не всплывает в ссылку, цепочка заглушек обложки.
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import type { CloudStatus } from "@cg/rpc";
import type { CardAction } from "../src/lib/cardAction";
import { GameTile, type TileGame } from "../src/components/app/GameTile";
import { GameSection, SECTION_PAGE } from "../src/components/app/GameSection";
import { testRouter } from "./router";

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

const playAction: CardAction = {
  kind: "play",
  pending: false,
  disabled: false,
  onPlay: () => {},
};
const resumeAction: CardAction = { kind: "resume", onResume: () => {} };
const blockedAction: CardAction = { kind: "blocked" };

/** Плитка — `Link`, поэтому ей нужен роутер; первый запрос через `findBy*`. */
function renderTile(element: React.ReactElement) {
  const router = testRouter(element);
  render(<RouterProvider router={router} />);
  return router;
}

describe("GameTile", () => {
  it("is a link to the game page named after the game", async () => {
    renderTile(<GameTile game={game()} action={playAction} />);
    const link = await screen.findByRole("link", { name: "Игра: Portal 2" });
    expect(link.getAttribute("href")).toBe("/app/game/620");
  });

  it("shows hours on the cover for an installed played game and no «ГОТОВА» pill", async () => {
    renderTile(
      <GameTile
        game={game({ cloud: ready, playtimeMinutes: 2460 })}
        action={playAction}
      />,
    );
    await screen.findByText("41 ч");
    expect(screen.queryByText("ГОТОВА")).toBeNull();
    expect(screen.queryByText(/готова/)).toBeNull();
  });

  it("shows «готова» for an installed game never played", async () => {
    renderTile(
      <GameTile
        game={game({ cloud: ready, playtimeMinutes: 0 })}
        action={playAction}
      />,
    );
    expect(await screen.findByText("готова")).toBeTruthy();
  });

  it("labels the button «Играть» for a ready game", async () => {
    renderTile(<GameTile game={game()} action={playAction} />);
    expect(
      await screen.findByRole("button", { name: "Играть: Portal 2" }),
    ).toBeTruthy();
  });

  it("labels the button «Установить» for a missing game", async () => {
    renderTile(
      <GameTile game={game({ cloud: missing })} action={playAction} />,
    );
    expect(
      await screen.findByRole("button", { name: "Установить: Portal 2" }),
    ).toBeTruthy();
    expect(screen.queryByText("не установлена")).toBeNull();
  });

  it("shows percent and a progress bar for an installing game", async () => {
    renderTile(
      <GameTile game={game({ cloud: installing(42) })} action={playAction} />,
    );
    expect(
      await screen.findByRole("button", { name: "Установить: Portal 2" }),
    ).toBeTruthy();
    expect(screen.getByText("42 %")).toBeTruthy();
    expect(screen.getByTestId("install-bar").style.width).toBe("42%");
  });

  it("button click does not navigate the link", async () => {
    const onPlay = mock(() => {});
    const router = renderTile(
      <GameTile game={game()} action={{ ...playAction, onPlay }} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Играть: Portal 2" }),
    );
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/");
  });

  it("caption replaces the status value", async () => {
    renderTile(
      <GameTile
        game={game({ cloud: ready, playtimeMinutes: 2460 })}
        action={playAction}
        caption="12 играют"
      />,
    );
    expect(await screen.findByText("12 играют")).toBeTruthy();
    expect(screen.queryByText("41 ч")).toBeNull();
  });

  it("dimmed shows «нужен вход в Steam»", async () => {
    renderTile(<GameTile game={game()} action={playAction} dimmed />);
    expect(await screen.findByText("нужен вход в Steam")).toBeTruthy();
  });

  it("resume action shows «Вернуться в игру»", async () => {
    renderTile(<GameTile game={game()} action={resumeAction} />);
    expect(
      await screen.findByRole("button", { name: "Вернуться в игру" }),
    ).toBeTruthy();
  });

  it("blocked action renders no button", async () => {
    renderTile(<GameTile game={game()} action={blockedAction} />);
    await screen.findByRole("link", { name: "Игра: Portal 2" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("обложка: header.jpg → ошибка → coverUrl → ошибка → заглушка", async () => {
    renderTile(<GameTile game={game({ name: "Hades" })} action={playAction} />);
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

  it("без Proton-плашки, когда tier не указан или pending", async () => {
    renderTile(
      <GameTile game={game({ protonTier: "pending" })} action={playAction} />,
    );
    await screen.findByRole("link", { name: "Игра: Portal 2" });
    expect(screen.queryByTestId("proton-tag")).toBeNull();
  });

  it("показывает уровень Proton", async () => {
    renderTile(
      <GameTile game={game({ protonTier: "gold" })} action={playAction} />,
    );
    expect(await screen.findByText("gold")).toBeTruthy();
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

  it("shows the first `limit` children and a «Показать ещё» button", () => {
    render(
      <GameSection title="Нужна установка" count={60} limit={24}>
        {Array.from({ length: 60 }, (_, i) => (
          <div key={i} data-testid="tile" />
        ))}
      </GameSection>,
    );
    expect(screen.getAllByTestId("tile")).toHaveLength(24);
    fireEvent.click(
      screen.getByRole("button", { name: "Показать ещё 24 · осталось 36" }),
    );
    expect(screen.getAllByTestId("tile")).toHaveLength(48);
    fireEvent.click(
      screen.getByRole("button", { name: "Показать ещё 12 · осталось 12" }),
    );
    expect(screen.getAllByTestId("tile")).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /Показать ещё/ })).toBeNull();
  });

  it("renders no button when children fit", () => {
    render(
      <GameSection title="Готовы" count={10} limit={SECTION_PAGE}>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} data-testid="tile" />
        ))}
      </GameSection>,
    );
    expect(SECTION_PAGE).toBe(24);
    expect(screen.getAllByTestId("tile")).toHaveLength(10);
    expect(screen.queryByRole("button")).toBeNull();
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
