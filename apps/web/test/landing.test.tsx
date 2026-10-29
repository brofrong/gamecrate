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
const { landingSignedIn } = await import("../src/routes/index");

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

  it("для вошедшего кнопки ведут в /app, а в шапке — «В библиотеку»", async () => {
    render(<RouterProvider router={testRouter(<LandingPage signedIn />)} />);
    const links = await screen.findAllByRole("link", {
      name: /Играть|В библиотеку|Выбрать/,
    });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/app");
    }
    expect(screen.queryByRole("link", { name: "Войти" })).toBeNull();
  });

  it("/ показывает лендинг всем: вошедший — с кнопками в /app, остальные — на /login", () => {
    // `IndexPage` — это `<LandingPage signedIn={landingSignedIn(me)} />`, без редиректа.
    expect(landingSignedIn(AsyncResult.success(user))).toBe(true);
    expect(landingSignedIn(AsyncResult.fail(new Unauthorized()))).toBe(false);
    expect(landingSignedIn(AsyncResult.fail({ _tag: "RpcClientError" }))).toBe(
      false,
    );
    // Пока `auth.me` не ответил — лендинг сразу, с кнопками на /login.
    expect(landingSignedIn(AsyncResult.initial())).toBe(false);
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
