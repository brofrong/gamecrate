// Карточка игры (GameTile) и секция сетки (GameSection) на главной `/app`:
// строка статуса по таблице спеки §4.3, плашка «ГОТОВА», уровень Proton,
// кнопка действия и цепочка заглушек обложки (header → coverUrl → имя).
import { describe, expect, it } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CloudStatus } from "@cg/rpc";
import type { CardAction } from "../src/lib/cardAction";
import {
  cloudLabel,
  GameTile,
  type TileGame,
} from "../src/components/app/GameTile";
import { GameSection } from "../src/components/app/GameSection";

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

describe("cloudLabel", () => {
  it("готова · часы в игре", () => {
    expect(
      cloudLabel(game({ cloud: ready, playtimeMinutes: 840 }), false),
    ).toBe("готова · 14 ч в игре");
  });

  it("качается · процент", () => {
    expect(cloudLabel(game({ cloud: installing(63) }), false)).toBe(
      "качается · 63 %",
    );
  });

  it("качается без процента, когда размер неизвестен", () => {
    expect(cloudLabel(game({ cloud: installing(null) }), false)).toBe(
      "качается",
    );
  });

  it("нужна установка · часы в игре", () => {
    expect(
      cloudLabel(game({ cloud: missing, playtimeMinutes: 120 }), false),
    ).toBe("нужна установка · 2 ч в игре");
  });

  it("нужен вход в Steam при dimmed, независимо от cloud", () => {
    expect(cloudLabel(game({ cloud: ready }), true)).toBe("нужен вход в Steam");
  });
});

describe("GameTile", () => {
  it("показывает плашку «ГОТОВА» только для Ready", () => {
    render(<GameTile game={game({ cloud: ready })} action={playAction} />);
    expect(screen.getByText("ГОТОВА")).toBeTruthy();
  });

  it("не показывает плашку «ГОТОВА» для Missing", () => {
    render(<GameTile game={game({ cloud: missing })} action={playAction} />);
    expect(screen.queryByText("ГОТОВА")).toBeNull();
  });

  it("не показывает плашку «ГОТОВА» для Ready, если dimmed (нет облачного профиля)", () => {
    render(
      <GameTile game={game({ cloud: ready })} action={playAction} dimmed />,
    );
    expect(screen.queryByText("ГОТОВА")).toBeNull();
    expect(screen.getByText("нужен вход в Steam")).toBeTruthy();
  });

  it('кнопка «Играть» имеет aria-label "Играть: <name>"', () => {
    render(<GameTile game={game()} action={playAction} />);
    expect(
      screen.getByRole("button", { name: "Играть: Portal 2" }),
    ).toBeTruthy();
  });

  it("resume показывает «Вернуться в игру»", () => {
    render(<GameTile game={game()} action={resumeAction} />);
    expect(
      screen.getByRole("button", { name: "Вернуться в игру" }),
    ).toBeTruthy();
  });

  it("blocked — без кнопки", () => {
    render(<GameTile game={game()} action={blockedAction} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("обложка: header.jpg → ошибка → coverUrl → ошибка → заглушка с именем", () => {
    render(<GameTile game={game({ name: "Hades" })} action={playAction} />);
    const header = screen.getByAltText("Hades") as HTMLImageElement;
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

  it("caption заменяет строку статуса целиком", () => {
    render(
      <GameTile
        game={game({ cloud: missing })}
        action={playAction}
        caption="2 играют"
      />,
    );
    expect(screen.getByText("2 играют")).toBeTruthy();
    expect(screen.queryByText(/нужна установка/)).toBeNull();
  });

  it("без Proton-плашки, когда tier не указан", () => {
    render(<GameTile game={game()} action={playAction} />);
    expect(screen.queryByTestId("proton-tag")).toBeNull();
  });

  it('без Proton-плашки для "pending"', () => {
    render(
      <GameTile game={game({ protonTier: "pending" })} action={playAction} />,
    );
    expect(screen.queryByTestId("proton-tag")).toBeNull();
  });

  it("показывает уровень Proton моно-шрифтом", () => {
    render(
      <GameTile game={game({ protonTier: "gold" })} action={playAction} />,
    );
    expect(screen.getByText("gold")).toBeTruthy();
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
});
