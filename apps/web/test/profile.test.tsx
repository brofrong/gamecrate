// Профиль: статусы способов входа, правило «последний способ», привязка/отвязка,
// смена почты кодом, ссылка на аватар в шапке.
//
// `spyOn` на реальный модуль «../src/auth» (а не `mock.module`, которая подменяет модуль
// целиком и глобально на весь прогон `bun test` — см. комментарий в login.test.tsx),
// чтобы не ломать другие тестовые файлы.
import { describe, expect, it, mock, spyOn } from "bun:test";
import type { AuthProviders, CurrentUserShape } from "@cg/rpc";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import * as auth from "../src/auth";
import { AppHeader } from "../src/components/AppHeader";
import { AccountSummary } from "../src/components/profile/AccountSummary";
import { EmailSection } from "../src/components/profile/EmailSection";
import {
  type LinkedAccount,
  LoginMethods,
} from "../src/components/profile/LoginMethods";
import { handleLink, handleUnlink } from "../src/routes/profile";
import { testRouter } from "./router";

const providers: AuthProviders = {
  google: true,
  yandex: true,
  pocketId: true,
  telegram: true,
};

const user: CurrentUserShape = {
  id: "u1",
  name: "Gamer",
  image: null,
  role: "player",
  steamId: "7656",
  email: null,
  emailVerified: false,
};

const accounts: ReadonlyArray<LinkedAccount> = [
  { providerId: "google", accountId: "g1" },
  { providerId: "steam", accountId: "7656" },
];

const noop = () => {};
const noopUnlink = (_a: LinkedAccount) => {};

describe("LoginMethods", () => {
  it("lists methods with statuses", () => {
    render(
      <LoginMethods
        user={user}
        accounts={accounts}
        providers={providers}
        onLink={noop}
        onUnlink={noopUnlink}
        onSteamDone={noop}
        busy={null}
      />,
    );
    expect(screen.getByText("Google — привязан")).toBeTruthy();
    expect(screen.getByText("Steam — привязан · SteamID 7656")).toBeTruthy();
    expect(screen.getByText("Яндекс — не привязан")).toBeTruthy();
    expect(screen.getByText("Telegram — не привязан")).toBeTruthy();
  });

  it("hides providers not configured on the server", () => {
    render(
      <LoginMethods
        user={user}
        accounts={[]}
        providers={{ ...providers, yandex: false }}
        onLink={noop}
        onUnlink={noopUnlink}
        onSteamDone={noop}
        busy={null}
      />,
    );
    expect(screen.queryByText(/Яндекс/)).toBeNull();
    expect(screen.getByText("Google — не привязан")).toBeTruthy();
    expect(screen.getByText("Pocket ID — не привязан")).toBeTruthy();
    expect(screen.getByText("Steam — не привязан")).toBeTruthy();
  });

  it("last login method cannot be unlinked", () => {
    render(
      <LoginMethods
        user={user}
        accounts={accounts}
        providers={providers}
        onLink={noop}
        onUnlink={noopUnlink}
        onSteamDone={noop}
        busy={null}
      />,
    );
    const googleRow = screen
      .getByText("Google — привязан")
      .closest("div") as HTMLElement;
    const googleButton = within(googleRow).getByRole("button", {
      name: "Отвязать",
    }) as HTMLButtonElement;
    expect(googleButton.disabled).toBe(true);
    expect(googleButton.title).toBe("Это единственный способ входа");

    const steamRow = screen
      .getByText(/^Steam — привязан/)
      .closest("div") as HTMLElement;
    const steamButton = within(steamRow).getByRole("button", {
      name: "Отвязать",
    }) as HTMLButtonElement;
    expect(steamButton.disabled).toBe(false);
    expect(steamButton.title).toBe("");
  });

  it("unlink calls the client and reloads", async () => {
    const unlinkProvider = spyOn(auth, "unlinkProvider").mockResolvedValue({
      error: null,
    });
    const reloadAccounts = mock(() => {});
    const reloadMe = mock(() => {});
    render(
      <LoginMethods
        user={user}
        accounts={accounts}
        providers={providers}
        onLink={noop}
        onUnlink={(a) => void handleUnlink(a, { reloadAccounts, reloadMe })}
        onSteamDone={noop}
        busy={null}
      />,
    );
    const steamRow = screen
      .getByText(/^Steam — привязан/)
      .closest("div") as HTMLElement;
    fireEvent.click(within(steamRow).getByRole("button", { name: "Отвязать" }));
    await waitFor(() =>
      expect(unlinkProvider).toHaveBeenCalledWith("steam", "7656"),
    );
    expect(reloadAccounts).toHaveBeenCalledTimes(1);
    expect(reloadMe).toHaveBeenCalledTimes(1);
    unlinkProvider.mockRestore();
  });

  it("steam link opens the QR login", () => {
    const linkSteam = spyOn(auth, "linkSteam").mockResolvedValue(
      undefined as never,
    );
    const onSteamDone = mock(() => {});
    const QrLogin = ({
      title,
      onDone,
    }: {
      title: string;
      onDone: () => void;
    }) => (
      <div>
        <p>{title}</p>
        <button onClick={onDone}>готово (фейк)</button>
      </div>
    );
    render(
      <LoginMethods
        user={user}
        accounts={[]}
        providers={providers}
        onLink={noop}
        onUnlink={noopUnlink}
        onSteamDone={onSteamDone}
        busy={null}
        QrLogin={QrLogin}
      />,
    );
    const steamRow = screen
      .getByText("Steam — не привязан")
      .closest("div") as HTMLElement;
    // Steam не идёт через общий `onLink` — своя подпись и свой экран с QR.
    expect(
      within(steamRow).queryByRole("button", { name: "Привязать" }),
    ).toBeNull();
    fireEvent.click(
      within(steamRow).getByRole("button", { name: "Подключить" }),
    );
    expect(screen.getByText("Подключите Steam")).toBeTruthy();
    expect(linkSteam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "готово (фейк)" }));
    expect(onSteamDone).toHaveBeenCalledTimes(1);
    linkSteam.mockRestore();
  });

  it("telegram link goes through linkSocial like other OAuth providers", async () => {
    const linkProvider = spyOn(auth, "linkProvider").mockImplementation(
      () => Promise.resolve() as never,
    );
    await handleLink("telegram");
    expect(linkProvider).toHaveBeenCalledWith("telegram");
    linkProvider.mockRestore();
  });
});

