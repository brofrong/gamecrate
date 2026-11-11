// Предупреждение о лимите тарифа поверх стрима (спека §4, §7; бриф задачи 11): плашка
// за 10 и за 2 минуты до дедлайна, «Докупить» только при нехватке минут, крестиком
// закрывается и обязательно возвращается на 2-минутной отметке. Отсчёт — как у
// `IdlePrompt` (`session.test.tsx`): мутируемое `now`, без фейковых таймеров.
import { describe, expect, it } from "bun:test";
import type { SessionLimitView } from "@cg/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LimitWarning } from "../src/components/session/LimitWarning";

const T = Date.parse("2026-11-11T12:00:00.000Z");

describe("LimitWarning", () => {
  it("hidden at 11 min, shown at 9 min, reappears at 2 min after dismiss", async () => {
    const limit: SessionLimitView = {
      deadline: new Date(T + 11 * 60_000).toISOString(),
      reason: "minutes",
    };
    let now = T;
    render(<LimitWarning limit={limit} now={() => now} />);
    expect(screen.queryByText("Часы заканчиваются — сохранитесь")).toBeNull();

    // 2 минуты прошло — остаток 9 минут, плашка появляется.
    now = T + 2 * 60_000;
    await waitFor(() =>
      expect(
        screen.getByText("Часы заканчиваются — сохранитесь"),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Скрыть" }));
    expect(screen.queryByText("Часы заканчиваются — сохранитесь")).toBeNull();

    // Остаток 2 минуты — плашка возвращается, хотя её закрыли.
    now = T + 9 * 60_000;
    await waitFor(() =>
      expect(
        screen.getByText("Часы заканчиваются — сохранитесь"),
      ).toBeTruthy(),
    );
  });

  it("session_length has no «Докупить»; minutes does, opening /app/plans in a new tab", () => {
    const sessionLength = render(
      <LimitWarning
        limit={{
          deadline: new Date(T + 5 * 60_000).toISOString(),
          reason: "session_length",
        }}
        now={() => T}
      />,
    );
    expect(
      screen.getByText("Сессия скоро закончится — сохранитесь"),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Докупить" })).toBeNull();
    sessionLength.unmount();

    render(
      <LimitWarning
        limit={{
          deadline: new Date(T + 5 * 60_000).toISOString(),
          reason: "minutes",
        }}
        now={() => T}
      />,
    );
    expect(screen.getByText("Часы заканчиваются — сохранитесь")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Докупить" });
    expect(link.getAttribute("href")).toBe("/app/plans");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
