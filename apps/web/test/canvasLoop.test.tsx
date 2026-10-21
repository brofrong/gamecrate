import { describe, expect, it, mock } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { type DrawFrame, useCanvasLoop } from "../src/lib/useCanvasLoop";

const stubMotion = (reduced: boolean) => {
  window.matchMedia = (() => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
};
const fakeCtx = { setTransform() {}, clearRect() {} };

// happy-dom объявляет IntersectionObserver, но никогда не вызывает колбэк —
// подменяем наблюдателем, который сразу сообщает «виден».
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

function Probe({ draw }: { draw: DrawFrame }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasLoop(ref, draw);
  return (
    <div style={{ width: 300, height: 100 }}>
      <canvas ref={ref} />
    </div>
  );
}

describe("canvas loop", () => {
  it("canvas loop is a no-op without a 2d context", async () => {
    stubMotion(false);
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    const draw = mock(() => {});
    render(<Probe draw={draw} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(draw).not.toHaveBeenCalled();
  });

  it("canvas loop draws once when motion is reduced", async () => {
    stubMotion(true);
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as never;
    const draw = mock(() => {});
    render(<Probe draw={draw} />);
    await waitFor(() => expect(draw).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("canvas loop keeps drawing when motion is allowed", async () => {
    stubMotion(false);
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as never;
    const draw = mock(() => {});
    render(<Probe draw={draw} />);
    await waitFor(() => expect(draw.mock.calls.length).toBeGreaterThan(2));
  });
});
