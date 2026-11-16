// Монетизация витрины: у GameCrate свои тарифы и цены, у партнёра (билайн) — подписка
// без цен, каталога и кнопок покупки. Лендинг, `/app/plans`, `PlanPanel`, пункт меню,
// плашка лимита в стриме и подсказка про тариф выше в очереди.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { PlayerPlan, PublicTariff } from "@cg/rpc";
import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { AsyncResult, Atom } from "effect/reactivity";
import { authStub, rpcStub } from "./moduleStubs";
import { testRouter } from "./router";

mock.module("../src/auth", authStub);

const { BrandProvider, WEB_BRANDS } = await import("../src/brands");
const { LandingPage } = await import("../src/components/landing/LandingPage");
const { LandingNav } = await import("../src/components/landing/LandingNav");
const { PlanPanel } = await import("../src/components/app/PlanPanel");
const { LimitWarning } = await import("../src/components/session/LimitWarning");
const { showHigherTariffHint } = await import("../src/lib/planFormat");
const { reportStartError } = await import("../src/lib/usePlaySession");
const { toast } = await import("sonner");

type Brand = (typeof WEB_BRANDS)[keyof typeof WEB_BRANDS];

const basic: PublicTariff = {
  id: "t1",
  name: "Базовый",
  priceRub: 490,
  queuePriority: 0,
  monthlyMinutes: null,
  rollover: false,
  maxResolution: "1440p",
  maxBitrateMbps: 40,
  maxSessionMinutes: null,
};

const plan: PlayerPlan = {
  tariff: basic,
  remainingMinutes: null,
  grantEndsAt: null,
  nextRefillAt: null,
  tariffs: [basic, { ...basic, id: "t2", name: "Про", priceRub: 990 }],
  hourPacks: [
    {
      id: "h1",
      name: "10 часов",
      minutes: 600,
      priceRub: 300,
      archived: false,
    },
  ],
};

const partner = (brand: Brand) => {
  if (brand.monetization.kind !== "partner") throw new Error("не партнёр");
  return brand.monetization;
};

afterEach(() => {
  delete document.documentElement.dataset.brand;
});

describe("лендинг", () => {
  const renderLanding = (brand: Brand) =>
    render(
      <BrandProvider brand={brand}>
        <RouterProvider router={testRouter(<LandingPage />)} />
      </BrandProvider>,
    );

  it("билайн: подписка вместо тарифов — без ₽", async () => {
    renderLanding(WEB_BRANDS.beeline);
    await screen.findByRole("heading", { level: 1 });
    const { title, text } = partner(WEB_BRANDS.beeline);
    expect(document.body.textContent).not.toContain("₽");
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(document.body.textContent).toContain(text);
    expect(document.body.textContent).not.toContain("Платишь за часы игры");
  });

  it("билайн: ссылки на партнёра нет, пока url = null", async () => {
    renderLanding(WEB_BRANDS.beeline);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: /Перейти в/ })).toBeNull();
  });

  it("GameCrate: секция тарифов с ценами, как раньше", async () => {
    renderLanding(WEB_BRANDS.gamecrate);
    await screen.findByRole("heading", { level: 1 });
    expect(document.body.textContent).toContain("₽");
    expect(
      screen.getByRole("heading", { name: "Платишь за часы игры" }),
    ).toBeTruthy();
  });
});

describe("пункт меню лендинга", () => {
  const renderNav = (brand: Brand) =>
    render(
      <BrandProvider brand={brand}>
        <RouterProvider router={testRouter(<LandingNav />)} />
      </BrandProvider>,
    );

  it("билайн: «Подписка», тот же якорь #plans", async () => {
    renderNav(WEB_BRANDS.beeline);
    const link = await screen.findByRole("link", { name: "Подписка" });
    expect(link.getAttribute("href")).toBe("#plans");
    expect(screen.queryByRole("link", { name: "Тарифы" })).toBeNull();
  });

  it("GameCrate: «Тарифы»", async () => {
    renderNav(WEB_BRANDS.gamecrate);
    const link = await screen.findByRole("link", { name: "Тарифы" });
    expect(link.getAttribute("href")).toBe("#plans");
    expect(screen.queryByRole("link", { name: "Подписка" })).toBeNull();
  });
});

