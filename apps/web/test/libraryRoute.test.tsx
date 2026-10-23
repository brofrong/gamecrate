// `/library`: `ConnectSteam` — карточка «подключи Steam» для пользователя без Steam.
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";

const { ConnectSteam } = await import("../src/routes/library");

describe("library route", () => {
  it("connect steam shows heading, text and calls onLink", () => {
    const onLink = mock(() => {});
    render(<ConnectSteam onLink={onLink} />);
    expect(
      screen.getByText("Подключи Steam, чтобы увидеть свою библиотеку"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Мы не просим пароль: Steam сам подтвердит, что аккаунт твой",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Привязать Steam" }));
    expect(onLink).toHaveBeenCalledTimes(1);
  });
});
