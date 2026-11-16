// Вход в десктоп-приложение через системный браузер:
// - окно приложения перед открытием браузера кладёт случайный `state` в свой `sessionStorage`
//   и открывает `/login/desktop?provider=…&state=…`;
// - `/login/desktop` (браузер): `state` обязателен; гость → OAuth с возвратом на
//   `/login/desktop?done=1&state=…`; вошедший видит «Войти в приложение GameCrate как …» и только
//   по клику получает токен и ссылку `gamecrate://auth?token=…&state=…`; провайдер только из
//   включённых;
// - `/login/desktop/finish#token=…&state=…` (только окно приложения): фрагмент сразу убран,
//   `state` сверяется с `sessionStorage` и удаляется, обмен POST-ом, затем домой; иначе —
//   `/login?error=DESKTOP_TOKEN` без POST (login CSRF: чужая ссылка не войдёт под чужой учёткой).
//
// `spyOn` на реальные модули, как в `login.test.tsx` (не `mock.module`: тот глобален на прогон).
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AuthProviders } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as auth from "../src/auth";
import { LoginPanel } from "../src/components/login/LoginPanel";
import { authErrorMessage } from "../src/lib/authErrors";
import { DESKTOP_STATE_KEY } from "../src/lib/desktopLogin";
import {
  DesktopBrowserLogin,
  DesktopLoginFinish,
} from "../src/routes/loginDesktop";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const STATE = "s7a_Te-0123456789abcdefghijklmnopqrstuvwxyz";
const LINK = `gamecrate://auth?token=${TOKEN}&state=${STATE}`;

const createDesktopToken = spyOn(auth, "createDesktopToken");
const exchangeDesktopToken = spyOn(auth, "exchangeDesktopToken");
const currentAccount = spyOn(auth, "currentAccount");
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
  currentAccount.mockReset();
  currentAccount.mockImplementation(async () => ({
    kind: "signed-in",
    label: "player@example.com",
  }));
  signInWithProvider.mockReset();
  signInWithProvider.mockImplementation(() => Promise.resolve() as never);
  assign.mockReset();
  assign.mockImplementation(() => {});
  replace.mockReset();
  replace.mockImplementation(() => {});
  window.sessionStorage.clear();
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

