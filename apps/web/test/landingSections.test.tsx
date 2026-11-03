import { describe, expect, it, mock } from "bun:test";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { createRef } from "react";
import { authStub } from "./moduleStubs";
import { testRouter } from "./router";

// Все имена `../src/auth` (подмена — на весь прогон, см. `moduleStubs.ts`).
mock.module("../src/auth", authStub);

const { CoverWall } = await import("../src/components/landing/CoverWall");
const { Hero } = await import("../src/components/landing/Hero");
const { TechFlow, nudgeAwayFromCursor } =
  await import("../src/components/landing/TechFlow");
const { Hud } = await import("../src/components/landing/Hud");
type HudHandle = import("../src/components/landing/Hud").HudHandle;
const { HowItWorks } = await import("../src/components/landing/HowItWorks");
const { Plans, formatRub } = await import("../src/components/landing/Plans");
const { FaqChat } = await import("../src/components/landing/FaqChat");
const { Achievements } = await import("../src/components/landing/Achievements");
const { StreamVideo } = await import("../src/components/landing/StreamVideo");
const {
  achievements,
  faq,
  headerUrl,
  heroAppIds,
  plans,
  platforms,
  steps,
  techNotes,
} = await import("../src/components/landing/data");

// happy-dom объявляет IntersectionObserver, но не вызывает колбэк — подменяем
// наблюдателем, который сразу сообщает «виден» (как в canvasLoop.test.tsx).
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pointer = (type: string, pointerType: string) => {
  const e = new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 });
  Object.defineProperty(e, "pointerType", { value: pointerType });
  return e;
};

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

  it("rows drift when motion is allowed", async () => {
    stubMotion(false);
    render(<CoverWall rows={1} perRow={1} />);
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>("[data-row]")?.style.transform,
      ).not.toBe(""),
    );
  });

  it("rows do not drift when motion is reduced", async () => {
    stubMotion(true);
    render(<CoverWall rows={2} perRow={2} />);
    await sleep(120);
    const rows = document.querySelectorAll<HTMLElement>("[data-row]");
    expect(rows.length).toBe(2);
    rows.forEach((row) => expect(row.style.transform).toBe(""));
  });

  it("mouse holds the row under the pointer, touch does not", () => {
    stubMotion(false);
    render(<CoverWall rows={1} perRow={1} />);
    const row = document.querySelector<HTMLElement>("[data-row]");
    if (!row) throw new Error("no row");
    const section = row.parentElement?.parentElement;
    if (!section) throw new Error("no section");
    document.elementFromPoint = () => row;
    section.dispatchEvent(pointer("pointermove", "touch"));
    expect(row.classList.contains("hold")).toBe(false);
    section.dispatchEvent(pointer("pointermove", "mouse"));
    expect(row.classList.contains("hold")).toBe(true);
    section.dispatchEvent(pointer("pointerleave", "mouse"));
    expect(row.classList.contains("hold")).toBe(false);
  });

  it("hero renders platforms, perks and play button", async () => {
    stubMotion(true);
    render(<RouterProvider router={testRouter(<Hero />)} />);
    expect(await screen.findByRole("link", { name: "Играть" })).toBeTruthy();
    for (const p of platforms) expect(screen.getByText(p)).toBeTruthy();
    expect(screen.getByText("До 4K · 60 FPS")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/бесплатно|4090/);
  });

  it("tech section renders text without canvas", () => {
    // Без 2D-контекста нет сцены (и ноутбука с HUD внутри), но заголовок, подпись
    // и заметки на месте, ошибок нет.
    stubMotion(true);
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    render(<TechFlow />);
    expect(screen.getByRole("heading", { name: /GPU там/ })).toBeTruthy();
    expect(screen.getByText("частицы обходят курсор")).toBeTruthy();
    for (const n of techNotes) expect(screen.getByText(n.title)).toBeTruthy();
  });

  it("hud stays still when driven without ticks or when motion is reduced", async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    stubMotion(false);
    const driven = render(<Hud driven />);
    const a = screen.getByText(/Mbps/).textContent;
    await sleep(300);
    expect(screen.getByText(/Mbps/).textContent).toBe(a);
    driven.unmount();
    stubMotion(true);
    render(<Hud />);
    const b = screen.getByText(/Mbps/).textContent;
    await sleep(300);
    expect(screen.getByText(/Mbps/).textContent).toBe(b);
  });

  it("hud ticks when its driver calls tick", () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    const ref = createRef<HudHandle>();
    render(<Hud ref={ref} driven />);
    const texts = () =>
      [...document.querySelectorAll(".tabular-nums")]
        .map((e) => e.textContent)
        .join("|");
    const t0 = texts();
    act(() => ref.current?.tick(0, 0));
    act(() => ref.current?.tick(200, 6));
    expect(texts()).not.toBe(t0);
  });

  it("hud updates values over time", async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    stubMotion(false);
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
      // `level: 3` отличает заголовок шага от заголовка демо-фазы «Привяжи Steam»
      // (у фазы QR тот же текст, но это `h4` внутри демо-сцены).
      expect(
        screen.getByRole("heading", { name: s.title, level: 3 }),
      ).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("heading", { name: "Нажми Играть" }));
    expect(screen.getByText("Поднимаем облако…")).toBeTruthy();
    expect(document.querySelector('[aria-hidden="false"] video')).toBeTruthy();
  });

  it("reduced motion shows the final frame", () => {
    stubMotion(true);
    render(<HowItWorks />);
    expect(document.querySelector("[data-active] h3")?.textContent).toBe(
      "Нажми Играть",
    );
    expect(
      document.querySelector('[aria-hidden="false"] .aspect-video'),
    ).toBeTruthy();
    expect(
      document.querySelector('[aria-hidden="true"] .aspect-video'),
    ).toBeNull();
  });

  it("plans show three tiers with placeholder badge", async () => {
    render(<RouterProvider router={testRouter(<Plans />)} />);
    expect(
      await screen.findByText("цены и цифры — предварительные"),
    ).toBeTruthy();
    for (const p of plans) {
      expect(screen.getByRole("heading", { name: p.name })).toBeTruthy();
    }
    expect(screen.getByText("ПОПУЛЯРНЫЙ")).toBeTruthy();
    expect(formatRub(1490)).toBe("1\u202f490\u00a0₽");
    expect(formatRub(37)).toBe("37\u00a0₽");
    expect(screen.getAllByRole("link", { name: "Выбрать" }).length).toBe(3);
  });

  it("achievements render eight cards, two seasonal locked", () => {
    render(<Achievements />);
    for (const a of achievements)
      expect(screen.getByText(a.title)).toBeTruthy();
    expect(screen.getAllByText(/Сезонная/).length).toBe(2);
  });

  it("faq renders all pairs", () => {
    render(<FaqChat />);
    for (const { q, a } of faq) {
      expect(screen.getByText(q)).toBeTruthy();
      expect(screen.getByText(a)).toBeTruthy();
    }
  });

  it("particles are pushed away from the cursor", () => {
    const p = { dx: 0, dy: 0 };
    nudgeAwayFromCursor(p, 100, 100, { x: 130, y: 100, inside: true });
    expect(p.dx).toBeLessThan(0);
    expect(Math.abs(p.dy)).toBeLessThan(1e-9);
    const far = { dx: 0, dy: 0 };
    nudgeAwayFromCursor(far, 100, 100, { x: 900, y: 100, inside: true });
    expect(far.dx).toBe(0);
  });

  it("faq section is centered", () => {
    render(<FaqChat />);
    const h2 = screen.getByRole("heading", { name: "Обычно спрашивают" });
    expect(h2.closest(".text-center")).toBeTruthy();
    expect(
      document.querySelector("[data-msg]")?.parentElement?.className,
    ).toContain("mx-auto");
  });

  it("stream video fills the laptop screen and the demo's last phase", () => {
    // Контекст-заглушка: любой метод — no-op, возвращающий её же (градиенты и т.п.).
    const fakeCtx: object = new Proxy(() => fakeCtx, {
      get: (_, key) => (key === "then" ? undefined : fakeCtx),
      set: () => true,
    });
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as never;
    stubMotion(true);
    const tech = render(<TechFlow />);
    const screenVideo = document.querySelector("#tech video");
    expect(screenVideo).toBeTruthy();
    expect(screen.queryByText("здесь будет живое видео стрима")).toBeNull();
    tech.unmount();
    render(<HowItWorks />);
    expect(
      document.querySelector('[aria-hidden="false"] .aspect-video video'),
    ).toBeTruthy();
    expect(screen.queryByText("здесь будет живое видео стрима")).toBeNull();
  });

  it("stream video is a muted loop with a poster", () => {
    stubMotion(false);
    render(<StreamVideo />);
    const v = document.querySelector("video") as HTMLVideoElement;
    expect(v.getAttribute("src")).toContain("landing-stream");
    expect(v.getAttribute("src")).toContain(".mp4");
    expect(v.getAttribute("poster")).toContain("landing-stream");
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.hasAttribute("playsinline")).toBe(true);
    expect(v.getAttribute("preload")).toBe("none");
  });

  it("stream video plays only when visible, active and motion is allowed", () => {
    const play = mock(() => Promise.resolve());
    const pause = mock(() => {});
    const proto = HTMLMediaElement.prototype;
    const original = { play: proto.play, pause: proto.pause };
    proto.play = play as never;
    proto.pause = pause as never;
    try {
      stubMotion(false);
      const a = render(<StreamVideo />);
      expect(play).toHaveBeenCalledTimes(1);
      a.rerender(<StreamVideo active={false} />);
      expect(pause).toHaveBeenCalled();
      expect(play).toHaveBeenCalledTimes(1);
      a.unmount();
      play.mockClear();
      stubMotion(true);
      render(<StreamVideo />);
      expect(play).not.toHaveBeenCalled();
    } finally {
      proto.play = original.play;
      proto.pause = original.pause;
    }
  });
});
