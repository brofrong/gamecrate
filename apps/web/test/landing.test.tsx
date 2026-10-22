import { describe, expect, it, mock } from "bun:test";
import type { CurrentUserShape } from "@cg/rpc";
import { Unauthorized } from "@cg/rpc";
import { fireEvent, render, screen } from "@testing-library/react";
import { AsyncResult } from "effect/reactivity";

const signIn = mock(async () => ({ error: undefined }));
mock.module("../src/auth", () => ({
  signInWithSteam: signIn,
  signOut: async () => {},
  signInWithPocketId: async () => {},
  // Экспорты ниже не используются в этом файле, но `mock.module` подменяет
  // «../src/auth» глобально на весь прогон `bun test` — без них падает
  // test/login.test.tsx, которому они нужны (см. его комментарий к mock.module).
  sendEmailCode: async () => ({ error: null }),
  signInWithEmailCode: async () => ({ error: null }),
  signInWithProvider: async () => {},
  signInWithTelegram: async () => ({ error: null }),
}));

const { LandingPage } = await import("../src/components/landing/LandingPage");
const { steamLoginFailed } = await import("../src/lib/useSteamLogin");
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
  it("landing renders headline, nav anchors and footer", () => {
    render(<LandingPage error={false} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Любая игра. Где угодно. Прямо сейчас.",
    );
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

  it("play button starts steam login and shows pending", async () => {
    render(<LandingPage error={false} />);
    const play = screen.getAllByRole("button", { name: "Играть" })[0];
    if (!play) throw new Error("no play button");
    fireEvent.click(play);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect((play as HTMLButtonElement).disabled).toBe(true);
  });

  it("landing shows steam error from query", () => {
    render(<LandingPage error />);
    expect(screen.getAllByText(steamLoginFailed).length).toBeGreaterThan(0);
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

  it("landing has every section anchor", () => {
    render(<LandingPage error={false} />);
    for (const id of ["tech", "how", "plans", "ach", "faq"]) {
      expect(document.getElementById(id)).toBeTruthy();
    }
  });

  it("landing says «облако», never «контейнер»", () => {
    render(<LandingPage error={false} />);
    expect(document.body.textContent).not.toMatch(/контейнер/i);
    expect(document.body.textContent).toMatch(/облак/i);
  });
});
