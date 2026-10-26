// `ConnectSteam` (`/app`, карточка для пользователя без привязанного Steam):
// кнопка открывает диалог с QR-входом вместо старой OpenID-привязки, «готово» в
// фейковом `QrLogin` закрывает диалог и зовёт `onDone`. Сам QR-экран (поллинг,
// рисование QR, повтор после ошибки) проверяется отдельно в `steamQrLogin.test.tsx`;
// здесь — только карточка и то, что она правильно подключает диалог (DI-проп `QrLogin`,
// как в `session.test.tsx`/`profile.test.tsx`).
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConnectSteam } from "../src/components/app/ConnectSteam";

describe("ConnectSteam", () => {
  it("connect steam opens the QR login", () => {
    const onDone = mock(() => {});
    const QrLogin = ({
      title,
      onDone: fire,
    }: {
      title: string;
      onDone: () => void;
    }) => (
      <div>
        <p>{title}</p>
        <button type="button" onClick={fire}>
          готово (фейк)
        </button>
      </div>
    );
    render(<ConnectSteam onDone={onDone} QrLogin={QrLogin} />);
    expect(screen.getByText("Подключите Steam")).toBeTruthy();
    expect(screen.queryByText("Ждём сканирования")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Подключить Steam" }));
    expect(screen.getAllByText("Подключите Steam").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "готово (фейк)" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("cancel closes the dialog without calling onDone", () => {
    const onDone = mock(() => {});
    const QrLogin = ({ title }: { title: string; onDone: () => void }) => (
      <p>{title}</p>
    );
    render(<ConnectSteam onDone={onDone} QrLogin={QrLogin} />);

    fireEvent.click(screen.getByRole("button", { name: "Подключить Steam" }));
    expect(screen.getAllByText("Подключите Steam").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.getAllByText("Подключите Steam").length).toBe(1);
    expect(onDone).not.toHaveBeenCalled();
  });
});
