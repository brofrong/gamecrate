import { describe, expect, it } from "bun:test";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  DEFAULT_METRICS,
  fullWidth,
  LEFT_BAND,
} from "../src/components/brand/logo-geometry";
import { Logo } from "../src/components/brand/Logo";
import { useScrollProgress } from "../src/components/brand/useScrollProgress";

/** Подменяет prefers-reduced-motion и текущий scrollY. */
const stubMotion = (reduced: boolean) => {
  window.matchMedia = (() => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
};
const scrollTo = (y: number) =>
  act(() => {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    window.dispatchEvent(new Event("scroll"));
  });

describe("logo", () => {
  it("logo renders full lockup at progress 0", () => {
    render(<Logo progress={0} metrics={DEFAULT_METRICS} />);
    const svg = screen.getByRole("img", { name: "GameCrate" });
    expect(svg.getAttribute("viewBox")).toBe(
      `0 0 ${fullWidth(DEFAULT_METRICS)} 220`,
    );
    expect(svg.textContent).toContain("ame");
    expect(svg.textContent).toContain("Games in containers");
  });

  it("logo renders compact mark at progress 1", () => {
    render(<Logo progress={1} metrics={DEFAULT_METRICS} />);
    expect(screen.getByRole("img").getAttribute("viewBox")).toBe("0 0 200 220");
  });

  it("iconOnly never shows the wordmark", () => {
    render(<Logo iconOnly />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("viewBox")).toBe("0 0 200 220");
    expect(svg.textContent).not.toContain("ame");
  });

  it("scroll progress snaps when motion is reduced", async () => {
    stubMotion(true);
    const { result } = renderHook(() => useScrollProgress());
    scrollTo(300);
    expect(result.current).toBe(1);
  });

  it("iconOnly keeps the ring at progress 0 and the cube at 1", () => {
    const band = (el: HTMLElement) =>
      el
        .querySelector(`polygon[points="${LEFT_BAND}"]`)
        ?.getAttribute("opacity");
    const ring = render(<Logo iconOnly progress={0} />);
    expect(band(ring.container)).toBe("1");
    ring.unmount();
    const cube = render(<Logo iconOnly progress={1} />);
    expect(band(cube.container)).toBe("0");
  });

  it("scroll progress eases toward the target", async () => {
    stubMotion(false);
    scrollTo(0);
    const { result } = renderHook(() => useScrollProgress());
    scrollTo(90);
    await waitFor(() => expect(result.current).toBeCloseTo(0.5, 1));
  });
});
