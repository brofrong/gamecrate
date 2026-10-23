import { describe, expect, it, mock } from "bun:test";
import type { CurrentUserShape } from "@cg/rpc";
import { Unauthorized } from "@cg/rpc";
import { render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { testRouter } from "./router";

mock.module("../src/auth", () => ({
  signOut: async () => {},
  // Экспорты ниже не используются в этом файле, но `mock.module` подменяет
  // «../src/auth» глобально на весь прогон `bun test` — без них падает
  // test/login.test.tsx, которому они нужны (см. его комментарий к mock.module).
  sendEmailCode: async () => ({ error: null }),
  signInWithEmailCode: async () => ({ error: null }),
  signInWithProvider: async () => {},
}));

const { LandingPage } = await import("../src/components/landing/LandingPage");
const { indexView } = await import("../src/routes/index");

const user: CurrentUserShape = {
  id: "u1",
  name: "Gamer",
  image: null,
  role: "player",
  steamId: "7656",
  email: null,
  emailVerified: false,
};

describe("landing", () => {
  it("landing renders headline, nav anchors and footer", async () => {
    render(<RouterProvider router={testRouter(<LandingPage />)} />);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Любая игра. Где угодно. Прямо сейчас.");
    for (const [href, name] of [
      ["#tech", "Технология"],
      ["#how", "Как работает"],
      ["#plans", "Тарифы"],
      ["#ach", "Ачивки"],
      ["#faq", "FAQ"],
    ] as const) {
      expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(
        href,
      );
    }
    expect(screen.getByText(/торговой маркой Valve/)).toBeTruthy();
  });

  it("play buttons link to /login", async () => {
    render(<RouterProvider router={testRouter(<LandingPage />)} />);
    const links = await screen.findAllByRole("link", {
      name: /Играть|Войти|Выбрать/,
    });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/login");
    }
  });

  it("landing never calls steam a login method", async () => {
    render(<RouterProvider router={testRouter(<LandingPage />)} />);
    await screen.findByRole("heading", { level: 1 });
    expect(document.body.textContent).not.toContain("Войти через Steam");
  });

  it("index redirects signed-in user to library", () => {
    expect(indexView(AsyncResult.success(user), false)).toBe("library");
    expect(indexView(AsyncResult.fail(new Unauthorized()), false)).toBe(
      "landing",
    );
    expect(indexView(AsyncResult.fail({ _tag: "RpcClientError" }), false)).toBe(
      "unreachable",
    );
    expect(indexView(AsyncResult.initial(), true)).toBe("unreachable");
    expect(indexView(AsyncResult.initial(), false)).toBe("loading");
  });

  it("landing has every section anchor", async () => {
    render(<RouterProvider router={testRouter(<LandingPage />)} />);
    await screen.findByRole("heading", { level: 1 });
    for (const id of ["tech", "how", "plans", "ach", "faq"]) {
      expect(document.getElementById(id)).toBeTruthy();
    }
  });

  it("landing says «облако», never «контейнер»", async () => {
    render(<RouterProvider router={testRouter(<LandingPage />)} />);
    await screen.findByRole("heading", { level: 1 });
    expect(document.body.textContent).not.toMatch(/контейнер/i);
    expect(document.body.textContent).toMatch(/облак/i);
  });
});