describe("страница тарифов /app/plans", () => {
  const renderPlans = async (brand: Brand) => {
    const accountPlanAtom = Atom.make(
      AsyncResult.success<PlayerPlan, { readonly _tag: string }>(plan),
    );
    mock.module("../src/rpc", () => ({ ...rpcStub(), accountPlanAtom }));
    const { PlansRouteView } =
      await import("../src/components/app/PlansRouteView");
    return render(
      <BrandProvider brand={brand}>
        <RegistryProvider>
          <PlansRouteView />
        </RegistryProvider>
      </BrandProvider>,
    );
  };

  it("билайн: «Базовый», безлимит, без ₽ и без кнопок покупки", async () => {
    await renderPlans(WEB_BRANDS.beeline);
    const { title, text } = partner(WEB_BRANDS.beeline);
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect(document.body.textContent).toContain(text);
    expect(screen.getByText("Базовый")).toBeTruthy();
    expect(screen.getByText("без лимита")).toBeTruthy();
    expect(document.body.textContent).not.toContain("₽");
    expect(screen.queryByText("Про")).toBeNull();
    expect(screen.queryByText("Пакеты часов")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link", { name: /Перейти в/ })).toBeNull();
  });

  it("билайн: ссылка «Перейти в билайн», когда url задан", async () => {
    const brand: Brand = {
      ...WEB_BRANDS.beeline,
      monetization: {
        ...partner(WEB_BRANDS.beeline),
        url: "https://example.test/sub",
      },
    };
    await renderPlans(brand);
    const link = await screen.findByRole("link", { name: "Перейти в билайн" });
    expect(link.getAttribute("href")).toBe("https://example.test/sub");
  });

  it("GameCrate: каталог тарифов и пакеты с ценами, как раньше", async () => {
    await renderPlans(WEB_BRANDS.gamecrate);
    expect(
      await screen.findByText("Оплата на сайте скоро появится"),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Про" })).toBeTruthy();
    expect(screen.getByText("300 ₽")).toBeTruthy();
  });
});

describe("PlanPanel", () => {
  const renderPanel = (brand: Brand) =>
    render(
      <BrandProvider brand={brand}>
        <RouterProvider router={testRouter(<PlanPanel plan={plan} />)} />
      </BrandProvider>,
    );

  it("билайн: «Подписка» ведёт на /app/plans, «Докупить» нет", async () => {
    renderPanel(WEB_BRANDS.beeline);
    const link = await screen.findByRole("link", { name: "Подписка" });
    expect(link.getAttribute("href")).toBe("/app/plans");
    expect(screen.queryByRole("link", { name: "Докупить" })).toBeNull();
  });

  it("GameCrate: «Докупить»", async () => {
    renderPanel(WEB_BRANDS.gamecrate);
    const link = await screen.findByRole("link", { name: "Докупить" });
    expect(link.getAttribute("href")).toBe("/app/plans");
    expect(screen.queryByRole("link", { name: "Подписка" })).toBeNull();
  });
});

describe("плашка лимита минут в стриме", () => {
  const T = Date.parse("2026-11-11T12:00:00.000Z");
  const renderWarning = (brand: Brand) =>
    render(
      <BrandProvider brand={brand}>
        <LimitWarning
          limit={{
            deadline: new Date(T + 5 * 60_000).toISOString(),
            reason: "minutes",
          }}
          now={() => T}
        />
      </BrandProvider>,
    );

  it("билайн: «Подписка» на /app/plans, «Докупить» нет", () => {
    renderWarning(WEB_BRANDS.beeline);
    const link = screen.getByRole("link", { name: "Подписка" });
    expect(link.getAttribute("href")).toBe("/app/plans");
    expect(screen.queryByRole("link", { name: "Докупить" })).toBeNull();
  });

  it("GameCrate: «Докупить»", () => {
    renderWarning(WEB_BRANDS.gamecrate);
    expect(screen.getByRole("link", { name: "Докупить" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Подписка" })).toBeNull();
  });
});

describe("подсказка «В тарифе выше очередь короче»", () => {
  it("билайн: нет, хотя в каталоге есть тариф с приоритетом выше", () => {
    const higher = {
      ...plan,
      tariffs: [basic, { ...basic, id: "t2", queuePriority: 10 }],
    };
    expect(showHigherTariffHint(WEB_BRANDS.beeline.monetization, higher)).toBe(
      false,
    );
    expect(
      showHigherTariffHint(WEB_BRANDS.gamecrate.monetization, higher),
    ).toBe(true);
  });

  it("GameCrate: нет, если выше тарифа нет", () => {
    expect(showHigherTariffHint(WEB_BRANDS.gamecrate.monetization, plan)).toBe(
      false,
    );
  });
});

describe("тост «Часы закончились» при старте игры", () => {
  const actionLabel = (brand: string | undefined) => {
    if (brand !== undefined) document.documentElement.dataset.brand = brand;
    const toastError = spyOn(toast, "error").mockImplementation(
      () => "" as never,
    );
    reportStartError("NoMinutes");
    const [, options] = toastError.mock.calls[0] ?? [];
    toastError.mockRestore();
    return (options as { action?: { label?: string } } | undefined)?.action
      ?.label;
  };

  it("билайн: «Подписка»", () => {
    expect(actionLabel("beeline")).toBe("Подписка");
  });

  it("GameCrate (без data-brand): «Докупить»", () => {
    expect(actionLabel(undefined)).toBe("Докупить");
  });
});
