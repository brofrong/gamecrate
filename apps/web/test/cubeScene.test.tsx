import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { CubeScene } from "../src/components/login/CubeScene";

const stubMotion = (reduced: boolean) => {
  window.matchMedia = (() => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
};

// happy-dom объявляет IntersectionObserver, но никогда не вызывает колбэк —
// подменяем наблюдателем, который сразу сообщает «виден» (как в canvasLoop.test.tsx).
class VisibleObserver {
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as never,
    );
  }
  unobserve() {}
  disconnect() {}
}
window.IntersectionObserver = VisibleObserver as never;

describe("cube scene", () => {
  it("shows step labels, caption, and passed steps as done", () => {
    stubMotion(true);
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    render(<CubeScene level={1} tint={null} lit={false} />);

    expect(screen.getByText("учётка")).toBeTruthy();
    expect(screen.getByText("код")).toBeTruthy();
    expect(screen.getByText("облако")).toBeTruthy();
    expect(screen.getByText("Почти готово…")).toBeTruthy();

    expect(screen.getByText("учётка").className).toContain("on");
    expect(screen.getByText("код").className).toContain("on");
    expect(screen.getByText("облако").className).not.toContain("on");
  });
});
