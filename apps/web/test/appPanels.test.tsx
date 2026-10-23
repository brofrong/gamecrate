// Правая колонка `/app`: панели Steam/Время/активная сессия/установки/«Скоро».
// Рендерим компоненты напрямую с пропсами (без атомов) — композицию в `aside`/`sticky`
// проверяет `myGamesPage.test.tsx`. `Link` внутри (`TimePanel`) требует `RouterProvider`.
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { CurrentUserShape, SessionView, TimeSummary } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { ActiveSessionPanel } from "../src/components/app/ActiveSessionPanel";
import { ComingSoonPanel } from "../src/components/app/ComingSoonPanel";
import { InstallsPanel } from "../src/components/app/InstallsPanel";
import { TimePanel } from "../src/components/app/TimePanel";
import { testRouter } from "./router";

// `SteamPanel` зовёт `toast.success`/`toast.error` из "sonner" при копировании
// Steam ID — подменяем модуль, чтобы проверить, какой тост вызван, без рендера
// `<Toaster/>`. `mock.module` подменяет "sonner" на весь прогон `bun test` (как
// `../src/rpc` в `myGamesPage.test.tsx`), поэтому мок несёт и `Toaster` (пусть и
// заглушкой) — иначе падают другие файлы, чей `<Toaster/>` (`routes/__root.tsx`) эту
// же подмену и получает. `SteamPanel` импортируем динамически, после `mock.module`:
// статический импорт зафиксировал бы настоящий `sonner` до того, как подмена встанет.
const toastSuccess = mock(() => {});
const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
  Toaster: () => null,
}));

const { SteamPanel } = await import("../src/components/app/SteamPanel");

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
});

const user: CurrentUserShape = {
  id: "u1",
  name: "Brofrong",
  image: null,
  role: "player",
  steamId: "76561198020550802",
  email: null,
  emailVerified: false,
};

const session = (patch: Partial<SessionView> = {}): SessionView => ({
  id: "s1",
  appId: 1086940,
  gameName: "Baldur's Gate 3",
  state: "playing",
  streamReady: true,
  failReason: null,
  idleDeadline: null,
  installPercent: null,
  playedSeconds: 3600,
  createdAt: "2026-10-23T10:00:00.000Z",
  ...patch,
});

