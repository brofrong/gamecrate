import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

mock.module("../src/auth", () => ({
  signInWithSteam: async () => ({ error: undefined }),
  signOut: async () => {},
  signInWithPocketId: async () => {},
}));

const { CoverWall } = await import("../src/components/landing/CoverWall");
const { Hero } = await import("../src/components/landing/Hero");
const { TechFlow } = await import("../src/components/landing/TechFlow");
const { Hud } = await import("../src/components/landing/Hud");
const { headerUrl, heroAppIds, platforms, techNotes } =
  await import("../src/components/landing/data");

const stubMotion = (reduced: boolean) => {
  window.matchMedia = (() => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
};

describe("landing sections", () => {
  it("cover falls back to header.jpg once, then stays dark", () => {
    stubMotion(true);
    render(<CoverWall rows={1} perRow={1} />);
    const img = document.querySelector("img");
    if (!img) throw new Error("no cover");
    const fallback = headerUrl(heroAppIds[0] as number);
    fireEvent.error(img);
    expect(img.getAttribute("src")).toBe(fallback);
    fireEvent.error(img);
    expect(img.getAttribute("src")).toBe(fallback);
    expect(img.closest("[data-failed]")).toBeTruthy();
  });

  it("rows do not drift when motion is reduced", async () => {
    stubMotion(true);
    render(<CoverWall rows={2} perRow={2} />);
    await new Promise((r) => setTimeout(r, 60));
    const rows = document.querySelectorAll<HTMLElement>("[data-row]");
    expect(rows.length).toBe(2);
    rows.forEach((row) => expect(row.style.transform).toBe(""));
  });

  it("hero renders platforms, perks and play button", () => {
    stubMotion(true);
    render(<Hero error={false} />);
    for (const p of platforms) expect(screen.getByText(p)).toBeTruthy();
    expect(screen.getByText("До 4K · 60 FPS")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Играть" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/бесплатно|4090/);
  });

  it("tech section renders text without canvas", () => {
    stubMotion(true);
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    render(<TechFlow />);
    expect(screen.getByRole("heading", { name: /GPU там/ })).toBeTruthy();
    expect(screen.getByText("иллюстрация")).toBeTruthy();
    for (const k of ["FPS", "FRAMETIME", "LATENCY", "BITRATE"]) {
      expect(screen.getByText(k)).toBeTruthy();
    }
    for (const n of techNotes) expect(screen.getByText(n.title)).toBeTruthy();
  });

  it("hud updates values over time", async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    render(<Hud />);
    const first = screen.getByText(/Mbps/).textContent;
    await waitFor(
      () => expect(screen.getByText(/Mbps/).textContent).not.toBe(first),
      { timeout: 1500 },
    );
  });
});
