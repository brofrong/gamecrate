// Панель входа `/login`: провайдеры, шаг email → код с автоподтверждением и таймером
// повторной отправки, наведение/клик провайдера подсвечивает и зажигает сцену, helper
// `loginNext` маршрута защищает от open redirect.
//
// `spyOn` на реальный модуль (а не `mock.module`, которая заменяет модуль целиком и
// глобально на весь прогон `bun test`) — так подмена не ломает другие тестовые файлы,
// которым от «../src/auth» нужны другие функции (`landing.test.tsx` и соседи).
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AuthProviders, TelegramAuthData } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as auth from "../src/auth";
import * as telegramWidget from "../src/lib/telegramWidget";
import { LoginPanel } from "../src/components/login/LoginPanel";
import { loginNext } from "../src/routes/login";

const sendEmailCode = spyOn(auth, "sendEmailCode").mockImplementation(
  async () => ({ error: null }),
);
const signInWithEmailCode = spyOn(
  auth,
  "signInWithEmailCode",
).mockImplementation(async () => ({ error: null }));
const signInWithProvider = spyOn(auth, "signInWithProvider").mockImplementation(
  () => Promise.resolve() as never,
);
const signInWithTelegram = spyOn(auth, "signInWithTelegram").mockImplementation(
  async () => ({ error: null }),
);
const telegramAuth = spyOn(telegramWidget, "telegramAuth").mockImplementation(
  async () => null,
);

const providers: AuthProviders = {
  google: true,
  yandex: false,
  pocketId: true,
  telegram: null,
};

const noop = () => {};

beforeEach(() => {
  sendEmailCode.mockClear();
  sendEmailCode.mockImplementation(async () => ({ error: null }));
  signInWithEmailCode.mockClear();
  signInWithEmailCode.mockImplementation(async () => ({ error: null }));
  signInWithProvider.mockClear();
  signInWithTelegram.mockClear();
  telegramAuth.mockClear();
});