describe("SteamPanel", () => {
  // `SteamPanel` не рендерит `Link` — в отличие от `TimePanel`, рендерим его без
  // `RouterProvider` и запрашиваем синхронно (`getBy*`, не `findBy*`).
  it("shows a link button when the user has no Steam linked", () => {
    render(
      <SteamPanel
        user={{ ...user, steamId: null }}
        view={undefined}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Привязать Steam" }),
    ).toBeTruthy();
    expect(screen.queryByText("Привязан")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Обновить библиотеку" }),
    ).toBeNull();
  });

  it("shows stats, the refresh button and copies the Steam ID", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onRefresh = mock(() => {});

    render(
      <SteamPanel
        user={user}
        view={{
          _tag: "Ready",
          entries: [
            {
              appId: 1,
              name: "Hades",
              playtimeMinutes: 10,
              protonTier: "pending",
              coverUrl: "https://example.com/1.jpg",
              cloud: { _tag: "Ready" },
              lastPlayedAt: null,
            },
            {
              appId: 2,
              name: "Elden Ring",
              playtimeMinutes: 10,
              protonTier: "pending",
              coverUrl: "https://example.com/2.jpg",
              cloud: { _tag: "Missing" },
              lastPlayedAt: null,
            },
          ],
          syncedAt: "2026-10-23T09:55:00.000Z",
          steamProfile: true,
        }}
        onRefresh={onRefresh}
        refreshing={false}
      />,
    );

    expect(screen.getByText("Привязан")).toBeTruthy();
    expect(screen.getByText("76561198020550802")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    const refreshButton = screen.getByRole("button", {
      name: "Обновить библиотеку",
    });
    expect(refreshButton).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Скопировать Steam ID" }),
    );
    expect(writeText).toHaveBeenCalledWith("76561198020550802");
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Скопировано"),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast and no success toast when the copy fails", async () => {
    const writeText = mock(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <SteamPanel
        user={user}
        view={{
          _tag: "Ready",
          entries: [],
          syncedAt: null,
          steamProfile: true,
        }}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Скопировать Steam ID" }),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Не удалось скопировать"),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("disables the refresh button while refreshing", () => {
    render(
      <SteamPanel
        user={user}
        view={{
          _tag: "Ready",
          entries: [],
          syncedAt: null,
          steamProfile: true,
        }}
        onRefresh={() => {}}
        refreshing={true}
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Обновить библиотеку",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("TimePanel", () => {
  // `TimePanel` рендерит `Link` — нужен `RouterProvider`, который резолвит первый
  // матч асинхронно (как в `appShell.test.tsx`): первый запрос — `findBy*`.
  it("shows an empty-month message without data", async () => {
    render(
      <RouterProvider router={testRouter(<TimePanel summary={undefined} />)} />,
    );
    expect(
      await screen.findByText("Ты ещё не играл в этом месяце"),
    ).toBeTruthy();
  });

  it("shows the total and top games in H:MM", async () => {
    const summary: TimeSummary = {
      month: "2026-10",
      totalMinutes: 897,
      sessionCount: 5,
      byGame: [
        { appId: 1086940, name: "Baldur's Gate 3", minutes: 460 },
        { appId: 1245620, name: "Elden Ring", minutes: 312 },
        { appId: 1145360, name: "Hades", minutes: 125 },
      ],
      sessions: [],
    };
    render(
      <RouterProvider router={testRouter(<TimePanel summary={summary} />)} />,
    );
    expect(await screen.findByText("14 ч 57 м")).toBeTruthy();
    expect(screen.getByText("Baldur's Gate 3")).toBeTruthy();
    expect(screen.getByText("7:40")).toBeTruthy();
    expect(screen.getByText("Elden Ring")).toBeTruthy();
    expect(screen.getByText("5:12")).toBeTruthy();
    expect(screen.getByText("Hades")).toBeTruthy();
    expect(screen.getByText("2:05")).toBeTruthy();
    const link = screen.getByRole("link", { name: "подробнее →" });
    expect(link.getAttribute("href")).toBe("/app/time");
  });
});

describe("ActiveSessionPanel", () => {
  it("shows the install percent while installing", () => {
    render(
      <ActiveSessionPanel
        session={session({ state: "installing", installPercent: 63 })}
        onResume={() => {}}
      />,
    );
    expect(screen.getByText("устанавливается 63 %")).toBeTruthy();
  });

  it("shows the generic label without a known percent", () => {
    render(
      <ActiveSessionPanel
        session={session({ state: "installing", installPercent: null })}
        onResume={() => {}}
      />,
    );
    expect(screen.getByText("устанавливается")).toBeTruthy();
  });

  it("calls onResume and shows the full label by default", () => {
    const onResume = mock(() => {});
    render(
      <ActiveSessionPanel
        session={session({ state: "playing" })}
        onResume={onResume}
      />,
    );
    expect(screen.getByText("играет")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Вернуться в игру" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("shows the short label when compact", () => {
    render(
      <ActiveSessionPanel
        session={session({ state: "queued" })}
        onResume={() => {}}
        compact
      />,
    );
    expect(screen.getByText("● в очереди")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Вернуться" })).toBeTruthy();
  });

  it("renders nothing for a terminal session", () => {
    const { container } = render(
      <ActiveSessionPanel
        session={session({ state: "ended" })}
        onResume={() => {}}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("InstallsPanel", () => {
  it("renders nothing when the session is not installing", () => {
    const { container } = render(
      <InstallsPanel session={session({ state: "playing" })} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the game name and percent while installing", () => {
    render(
      <InstallsPanel
        session={session({ state: "installing", installPercent: 63 })}
      />,
    );
    expect(screen.getByText("Baldur's Gate 3")).toBeTruthy();
    expect(screen.getByText("63 %")).toBeTruthy();
  });

  it("shows an ellipsis when the percent is not known yet", () => {
    render(
      <InstallsPanel
        session={session({ state: "installing", installPercent: null })}
      />,
    );
    expect(screen.getByText("…")).toBeTruthy();
  });
});

describe("ComingSoonPanel", () => {
  it("shows the name and a Скоро badge, hidden below md", () => {
    render(<ComingSoonPanel name="Epic Games" />);
    expect(screen.getByText("Epic Games")).toBeTruthy();
    expect(screen.getByText("Скоро")).toBeTruthy();
    const section = screen.getByText("Epic Games").closest("section");
    expect(section?.className).toContain("hidden");
    expect(section?.className).toContain("md:block");
  });
});
