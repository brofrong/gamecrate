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
const { HowItWorks } = await import("../src/components/landing/HowItWorks");
const { Plans, formatRub } = await import("../src/components/landing/Plans");
const { Achievements } = await import("../src/components/landing/Achievements");
const {
  achievements,
  headerUrl,
  heroAppIds,
  plans,
  platforms,
  steps,
  techNotes,
} = await import("../src/components/landing/data");

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

  it("how it works lists three steps and jumps on click", () => {
    stubMotion(false);
    render(<HowItWorks />);
    for (const s of steps) {
      expect(screen.getByRole("heading", { name: s.title })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("heading", { name: "Нажми Играть" }));
    expect(screen.getByText("Поднимаем контейнер…")).toBeTruthy();
    expect(screen.getByText("здесь будет живое видео стрима")).toBeTruthy();
  });

  it("reduced motion shows the final frame", () => {
    stubMotion(true);
    render(<HowItWorks />);
    expect(screen.getByText("здесь будет живое видео стрима")).toBeTruthy();
  });

  it("plans show three tiers with placeholder badge", () => {
    render(<Plans />);
    expect(screen.getByText("цены и цифры — предварительные")).toBeTruthy();
    for (const p of plans) {
      expect(screen.getByRole("heading", { name: p.name })).toBeTruthy();
    }
    expect(screen.getByText("ПОПУЛЯРНЫЙ")).toBeTruthy();
    expect(formatRub(1490)).toBe("1\u202f490\u00a0₽");
    expect(formatRub(37)).toBe("37\u00a0₽");
    expect(screen.getAllByRole("button", { name: "Выбрать" }).length).toBe(3);
  });

  it("achievements render eight cards, two seasonal locked", () => {
    render(<Achievements />);
    for (const a of achievements)
      expect(screen.getByText(a.title)).toBeTruthy();
    expect(screen.getAllByText(/Сезонная/).length).toBe(2);
  });
});
