// Блок «Запускал недавно»: пусто — ничего не рендерится; карточки с датой/длительностью
// моно-шрифтом, статусом и кнопкой «Играть», которая зовёт `play.onPlay(appId)`.
import { describe, expect, it, mock } from "bun:test";
import type { RecentEntry } from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { RecentRow } from "../src/components/app/RecentRow";
import type { LibraryPlay } from "../src/lib/cardAction";
import { testRouter } from "./router";

const idlePlay: LibraryPlay = {
  active: null,
  startingAppId: null,
  onPlay: () => {},
  onResume: () => {},
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

const hades: RecentEntry = {
  appId: 1145360,
  name: "Hades",
  coverUrl:
    "https://cdn.cloudflare.steamstatic.com/steam/apps/1145360/library_600x900_2x.jpg",
  cloud: { _tag: "Ready" },
  lastPlayedAt: isoDaysAgo(1),
  lastDurationMinutes: 134,
};

const eldenRing: RecentEntry = {
  appId: 1245620,
  name: "Elden Ring",
  coverUrl:
    "https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900_2x.jpg",
  cloud: { _tag: "Missing" },
  lastPlayedAt: isoDaysAgo(3),
  lastDurationMinutes: 52,
};

describe("RecentRow", () => {
  it("renders nothing when there are no items", () => {
    const { container } = render(<RecentRow items={[]} play={idlePlay} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows cards with relative date, duration, status and plays on click", async () => {
    const onPlay = mock(() => {});
    render(
      <RouterProvider
        router={testRouter(
          <RecentRow
            items={[hades, eldenRing]}
            play={{ ...idlePlay, onPlay }}
          />,
        )}
      />,
    );
    expect(await screen.findByText("Запускал недавно")).toBeTruthy();
    expect(screen.getByText("вчера · 2 ч 14 м")).toBeTruthy();
    expect(screen.getByText("Hades")).toBeTruthy();
    expect(screen.getByText("Готова")).toBeTruthy();
    expect(screen.getByText("Elden Ring")).toBeTruthy();
    expect(screen.getByText("нужна установка")).toBeTruthy();
    const link = screen.getByRole("link", { name: "все сессии →" });
    expect(link.getAttribute("href")).toBe("/app/time");

    const buttons = screen.getAllByRole("button", { name: "Играть" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(1145360);
  });
});
