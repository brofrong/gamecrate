// Полоска на телефоне (`SummaryStrip`, спека §4.6): плитка Steam/«Подключить Steam»,
// месяц, «Установка · N %». Без привязанного Steam плитки показываются сразу — не
// ждут, пока подтянется библиотека (`view` может быть `undefined`). Без Steam плитка
// ведёт на `/profile` — там живёт QR-подключение (`ConnectSteam` на `/app` — тоже
// туда же, но сразу в карточке сетки).
import { describe, expect, it } from "bun:test";
import {
  type CurrentUserShape,
  type LibraryView,
  OWN_APP_ID_MIN,
  type SessionView,
} from "@cg/rpc";
import { render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import type * as React from "react";
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
  stage: null,
  installStage: null,
  hadInstall: false,
  timing: null,
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

  it("the Steam tile counts Steam games only, not own games", async () => {
    const withOwn: LibraryView = {
      ...readyView,
      entries: [
        ...(readyView._tag === "Ready" ? readyView.entries : []),
        {
          appId: OWN_APP_ID_MIN + 1,
          name: "Ship of Harkinian",
          playtimeMinutes: 0,
          protonTier: "pending",
          coverUrl: "/own-games/1900000001/cover.jpg",
          cloud: { _tag: "Ready" },
          lastPlayedAt: null,
        },
      ],
    };
    renderStrip(<SummaryStrip user={user} view={withOwn} monthMinutes={0} />);
    expect(await screen.findByText("Steam · 2 игр · 1 готовы")).toBeTruthy();
  });

  it("shows «Подключить Steam» linking to /profile without a linked Steam account, even without a view", async () => {
    renderStrip(
      <SummaryStrip
        user={{ ...user, steamId: null }}
        view={undefined}
        monthMinutes={0}
      />,
    );
    const link = await screen.findByText("Подключить Steam");
    expect(link.closest("a")?.getAttribute("href")).toBe("/profile");
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
