// Тариф игрока (дизайн §8, спека §2/§7): панель на `/app` (`PlanPanel`, по образцу
// `TimePanel` в `appPanels.test.tsx` — пропы, без своих атомов) и страница тарифов
// `/app/plans` (`PlansPage`, по образцу страниц `/app/*` в `appPages.test.tsx` —
// атом читается внутри компонента, подмена `../src/rpc` через `mock.module`).
import { describe, expect, it, mock } from "bun:test";
import type { HourPack, PlayerPlan, PublicTariff } from "@cg/rpc";
import { render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { RegistryProvider } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { PlanPanel } from "../src/components/app/PlanPanel";
import { formatMinutes, formatPlanDate, tariffPriorityLabel } from "../src/lib/planFormat";
import { rpcStub } from "./moduleStubs";
import { testRouter } from "./router";

const tariff = (
  patch: Partial<PublicTariff> & { id: string; name: string },
): PublicTariff => ({
  priceRub: null,
  queuePriority: 0,
  monthlyMinutes: null,
  rollover: false,
  maxResolution: "1440p",
  maxBitrateMbps: 40,
  maxSessionMinutes: null,
  ...patch,
});

const plan = (patch: Partial<PlayerPlan> = {}): PlayerPlan => ({
  tariff: tariff({ id: "t1", name: "Базовый" }),
  remainingMinutes: null,
  grantEndsAt: null,
  nextRefillAt: null,
  tariffs: [tariff({ id: "t1", name: "Базовый" })],
  hourPacks: [],
  ...patch,
});

describe("formatMinutes", () => {
  it("12 ч 30 мин / 45 мин / round hours / zero", () => {
    expect(formatMinutes(750)).toBe("12 ч 30 мин");
    expect(formatMinutes(45)).toBe("45 мин");
    expect(formatMinutes(120)).toBe("2 ч");
    expect(formatMinutes(0)).toBe("0 мин");
    expect(formatMinutes(-5)).toBe("0 мин");
  });
});

describe("formatPlanDate", () => {
  it("formats in Europe/Moscow regardless of the local timezone", () => {
    // 21:00 UTC 10 декабря — уже 00:00 11 декабря в Москве (+3).
    expect(formatPlanDate("2026-12-10T21:00:00.000Z")).toBe("11 декабря");
    expect(formatPlanDate("2026-12-15T10:00:00.000Z")).toBe("15 декабря");
  });
});

describe("tariffPriorityLabel", () => {
  const start = tariff({ id: "t1", name: "Старт", queuePriority: 0 });
  const pro = tariff({ id: "t2", name: "Про", queuePriority: 5 });
  const ultra = tariff({ id: "t3", name: "Ультра", queuePriority: 10 });
  const tariffs = [start, pro, ultra];

  it("самый высокий приоритет — «Без очереди»", () => {
    expect(tariffPriorityLabel(ultra, tariffs)).toBe("Без очереди");
  });

  it("выше минимального — «Приоритет в очереди»", () => {
    expect(tariffPriorityLabel(pro, tariffs)).toBe("Приоритет в очереди");
  });

  it("минимальный приоритет — «Общая очередь»", () => {
    expect(tariffPriorityLabel(start, tariffs)).toBe("Общая очередь");
  });
});

describe("PlanPanel", () => {
  it("shows the tariff name, remaining hours, and the grant/refill dates", async () => {
    const p = plan({
      tariff: tariff({ id: "t2", name: "Про", queuePriority: 5 }),
      remainingMinutes: 750,
      grantEndsAt: "2026-12-10T21:00:00.000Z",
      nextRefillAt: "2026-12-15T10:00:00.000Z",
    });
    render(<RouterProvider router={testRouter(<PlanPanel plan={p} />)} />);

    expect(await screen.findByText("Про")).toBeTruthy();
    expect(screen.getByText("осталось 12 ч 30 мин")).toBeTruthy();
    expect(screen.getByText("до 11 декабря")).toBeTruthy();
    expect(screen.getByText("пополнение 15 декабря")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Докупить" });
    expect(link.getAttribute("href")).toBe("/app/plans");
  });

  it('shows "без лимита" for an unlimited tariff, without grant/refill lines', async () => {
    const p = plan({ remainingMinutes: null });
    render(<RouterProvider router={testRouter(<PlanPanel plan={p} />)} />);

    expect(await screen.findByText("без лимита")).toBeTruthy();
    expect(screen.queryByText(/^до /)).toBeNull();
    expect(screen.queryByText(/^пополнение /)).toBeNull();
  });

  it("renders nothing while the plan has not loaded yet", () => {
    const { container } = render(<PlanPanel plan={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("PlansPage", () => {
  const start = tariff({ id: "t1", name: "Старт", queuePriority: 0 });
  const pro = tariff({ id: "t2", name: "Про", queuePriority: 5 });
  const ultra = tariff({ id: "t3", name: "Ультра", queuePriority: 10 });

  const hourPack = (
    patch: Partial<HourPack> & { id: string; name: string },
  ): HourPack => ({
    minutes: 600,
    priceRub: 300,
    archived: false,
    ...patch,
  });

  it("marks the current tariff, labels priority, and shows the payment-soon banner", async () => {
    const accountPlanAtom = Atom.make(
      AsyncResult.success<PlayerPlan, { readonly _tag: string }>(
        plan({
          tariff: pro,
          tariffs: [start, pro, ultra],
          hourPacks: [hourPack({ id: "h1", name: "10 часов" })],
        }),
      ),
    );
    mock.module("../src/rpc", () => ({ ...rpcStub(), accountPlanAtom }));
    const { PlansPage } = await import("../src/components/app/PlansPage");

    render(
      <RegistryProvider>
        <PlansPage />
      </RegistryProvider>,
    );

    expect(
      await screen.findByText("Оплата на сайте скоро появится"),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Старт" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Про" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ультра" })).toBeTruthy();

    // Текущий — ровно один, у «Про».
    const current = screen.getByText("Текущий");
    expect(
      current.closest("div")?.textContent?.includes("Про"),
    ).toBe(true);

    expect(screen.getByText("Общая очередь")).toBeTruthy();
    expect(screen.getByText("Приоритет в очереди")).toBeTruthy();
    expect(screen.getByText("Без очереди")).toBeTruthy();

    expect(screen.getByText("10 часов")).toBeTruthy();
    expect(screen.getByText("10 ч")).toBeTruthy();

    // Кнопок покупки нет.
    expect(screen.queryByRole("button", { name: /Купить/ })).toBeNull();
  });

  it("shows a skeleton while the plan has not loaded, and no tariff cards", async () => {
    const accountPlanAtom = Atom.make(
      AsyncResult.initial<PlayerPlan, { readonly _tag: string }>(),
    );
    mock.module("../src/rpc", () => ({ ...rpcStub(), accountPlanAtom }));
    const { PlansPage } = await import("../src/components/app/PlansPage");

    render(
      <RegistryProvider>
        <PlansPage />
      </RegistryProvider>,
    );

    expect(
      await screen.findByText("Оплата на сайте скоро появится"),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Старт" })).toBeNull();
  });
});
