// Вход в десктоп-приложение через системный браузер:
// - `/login/desktop` (браузер): гость → OAuth с возвратом на `/login/desktop?done=1`, вошедший →
//   одноразовый токен и ссылка `gamecrate://auth?token=…`; провайдер только из включённых;
// - `/login/desktop/finish#token=…` (окно приложения): токен из фрагмента, фрагмент сразу
//   убран, обмен POST-ом, затем домой; ошибка → `/login?error=DESKTOP_TOKEN`;
// - в приложении кнопки OAuth на `/login` открывают системный браузер.
//
// `spyOn` на реальные модули, как в `login.test.tsx` (не `mock.module`: тот глобален на прогон).
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AuthProviders } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as auth from "../src/auth";
import { LoginPanel } from "../src/components/login/LoginPanel";
import { authErrorMessage } from "../src/lib/authErrors";
import {
  DesktopBrowserLogin,
  DesktopLoginFinish,
} from "../src/routes/loginDesktop";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

const createDesktopToken = spyOn(auth, "createDesktopToken");
const exchangeDesktopToken = spyOn(auth, "exchangeDesktopToken");
const signInWithProvider = spyOn(auth, "signInWithProvider");
const assign = spyOn(window.location, "assign");
const replace = spyOn(window.location, "replace");

const allProviders: AuthProviders = {
  google: true,
  yandex: true,
  pocketId: false,
  telegram: false,
};

type Bridge = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
const setBridge = (invoke: Bridge["invoke"]) => {
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
};

beforeEach(() => {
  createDesktopToken.mockReset();
  createDesktopToken.mockImplementation(async () => ({ token: TOKEN }));
  exchangeDesktopToken.mockReset();
  exchangeDesktopToken.mockImplementation(async () => ({ error: null }));
  signInWithProvider.mockReset();
  signInWithProvider.mockImplementation(() => Promise.resolve() as never);
  assign.mockReset();
  assign.mockImplementation(() => {});
  replace.mockReset();
  replace.mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  window.history.replaceState(null, "", "/");
});

describe("/login/desktop in the system browser", () => {
  it("a signed-in user gets a token and is sent back to the app", async () => {
    render(<DesktopBrowserLogin provider="google" providers={allProviders} />);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`gamecrate://auth?token=${TOKEN}`),
    );
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(await screen.findByText("Можно вернуться в GameCrate")).toBeTruthy();
    // браузер не открыл приложение сам — та же ссылка кнопкой
    expect(
      screen
        .getByRole("link", { name: "Открыть GameCrate" })
        .getAttribute("href"),
    ).toBe(`gamecrate://auth?token=${TOKEN}`);
  });

  it("a guest goes through OAuth and comes back to /login/desktop?done=1", async () => {
    createDesktopToken.mockImplementation(async () => ({
      error: "UNAUTHORIZED",
    }));
    render(<DesktopBrowserLogin provider="yandex" providers={allProviders} />);
    await waitFor(() =>
      expect(signInWithProvider).toHaveBeenCalledWith(
        "yandex",
        "/login/desktop?done=1",
      ),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("after OAuth (done=1) the token is generated without asking for a provider", async () => {
    render(<DesktopBrowserLogin done providers={allProviders} />);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`gamecrate://auth?token=${TOKEN}`),
    );
  });

  it("done=1 without a session shows an error instead of looping", async () => {
    createDesktopToken.mockImplementation(async () => ({
      error: "UNAUTHORIZED",
    }));
    render(<DesktopBrowserLogin done providers={allProviders} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("a provider that is not enabled is refused without any redirect", async () => {
    for (const provider of ["telegram", "steam", "evil", undefined]) {
      const { unmount } = render(
        <DesktopBrowserLogin provider={provider} providers={allProviders} />,
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      unmount();
    }
    expect(createDesktopToken).not.toHaveBeenCalled();
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("waits for the provider list before doing anything", () => {
    render(<DesktopBrowserLogin provider="google" providers={undefined} />);
    expect(createDesktopToken).not.toHaveBeenCalled();
    expect(signInWithProvider).not.toHaveBeenCalled();
  });
});

describe("/login/desktop/finish in the app window", () => {
  it("reads the token from the fragment, drops it from the address and exchanges it", async () => {
    window.history.replaceState(
      null,
      "",
      `/login/desktop/finish#token=${TOKEN}`,
    );
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(exchangeDesktopToken).toHaveBeenCalledWith(TOKEN),
    );
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("in the app goes to the library after the exchange", async () => {
    setBridge(async () => undefined);
    window.history.replaceState(
      null,
      "",
      `/login/desktop/finish#token=${TOKEN}`,
    );
    render(<DesktopLoginFinish />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app"));
  });

  it("a failed exchange sends to /login?error=DESKTOP_TOKEN", async () => {
    exchangeDesktopToken.mockImplementation(async () => ({
      error: "INVALID_TOKEN",
    }));
    window.history.replaceState(
      null,
      "",
      `/login/desktop/finish#token=${TOKEN}`,
    );
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?error=DESKTOP_TOKEN"),
    );
  });

  it("no token in the fragment (or one in the query) → /login?error=DESKTOP_TOKEN", async () => {
    window.history.replaceState(
      null,
      "",
      `/login/desktop/finish?token=${TOKEN}`,
    );
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?error=DESKTOP_TOKEN"),
    );
    expect(exchangeDesktopToken).not.toHaveBeenCalled();
  });

  it("the error has a human text", () => {
    expect(authErrorMessage("DESKTOP_TOKEN")).toBe(
      "Ссылка входа устарела — войдите ещё раз",
    );
  });
});

describe("/login inside the desktop app", () => {
  const noop = () => {};
  const panel = () =>
    render(
      <LoginPanel
        providers={allProviders}
        next="/app"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );

  it("Google opens the system browser on /login/desktop and shows the waiting screen", async () => {
    const calls: Array<[string, unknown]> = [];
    setBridge(async (cmd, args) => {
      calls.push([cmd, args]);
      return undefined;
    });
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Войти через Google" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "open_external",
        { url: "http://localhost:3000/login/desktop?provider=google" },
      ]),
    );
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(await screen.findByText("Продолжите вход в браузере")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Открыть браузер ещё раз" }),
    );
    await waitFor(() =>
      expect(calls.filter(([cmd]) => cmd === "open_external")).toHaveLength(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(
      screen.getByRole("button", { name: "Войти через Google" }),
    ).toBeTruthy();
  });

  it("Yandex goes through the browser too", async () => {
    const calls: Array<[string, unknown]> = [];
    setBridge(async (cmd, args) => {
      calls.push([cmd, args]);
      return undefined;
    });
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Войти через Яндекс" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "open_external",
        { url: "http://localhost:3000/login/desktop?provider=yandex" },
      ]),
    );
    expect(signInWithProvider).not.toHaveBeenCalled();
  });

  it("outside the app the buttons work as before", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Войти через Google" }));
    expect(signInWithProvider).toHaveBeenCalledWith("google", "/app");
  });
});