describe("login panel", () => {
  it("renders only configured providers", () => {
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Войти через Google" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Войти через Яндекс" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Войти через Telegram" }),
    ).toBeNull();
    expect(screen.getByText("Вход для команды")).toBeTruthy();
  });

  it("skeleton while providers are loading", () => {
    render(
      <LoginPanel
        providers={undefined}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    expect(
      screen.getByRole("status", { name: "Загрузка способов входа" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("email step sends a code and shows the code step", async () => {
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("почта"), {
      target: { value: "ivan@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Получить код" }));
    await waitFor(() =>
      expect(sendEmailCode).toHaveBeenCalledWith("ivan@gmail.com"),
    );
    expect(
      await screen.findByText(/Код отправлен на ivan@gmail\.com/),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Отправить ещё раз",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("resend unlocks after 30s and resends to the same address", async () => {
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("почта"), {
      target: { value: "ivan@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Получить код" }));
    await screen.findByText(/Код отправлен на/);

    const resendButton = () =>
      screen.getByRole("button", {
        name: "Отправить ещё раз",
      }) as HTMLButtonElement;
    expect(resendButton().disabled).toBe(true);
    expect(screen.getByText(/через \d+с/)).toBeTruthy();

    // Таймер «Отправить ещё раз» тикает по реальному `setInterval`, опрашивая
    // `Date.now()` — сдвигаем часы на 31с вперёд и ждём ближайший тик.
    const nowSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    try {
      await waitFor(() => expect(resendButton().disabled).toBe(false), {
        timeout: 3000,
      });
      expect(screen.queryByText(/через \d+с/)).toBeNull();

      fireEvent.click(resendButton());
      await waitFor(() => expect(sendEmailCode).toHaveBeenCalledTimes(2));
      expect(sendEmailCode).toHaveBeenNthCalledWith(2, "ivan@gmail.com");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("six digits auto-submit", async () => {
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("почта"), {
      target: { value: "ivan@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Получить код" }));
    await screen.findByText(/Код отправлен на/);
    fireEvent.change(screen.getByLabelText("Код из письма"), {
      target: { value: "123456" },
    });
    await waitFor(() => expect(signInWithEmailCode).toHaveBeenCalledTimes(1));
    expect(signInWithEmailCode).toHaveBeenCalledWith(
      "ivan@gmail.com",
      "123456",
    );
  });

  it("change email resets the code", async () => {
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("почта"), {
      target: { value: "ivan@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Получить код" }));
    await screen.findByText(/Код отправлен на/);

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    expect(screen.getByPlaceholderText("почта")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("почта"), {
      target: { value: "other@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Получить код" }));
    await waitFor(() =>
      expect(sendEmailCode).toHaveBeenCalledWith("other@gmail.com"),
    );
    await screen.findByText(/Код отправлен на other@gmail\.com/);

    fireEvent.change(screen.getByLabelText("Код из письма"), {
      target: { value: "654321" },
    });
    await waitFor(() =>
      expect(signInWithEmailCode).toHaveBeenCalledWith(
        "other@gmail.com",
        "654321",
      ),
    );
  });

  it("shows mail failure and keeps the field enabled", async () => {
    sendEmailCode.mockImplementationOnce(async () => ({
      error: "MAIL_FAILED",
    }));
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    const emailInput = screen.getByPlaceholderText("почта");
    fireEvent.change(emailInput, { target: { value: "ivan@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Получить код" }));
    expect(
      await screen.findByText("Не удалось отправить письмо, попробуй позже"),
    ).toBeTruthy();
    expect((emailInput as HTMLInputElement).disabled).toBe(false);
  });

  it("provider hover tints and click lights the cube", () => {
    const onTint = mock((_t: string | null) => {});
    const onLit = mock(() => {});
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={noop}
        onTint={onTint}
        onLit={onLit}
      />,
    );
    const googleBtn = screen.getByRole("button", {
      name: "Войти через Google",
    });
    fireEvent.mouseEnter(googleBtn);
    expect(onTint).toHaveBeenCalledWith("google");
    fireEvent.mouseLeave(googleBtn);
    expect(onTint).toHaveBeenCalledWith(null);
    fireEvent.click(googleBtn);
    expect(signInWithProvider).toHaveBeenCalledWith("google", "/library");
    expect(onLit).toHaveBeenCalled();
  });

  it("level reports to the scene", async () => {
    const onLevel = mock((_l: number) => {});
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={onLevel}
        onTint={noop}
        onLit={noop}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("почта"), {
      target: { value: "ivan@gmail.com" },
    });
    expect(onLevel).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: "Получить код" }));
    await screen.findByText(/Код отправлен на/);
    fireEvent.change(screen.getByLabelText("Код из письма"), {
      target: { value: "123456" },
    });
    await waitFor(() => expect(onLevel).toHaveBeenCalledWith(2));
  });

  it("telegram click opens the widget and signs in", async () => {
    const tgProviders: AuthProviders = {
      ...providers,
      telegram: { botId: "123:abc", botUsername: "gc_bot" },
    };
    const data: TelegramAuthData = { id: "1", auth_date: "0", hash: "h" };
    telegramAuth.mockImplementationOnce(async () => data);
    render(
      <LoginPanel
        providers={tgProviders}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Войти через Telegram" }),
    );
    await waitFor(() => expect(telegramAuth).toHaveBeenCalledWith("123:abc"));
    await waitFor(() =>
      expect(signInWithTelegram).toHaveBeenCalledWith(data, "/library"),
    );
  });

  it("login route rejects unsafe next", () => {
    expect(loginNext({ next: "//evil.com" })).toBe("/library");
    expect(loginNext({ next: "/profile" })).toBe("/profile");
    expect(loginNext({})).toBe("/library");
  });

  it("hides the email divider when no provider buttons are configured", () => {
    render(
      <LoginPanel
        providers={{
          google: false,
          yandex: false,
          pocketId: true,
          telegram: null,
        }}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    expect(screen.queryByText("или по почте")).toBeNull();
  });

  it("shows the email divider when a provider button is configured", () => {
    render(
      <LoginPanel
        providers={providers}
        next="/library"
        onLevel={noop}
        onTint={noop}
        onLit={noop}
      />,
    );
    expect(screen.getByText("или по почте")).toBeTruthy();
  });
});