describe("/login/desktop in the system browser", () => {
  it("a signed-in user confirms with a click, only then gets a token and is sent back", async () => {
    render(
      <DesktopBrowserLogin
        provider="google"
        state={STATE}
        providers={allProviders}
      />,
    );
    expect(
      await screen.findByText(
        "Войти в приложение GameCrate как player@example.com",
      ),
    ).toBeTruthy();
    // без клика токен не выдаётся и приложение не открывается
    expect(createDesktopToken).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(signInWithProvider).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Открыть GameCrate" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(LINK));
    expect(createDesktopToken).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Можно вернуться в GameCrate")).toBeTruthy();
    // браузер не открыл приложение сам — та же ссылка кнопкой
    expect(
      screen
        .getByRole("link", { name: "Открыть GameCrate" })
        .getAttribute("href"),
    ).toBe(LINK);
  });

  it("a guest goes through OAuth and comes back to /login/desktop?done=1&state=…", async () => {
    currentAccount.mockImplementation(async () => ({ kind: "guest" }));
    render(
      <DesktopBrowserLogin
        provider="yandex"
        state={STATE}
        providers={allProviders}
      />,
    );
    await waitFor(() =>
      expect(signInWithProvider).toHaveBeenCalledWith(
        "yandex",
        `/login/desktop?done=1&state=${STATE}`,
      ),
    );
    expect(createDesktopToken).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("after OAuth (done=1) the token still needs a click — done=1 can be forged by a link", async () => {
    render(<DesktopBrowserLogin done state={STATE} providers={allProviders} />);
    expect(
      await screen.findByRole("button", { name: "Открыть GameCrate" }),
    ).toBeTruthy();
    expect(createDesktopToken).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Открыть GameCrate" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(LINK));
  });

  it("shows the name when the account has no email", async () => {
    currentAccount.mockImplementation(async () => ({
      kind: "signed-in",
      label: "Игрок",
    }));
    render(<DesktopBrowserLogin done state={STATE} providers={allProviders} />);
    expect(
      await screen.findByText("Войти в приложение GameCrate как Игрок"),
    ).toBeTruthy();
  });

  it("done=1 without a session shows an error instead of looping", async () => {
    currentAccount.mockImplementation(async () => ({ kind: "guest" }));
    render(<DesktopBrowserLogin done state={STATE} providers={allProviders} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(createDesktopToken).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("a failed token after the click shows an error", async () => {
    createDesktopToken.mockImplementation(async () => ({ error: "FAILED" }));
    render(<DesktopBrowserLogin done state={STATE} providers={allProviders} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Открыть GameCrate" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("a failed session check shows an error", async () => {
    currentAccount.mockImplementation(async () => ({ kind: "failed" }));
    render(
      <DesktopBrowserLogin
        provider="google"
        state={STATE}
        providers={allProviders}
      />,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("a provider that is not enabled is refused without any redirect", async () => {
    for (const provider of ["telegram", "steam", "evil", undefined]) {
      const { unmount } = render(
        <DesktopBrowserLogin
          provider={provider}
          state={STATE}
          providers={allProviders}
        />,
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      unmount();
    }
    expect(currentAccount).not.toHaveBeenCalled();
    expect(createDesktopToken).not.toHaveBeenCalled();
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("a missing or malformed state is refused without any redirect", async () => {
    for (const state of [
      undefined,
      "",
      "short",
      "a".repeat(129),
      "abcdefgh.ijklmnop",
      "abcdefgh ijklmnop",
      "abcdefghijklmnop&token=x",
    ]) {
      for (const done of [false, true]) {
        const { unmount } = render(
          <DesktopBrowserLogin
            provider="google"
            done={done}
            state={state}
            providers={allProviders}
          />,
        );
        expect(await screen.findByRole("alert")).toBeTruthy();
        unmount();
      }
    }
    expect(currentAccount).not.toHaveBeenCalled();
    expect(createDesktopToken).not.toHaveBeenCalled();
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("waits for the provider list before doing anything", () => {
    render(
      <DesktopBrowserLogin
        provider="google"
        state={STATE}
        providers={undefined}
      />,
    );
    expect(currentAccount).not.toHaveBeenCalled();
    expect(signInWithProvider).not.toHaveBeenCalled();
  });
});

describe("/login/desktop/finish in the app window", () => {
  const app = () => setBridge(async () => undefined);
  const openFinish = (fragment: string) =>
    window.history.replaceState(null, "", `/login/desktop/finish${fragment}`);

  it("matching state: drops the fragment, exchanges the token by POST and goes to the library", async () => {
    app();
    window.sessionStorage.setItem(DESKTOP_STATE_KEY, STATE);
    openFinish(`#token=${TOKEN}&state=${STATE}`);
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(exchangeDesktopToken).toHaveBeenCalledWith(TOKEN),
    );
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app"));
    expect(window.sessionStorage.getItem(DESKTOP_STATE_KEY)).toBeNull();
  });

  it("in a regular browser there is no exchange at all", async () => {
    window.sessionStorage.setItem(DESKTOP_STATE_KEY, STATE);
    openFinish(`#token=${TOKEN}&state=${STATE}`);
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?error=DESKTOP_TOKEN"),
    );
    expect(exchangeDesktopToken).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("no saved state (cold start or someone else's link) → error without POST", async () => {
    app();
    openFinish(`#token=${TOKEN}&state=${STATE}`);
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?error=DESKTOP_TOKEN"),
    );
    expect(exchangeDesktopToken).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("someone else's state → error without POST, the saved state is removed", async () => {
    app();
    window.sessionStorage.setItem(DESKTOP_STATE_KEY, STATE);
    openFinish(`#token=${TOKEN}&state=attacker_state_0123456789abcdef`);
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?error=DESKTOP_TOKEN"),
    );
    expect(exchangeDesktopToken).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(DESKTOP_STATE_KEY)).toBeNull();
  });

  it("no state in the link → error without POST, the saved state is removed", async () => {
    app();
    window.sessionStorage.setItem(DESKTOP_STATE_KEY, STATE);
    openFinish(`#token=${TOKEN}`);
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?error=DESKTOP_TOKEN"),
    );
    expect(exchangeDesktopToken).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(DESKTOP_STATE_KEY)).toBeNull();
  });

  it("a failed exchange sends to /login?error=DESKTOP_TOKEN", async () => {
    app();
    window.sessionStorage.setItem(DESKTOP_STATE_KEY, STATE);
    exchangeDesktopToken.mockImplementation(async () => ({
      error: "INVALID_TOKEN",
    }));
    openFinish(`#token=${TOKEN}&state=${STATE}`);
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?error=DESKTOP_TOKEN"),
    );
    expect(window.sessionStorage.getItem(DESKTOP_STATE_KEY)).toBeNull();
  });

  it("no token in the fragment (or one in the query) → /login?error=DESKTOP_TOKEN", async () => {
    app();
    window.sessionStorage.setItem(DESKTOP_STATE_KEY, STATE);
    openFinish(`?token=${TOKEN}&state=${STATE}`);
    render(<DesktopLoginFinish />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?error=DESKTOP_TOKEN"),
    );
    expect(exchangeDesktopToken).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.sessionStorage.getItem(DESKTOP_STATE_KEY)).toBeNull();
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
  const recordBridge = () => {
    const calls: Array<[string, unknown]> = [];
    setBridge(async (cmd, args) => {
      calls.push([cmd, args]);
      return undefined;
    });
    return calls;
  };
  const opened = (calls: Array<[string, unknown]>) =>
    calls
      .filter(([cmd]) => cmd === "open_external")
      .map(([, args]) => new URL((args as { url: string }).url));

  it("Google saves a fresh state and opens the system browser on /login/desktop with it", async () => {
    const calls = recordBridge();
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Войти через Google" }));
    await waitFor(() => expect(opened(calls)).toHaveLength(1));
    const [url] = opened(calls);
    if (!url) throw new Error("no url");
    expect(url.origin + url.pathname).toBe(
      "http://localhost:3000/login/desktop",
    );
    expect(url.searchParams.get("provider")).toBe("google");
    const state = url.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(window.sessionStorage.getItem(DESKTOP_STATE_KEY)).toBe(state);
    expect(signInWithProvider).not.toHaveBeenCalled();
    expect(await screen.findByText("Продолжите вход в браузере")).toBeTruthy();

    // «ещё раз» — тот же state
    fireEvent.click(
      screen.getByRole("button", { name: "Открыть браузер ещё раз" }),
    );
    await waitFor(() => expect(opened(calls)).toHaveLength(2));
    expect(opened(calls)[1]?.toString()).toBe(url.toString());
    expect(window.sessionStorage.getItem(DESKTOP_STATE_KEY)).toBe(state);

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(
      screen.getByRole("button", { name: "Войти через Google" }),
    ).toBeTruthy();
  });

  it("every new login gets a new state", async () => {
    const calls = recordBridge();
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Войти через Google" }));
    fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Войти через Google" }));
    await waitFor(() => expect(opened(calls)).toHaveLength(2));
    const [first, second] = opened(calls).map((u) =>
      u.searchParams.get("state"),
    );
    expect(first).not.toBe(second);
    expect(window.sessionStorage.getItem(DESKTOP_STATE_KEY)).toBe(second ?? "");
  });

  it("Yandex goes through the browser too", async () => {
    const calls = recordBridge();
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Войти через Яндекс" }));
    await waitFor(() => expect(opened(calls)).toHaveLength(1));
    expect(opened(calls)[0]?.searchParams.get("provider")).toBe("yandex");
    expect(signInWithProvider).not.toHaveBeenCalled();
  });

  it("no sessionStorage → an error in the panel, the browser is not opened", async () => {
    const calls = recordBridge();
    // так ведёт себя закрытое хранилище: само обращение бросает SecurityError
    const own = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });
    try {
      panel();
      fireEvent.click(
        screen.getByRole("button", { name: "Войти через Google" }),
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(opened(calls)).toHaveLength(0);
      expect(screen.queryByText("Продолжите вход в браузере")).toBeNull();
    } finally {
      if (own) Object.defineProperty(window, "sessionStorage", own);
      else Reflect.deleteProperty(window, "sessionStorage");
    }
  });

  it("the app failing to open the browser → an error in the panel, no waiting screen", async () => {
    setBridge(async () => {
      throw new Error("only https");
    });
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Войти через Google" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Продолжите вход в браузере")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Войти через Google" }),
    ).toBeTruthy();
  });

  it("outside the app the buttons work as before", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Войти через Google" }));
    expect(signInWithProvider).toHaveBeenCalledWith("google", "/app");
  });
});