describe("EmailSection", () => {
  it("email section adds an address with a code", async () => {
    const requestEmailChange = spyOn(
      auth,
      "requestEmailChange",
    ).mockResolvedValue({ data: null, error: null } as never);
    const confirmEmailChange = spyOn(
      auth,
      "confirmEmailChange",
    ).mockResolvedValue({ data: null, error: null } as never);
    const onChanged = mock(() => {});

    render(<EmailSection user={user} onChanged={onChanged} />);
    expect(screen.getByText("Почта не добавлена")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Добавить почту" }));
    fireEvent.change(screen.getByLabelText("Новая почта"), {
      target: { value: "new@gmail.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отправить код" }));
    await waitFor(() =>
      expect(requestEmailChange).toHaveBeenCalledWith("new@gmail.com"),
    );

    const codeInput = await screen.findByLabelText("Код из письма");
    fireEvent.change(codeInput, { target: { value: "123456" } });
    await waitFor(() =>
      expect(confirmEmailChange).toHaveBeenCalledWith(
        "new@gmail.com",
        "123456",
      ),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    requestEmailChange.mockRestore();
    confirmEmailChange.mockRestore();
  });
});

describe("AppHeader", () => {
  it("header links the avatar to /profile with an accessible name", async () => {
    render(<RouterProvider router={testRouter(<AppHeader user={user} />)} />);
    const link = await screen.findByRole("link", { name: "Профиль" });
    expect(link.getAttribute("href")).toBe("/profile");
  });

  it("falls back to the email initial when name is empty", async () => {
    render(
      <RouterProvider
        router={testRouter(
          <AppHeader user={{ ...user, name: "", email: "ivan@example.com" }} />,
        )}
      />,
    );
    expect(await screen.findByText("I")).toBeTruthy();
  });

  it("falls back to ? when both name and email are empty", async () => {
    render(
      <RouterProvider
        router={testRouter(
          <AppHeader user={{ ...user, name: "", email: null }} />,
        )}
      />,
    );
    expect(await screen.findByText("?")).toBeTruthy();
  });
});

describe("AccountSummary", () => {
  it("shows the avatar initial and name", () => {
    render(<AccountSummary user={user} />);
    expect(screen.getByText("Gamer")).toBeTruthy();
    expect(screen.getByText("G")).toBeTruthy();
  });

  it("falls back to the email local part when name is empty", () => {
    render(
      <AccountSummary
        user={{ ...user, name: "", email: "ivan@example.com" }}
      />,
    );
    expect(screen.getByText("ivan")).toBeTruthy();
  });

  it("falls back to ? when both name and email are empty", () => {
    render(<AccountSummary user={{ ...user, name: "", email: null }} />);
    expect(screen.getAllByText("?")).toHaveLength(2);
  });
});
