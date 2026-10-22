import { describe, expect, it, mock } from "bun:test";
import { defaultSessionSettings, type SessionSettings } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionSettingsForm } from "../src/components/admin/SessionSettingsForm";

const field = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;

describe("session settings form", () => {
  it("settings form shows range error and submits valid values", async () => {
    const onSubmit = mock(
      async (_settings: SessionSettings): Promise<string | null> => null,
    );
    render(
      <SessionSettingsForm
        initial={defaultSessionSettings}
        onSubmit={onSubmit}
      />,
    );
    expect(field("Простой до предупреждения, мин").value).toBe("15");
    expect(field("Время на ответ, мин").value).toBe("2");
    expect(field("Ожидание после отключения, мин").value).toBe("5");
    expect(field("Таймаут запуска, мин").value).toBe("15");

    fireEvent.change(field("Простой до предупреждения, мин"), {
      target: { value: "121" },
    });
    fireEvent.change(field("Таймаут запуска, мин"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Целое число от 1 до 120")).toBeTruthy();
    expect(screen.getByText("Целое число от 5 до 60")).toBeTruthy();
    expect(
      field("Простой до предупреждения, мин").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(field("Простой до предупреждения, мин"), {
      target: { value: "30" },
    });
    fireEvent.change(field("Таймаут запуска, мин"), {
      target: { value: "20" },
    });
    fireEvent.change(field("Время на ответ, мин"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Целое число от 1 до 30")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(field("Время на ответ, мин"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      idleWarningMinutes: 30,
      idleGraceMinutes: 3,
      disconnectGraceMinutes: 5,
      startTimeoutMinutes: 20,
      // Не редактируется этой формой (Task 6 добавит поле в `fields`), но
      // должен доехать до сервера как есть, а не пропасть из сохранённого значения.
      installTimeoutMinutes: defaultSessionSettings.installTimeoutMinutes,
    });
    expect(screen.queryByText(/Целое число от/)).toBeNull();
  });

  it("settings form shows the server error", async () => {
    const onSubmit = mock(
      async (_settings: SessionSettings): Promise<string | null> =>
        "Не удалось сохранить настройки",
    );
    render(
      <SessionSettingsForm
        initial={defaultSessionSettings}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText("Не удалось сохранить настройки"),
    ).toBeTruthy();
  });
});
