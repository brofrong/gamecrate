// Медиа на странице игры (спека 2026-10-27 §3.5): трейлер первым, скриншоты,
// «ещё N», лайтбокс с клавиатурой, видео по клику на постер (HLS нативно, если
// `<video>` умеет m3u8 — в тесте `canPlayType` замокан, чтобы не тянуть hls.js).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GameDetails } from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import { MediaStrip } from "../src/components/app/game/MediaStrip";

const details = (patch: Partial<GameDetails> = {}): GameDetails => ({
  shortDescription: "",
  aboutTheGame: "",
  developers: [],
  publishers: [],
  genres: [],
  releaseDate: null,
  metacriticScore: null,
  metacriticUrl: null,
  controllerSupport: null,
  linux: false,
  achievementsTotal: 0,
  screenshots: Array.from({ length: 12 }, (_, i) => ({
    thumb: `https://cdn/ss_${i}.600x338.jpg`,
    full: `https://cdn/ss_${i}.1920x1080.jpg`,
  })),
  movies: [
    {
      name: "Трейлер",
      thumbnail: "https://cdn/movie.jpg",
      hls: "https://video/hls_264_master.m3u8",
      highlight: true,
    },
  ],
  ...patch,
});

const originalCanPlayType = HTMLMediaElement.prototype.canPlayType;

beforeEach(() => {
  HTMLMediaElement.prototype.canPlayType = () => "probably";
});
afterEach(() => {
  HTMLMediaElement.prototype.canPlayType = originalCanPlayType;
});

describe("MediaStrip", () => {
  it("renders trailer poster first and the first 7 screenshots, with «ещё N»", () => {
    render(<MediaStrip details={details()} name="Baldur's Gate 3" />);
    expect(
      screen.getByRole("button", { name: "Смотреть трейлер: Baldur's Gate 3" }),
    ).toBeTruthy();
    const shots = screen.getAllByRole("button", { name: /^Скриншот \d+/ });
    expect(shots).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "ещё 5" }));
    expect(
      screen.getAllByRole("button", { name: /^Скриншот \d+/ }),
    ).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /^ещё/ })).toBeNull();
  });

  it("click on a screenshot opens the lightbox with the full image; Esc closes", () => {
    render(<MediaStrip details={details()} name="Baldur's Gate 3" />);
    fireEvent.click(screen.getByRole("button", { name: "Скриншот 2" }));
    const dialog = screen.getByRole("dialog");
    const img = dialog.querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("https://cdn/ss_1.1920x1080.jpg");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("arrow keys move between screenshots", () => {
    render(<MediaStrip details={details()} name="Baldur's Gate 3" />);
    fireEvent.click(screen.getByRole("button", { name: "Скриншот 1" }));
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(
      (screen.getByRole("dialog").querySelector("img") as HTMLImageElement).src,
    ).toBe("https://cdn/ss_1.1920x1080.jpg");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    // С первого — на последний (по кругу).
    expect(
      (screen.getByRole("dialog").querySelector("img") as HTMLImageElement).src,
    ).toBe("https://cdn/ss_11.1920x1080.jpg");
  });

  it("trailer poster click mounts a video element", () => {
    render(<MediaStrip details={details()} name="Baldur's Gate 3" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Смотреть трейлер: Baldur's Gate 3" }),
    );
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video).toBeTruthy();
    expect(video.getAttribute("src")).toBe("https://video/hls_264_master.m3u8");
  });

  it("no panel when there is no media", () => {
    const { container } = render(
      <MediaStrip
        details={details({ screenshots: [], movies: [] })}
        name="Tool"
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
