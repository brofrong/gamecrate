// Полоска на телефоне (`SummaryStrip`, спека §4.6): плитка Steam/«Привязать Steam»,
// месяц, «Установка · N %». Без привязанного Steam плитки показываются сразу — не
// ждут, пока подтянется библиотека (`view` может быть `undefined`).
//
// `spyOn` на реальный модуль «../src/auth» (а не `mock.module`, которая подменяет
// модуль целиком и глобально на весь прогон `bun test` — см. комментарий в
// login.test.tsx), чтобы не ломать другие тестовые файлы.
import { describe, expect, it, spyOn } from "bun:test";
import type { CurrentUserShape, LibraryView, SessionView } from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import type * as React from "react";
import * as auth from "../src/auth";
import { SummaryStrip } from "../src/components/app/SummaryStrip";
import { testRouter } from "./router";

const user: CurrentUserShape = {
  id: "u1",
  name: "Gamer",
  image: null,
  role: "player",
  steamId: "7656",
  email: null,
  emailVerified: false,
};

const readyView: LibraryView = {
  _tag: "Ready",
  entries: [
    {
      appId: 1,
      name: "Hades",
      playtimeMinutes: 10,
      protonTier: "platinum",
      coverUrl: "https://example.com/1.jpg",
      cloud: { _tag: "Ready" },
      lastPlayedAt: null,
    },
    {
      appId: 2,
      name: "Elden Ring",
      playtimeMinutes: 0,
      protonTier: "gold",
      coverUrl: "https://example.com/2.jpg",
      cloud: { _tag: "Missing" },
      lastPlayedAt: null,
    },
  ],
  syncedAt: "2026-10-23T10:00:00.000Z",
  steamProfile: true,
};

const installingSession: SessionView = {
  id: "s1",
  appId: 1,
  gameName: "Hades",
  state: "installing",
  streamReady: false,
  failReason: null,
  idleDeadline: null,
  installPercent: 63,
  playedSeconds: 0,
  createdAt: "2026-10-23T10:00:00.000Z",
};

const renderStrip = (ui: React.ReactElement) =>
  render(<RouterProvider router={testRouter(ui)} />);

describe("SummaryStrip", () => {
  it("shows the Steam tile with counts, linking to /profile", async () => {
    renderStrip(
      <SummaryStrip user={user} view={readyView} monthMinutes={897} />,
    );
    const link = await screen.findByText("Steam · 2 игр · 1 готовы");
    expect(link.closest("a")?.getAttribute("href")).toBe("/profile");
  });

  it("shows «Привязать Steam» without a linked Steam account, even without a view", async () => {
    const linkSteam = spyOn(auth, "linkSteam").mockResolvedValue(
      undefined as never,
    );
    renderStrip(
      <SummaryStrip
        user={{ ...user, steamId: null }}
        view={undefined}
        monthMinutes={0}
      />,
    );
    const button = await screen.findByRole("button", {
      name: "Привязать Steam",
    });
    fireEvent.click(button);
    expect(linkSteam).toHaveBeenCalledWith("/app");
    linkSteam.mockRestore();
  });

  it("the month tile always links to /app/time, with or without a view", async () => {
    renderStrip(
      <SummaryStrip
        user={{ ...user, steamId: null }}
        view={undefined}
        monthMinutes={897}
      />,
    );
    const link = await screen.findByText(/14 ч 57 м/);
    expect(link.closest("a")?.getAttribute("href")).toBe("/app/time");
  });

  it("shows an install tile with the percent while a session is installing", async () => {
    renderStrip(
      <SummaryStrip
        user={user}
        view={readyView}
        monthMinutes={0}
        activeSession={installingSession}
      />,
    );
    expect(await screen.findByText("Установка · 63 %")).toBeTruthy();
  });

  it("hides the install tile otherwise", async () => {
    renderStrip(<SummaryStrip user={user} view={readyView} monthMinutes={0} />);
    await screen.findByText(/Steam/);
    expect(screen.queryByText(/Установка/)).toBeNull();
  });
});
