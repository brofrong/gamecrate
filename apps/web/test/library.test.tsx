import { describe, expect, it, mock, spyOn } from "bun:test";
import type { LibraryEntry, LibraryView } from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import * as auth from "../src/auth";
import {
  LibraryContent,
  type LibraryPlay,
} from "../src/components/LibraryContent";
import { ConnectSteam } from "../src/routes/library";

const game: LibraryEntry = {
  appId: 620,
  name: "Portal 2",
  playtimeMinutes: 754,
  protonTier: "platinum",
  coverUrl:
    "https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900_2x.jpg",
};

const ready = (
  entries: ReadonlyArray<LibraryEntry>,
  syncedAt: string | null = "2026-10-17T10:00:00.000Z",
): LibraryView => ({ _tag: "Ready", entries, syncedAt });

const idlePlay: LibraryPlay = {
  active: null,
  startingAppId: null,
  onPlay: () => {},
  onResume: () => {},
};

const renderLibrary = (
  view: LibraryView,
  onRefresh = () => {},
  play: LibraryPlay = idlePlay,
) =>
  render(
    <LibraryContent
      view={view}
      onRefresh={onRefresh}
      refreshing={false}
      play={play}
    />,
  );

describe("library", () => {
  it("library renders private profile screen", () => {
    renderLibrary({ _tag: "Private" });
    expect(screen.getByText("Откройте „Сведения об играх“")).toBeTruthy();
    const link = screen.getByRole("link", { name: /настройки приватности/i });
    expect(link.getAttribute("href")).toBe(
      "https://steamcommunity.com/my/edit/settings",
    );
    expect(screen.queryByText("В библиотеке пока нет игр")).toBeNull();
  });

  it("library renders empty state", () => {
    renderLibrary(ready([]));
    expect(screen.getByText("В библиотеке пока нет игр")).toBeTruthy();
  });

  it("library renders steam unavailable when never synced", () => {
    const onRefresh = mock(() => {});
    renderLibrary(ready([], null), onRefresh);
    expect(
      screen.getByText("Steam сейчас недоступен. Попробуйте обновить позже."),
    ).toBeTruthy();
    expect(screen.queryByText("В библиотеке пока нет игр")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("library renders game cards with cover, name, tier and playtime", () => {
    renderLibrary(ready([game]));
    expect(screen.getByText("Portal 2")).toBeTruthy();
    expect(screen.getByText("Работает идеально")).toBeTruthy();
    expect(screen.getByText("12 ч 34 мин")).toBeTruthy();
    const cover = screen.getByRole("img", { name: "Portal 2" });
    expect(cover.getAttribute("src")).toBe(game.coverUrl);
  });

  it("library play button starts the game", () => {
    const onPlay = mock((_appId: number) => {});
    renderLibrary(ready([game]), () => {}, { ...idlePlay, onPlay });
    const play = screen.getByRole("button", { name: "Играть" });
    expect((play as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(play);
    expect(onPlay).toHaveBeenCalledWith(620);
  });

  it("library play waits for the active session and a pending start", () => {
    const loading = renderLibrary(ready([game]), () => {}, {
      ...idlePlay,
      active: undefined,
    });
    const play = screen.getByRole("button", { name: "Играть" });
    expect((play as HTMLButtonElement).disabled).toBe(true);
    loading.unmount();

    renderLibrary(ready([game]), () => {}, { ...idlePlay, startingAppId: 620 });
    const pending = screen.getByRole("button", { name: "Играть" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
  });

  it("connect steam opens the QR login", () => {
    const linkSteam = spyOn(auth, "linkSteam").mockResolvedValue(
      undefined as never,
    );
    const onDone = mock(() => {});
    const QrLogin = ({
      title,
      onDone: fire,
    }: {
      title: string;
      onDone: () => void;
    }) => (
      <div>
        <p>{title}</p>
        <button onClick={fire}>готово (фейк)</button>
      </div>
    );
    render(<ConnectSteam onDone={onDone} QrLogin={QrLogin} />);
    expect(screen.getByText("Подключите Steam")).toBeTruthy();
    expect(screen.queryByText("Ждём сканирования")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Подключить Steam" }));
    expect(screen.getAllByText("Подключите Steam").length).toBeGreaterThan(1);
    expect(linkSteam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "готово (фейк)" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    linkSteam.mockRestore();
  });
});
