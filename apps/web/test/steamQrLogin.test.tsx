// Экран «Вход в Steam по QR»: опрос статуса, рисование QR, повтор после ошибки/истечения.
//
// `SteamQrLoginView` принимает `start`/`status` как простые функции — фейковый
// RPC-клиент, как и остальные тесты сайта подменяют сетевые вызовы (см. `spyOn`
// в login.test.tsx/profile.test.tsx), а не настоящий сокет. `SteamQrLogin` (экспорт,
// которым пользуется приложение) просто подключает сюда настоящие атомы `@/rpc`
// и поэтому отдельно не тестируется — проверяется через DI-пропы `QrLogin` в
// library.test.tsx/profile.test.tsx/session.test.tsx.
import { describe, expect, it, mock } from "bun:test";
import type { SteamLoginView } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SteamQrLoginView } from "../src/components/SteamQrLogin";

const view = (patch: Partial<SteamLoginView> = {}): SteamLoginView => ({
  attemptId: "a1",
  status: "waiting",
  qrUrl: null,
  reason: null,
  ...patch,
});

/** Короткий интервал опроса — тест не ждёт настоящую секунду на каждый шаг. */
const POLL_MS = 5;

describe("SteamQrLogin", () => {
  it("shows QR and statuses", async () => {
    // Статус меняем сами между проверками (а не отдаём очередь ответов за раз) —
    // опрос идёт каждые `POLL_MS`, и очередь могла бы опустеть раньше, чем тест
    // успеет проверить промежуточный «scanned».
    let current = view({ qrUrl: "https://s.team/q/1/aaa" });
    const status = mock(async () => current);
    const start = mock(async () => ({ attemptId: "a1" }));
    const onDone = mock(() => {});

    render(
      <SteamQrLoginView
        title="Подключите Steam"
        onDone={onDone}
        start={start}
        status={status}
        pollMs={POLL_MS}
      />,
    );

    expect(screen.getByText("Подключите Steam")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("Ждём сканирования")).toBeTruthy();
      expect(document.querySelector("svg")).not.toBeNull();
    });

    current = view({ status: "scanned", qrUrl: null });
    await waitFor(() =>
      expect(
        screen.getByText("Подтвердите вход в приложении Steam"),
      ).toBeTruthy(),
    );

    current = view({ status: "done", qrUrl: null });
    await waitFor(() => expect(screen.getByText("Готово")).toBeTruthy());
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("expired offers a new code", async () => {
    let n = 0;
    const start = mock(async () => ({ attemptId: `a${++n}` }));
    const status = mock(async () => view({ status: "expired" }));

    render(
      <SteamQrLoginView
        title="Подключите Steam"
        onDone={() => {}}
        start={start}
        status={status}
        pollMs={POLL_MS}
      />,
    );

    await waitFor(() => expect(screen.getByText("Время вышло")).toBeTruthy());
    expect(start).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Показать новый код" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("failed shows the reason", async () => {
    const start = mock(async () => ({ attemptId: "a1" }));
    const status = mock(async () =>
      view({ status: "failed", reason: "Сначала отвяжите текущий Steam" }),
    );

    render(
      <SteamQrLoginView
        title="Подключите Steam"
        onDone={() => {}}
        start={start}
        status={status}
        pollMs={POLL_MS}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Сначала отвяжите текущий Steam")).toBeTruthy(),
    );
  });
});
