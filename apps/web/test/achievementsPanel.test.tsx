// Панель достижений на странице игры (спека 2026-10-27 §3.5): Private — подсказка
// про приватность Steam, Ready — «N из M», открытые первыми, закрытые приглушены,
// скрытые без названия, «ещё N»; None/Unlinked — панели нет.
import { describe, expect, it } from "bun:test";
import type { GameAchievements } from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import { AchievementsPanel } from "../src/components/app/game/AchievementsPanel";

const unlocked = (n: number, name = `Открытое ${n}`) => ({
  apiName: `U${n}`,
  name,
  description: `описание ${n}`,
  icon: `https://cdn/u${n}.jpg`,
  unlockedAt: "2026-01-01T00:00:00.000Z",
});
const locked = (n: number, hidden = false) => ({
  apiName: `L${n}`,
  name: `Закрытое ${n}`,
  description: `описание ${n}`,
  iconGray: `https://cdn/l${n}.jpg`,
  hidden,
});

describe("AchievementsPanel", () => {
  it("Private → privacy notice with link", () => {
    render(<AchievementsPanel achievements={{ _tag: "Private" }} />);
    expect(screen.getByText(/Steam скрывает твои достижения/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Настройки приватности ↗" })
        .getAttribute("href"),
    ).toBe("https://steamcommunity.com/my/edit/settings");
  });

  it("Ready → «Достижения · 2 из 5», unlocked first, locked dimmed, hidden titled «Скрытое достижение»", () => {
    const achievements: GameAchievements = {
      _tag: "Ready",
      total: 5,
      unlocked: [unlocked(1), unlocked(2)],
      locked: [locked(1), locked(2, true), locked(3)],
    };
    render(<AchievementsPanel achievements={achievements} />);
    expect(screen.getByText("Достижения · 2 из 5")).toBeTruthy();
    const icons = screen.getAllByRole("img");
    expect(icons.map((img) => img.getAttribute("alt"))).toEqual([
      "Открытое 1",
      "Открытое 2",
      "Закрытое 1",
      "Скрытое достижение",
      "Закрытое 3",
    ]);
    expect(icons[0]!.getAttribute("src")).toBe("https://cdn/u1.jpg");
    expect(icons[2]!.getAttribute("src")).toBe("https://cdn/l1.jpg");
    expect(icons[2]!.closest("[data-locked]")).toBeTruthy();
    expect(icons[0]!.closest("[data-locked]")).toBeNull();
  });

  it("more than 32 → «ещё N» reveals all", () => {
    const achievements: GameAchievements = {
      _tag: "Ready",
      total: 40,
      unlocked: Array.from({ length: 10 }, (_, i) => unlocked(i)),
      locked: Array.from({ length: 30 }, (_, i) => locked(i)),
    };
    render(<AchievementsPanel achievements={achievements} />);
    expect(screen.getAllByRole("img")).toHaveLength(32);
    fireEvent.click(screen.getByRole("button", { name: "ещё 8" }));
    expect(screen.getAllByRole("img")).toHaveLength(40);
  });

  it("None and Unlinked render nothing", () => {
    const none = render(<AchievementsPanel achievements={{ _tag: "None" }} />);
    expect(none.container.innerHTML).toBe("");
    none.unmount();
    const unlinked = render(
      <AchievementsPanel achievements={{ _tag: "Unlinked" }} />,
    );
    expect(unlinked.container.innerHTML).toBe("");
  });
});
