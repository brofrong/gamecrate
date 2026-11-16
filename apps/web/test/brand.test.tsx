// Витрина по домену: реестр (`currentBrand`), название и логотип в лендинге, панели входа
// и оболочке `/app`, фильтр способов входа по `data-oauth`, подмены страниц `BrandSlot`.
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AuthProviders, CurrentUserShape } from "@cg/rpc";
import { render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { lazy } from "react";
import { authStub } from "./moduleStubs";
import { testRouter } from "./router";

// Все имена `../src/auth` (подмена — на весь прогон, см. `moduleStubs.ts`).
mock.module("../src/auth", authStub);

const { BrandProvider, WEB_BRANDS, currentBrand, providersForPage, useBrand } =
  await import("../src/brands");
const { BrandSlot } = await import("../src/components/brand/BrandSlot");
const { BrandLogo } = await import("../src/components/brand/BrandLogo");
const { LandingPage } = await import("../src/components/landing/LandingPage");
const { LoginPanel } = await import("../src/components/login/LoginPanel");
const { Rail } = await import("../src/components/app/Rail");
const { AppHeader } = await import("../src/components/AppHeader");
const { authErrorMessage } = await import("../src/lib/authErrors");

const noop = () => {};

const gamer: CurrentUserShape = {
  id: "u1",
  name: "Gamer",
  image: null,
  role: "player",
  steamId: "7656",
  email: null,
  emailVerified: false,
};

const allProviders: AuthProviders = {
  google: true,
  yandex: true,
  pocketId: true,
  telegram: true,
};

afterEach(() => {
  delete document.documentElement.dataset.brand;
});

describe("currentBrand", () => {
  it("data-brand=beeline → билайн", () => {
    document.documentElement.dataset.brand = "beeline";
    expect(currentBrand().name).toBe("билайн");
  });

  it("неизвестное значение и отсутствие атрибута → gamecrate", () => {
    document.documentElement.dataset.brand = "nope";
    expect(currentBrand().id).toBe("gamecrate");
    delete document.documentElement.dataset.brand;
    expect(currentBrand().id).toBe("gamecrate");
    expect(currentBrand().name).toBe("GameCrate");
  });

  it("useBrand без провайдера читает data-brand, с провайдером — его витрину", () => {
    document.documentElement.dataset.brand = "beeline";
    const Name = () => <span>{useBrand().name}</span>;
    const { container, rerender } = render(<Name />);
    expect(container.textContent).toBe("билайн");
    rerender(
      <BrandProvider brand={WEB_BRANDS.gamecrate}>
        <Name />
      </BrandProvider>,
    );
    expect(container.textContent).toBe("GameCrate");
  });
});

describe("название и логотип витрины", () => {
  const renderLanding = (brand: (typeof WEB_BRANDS)[keyof typeof WEB_BRANDS]) =>
    render(
      <BrandProvider brand={brand}>
        <RouterProvider router={testRouter(<LandingPage />)} />
      </BrandProvider>,
    );

  it("лендинг билайна: нет «GameCrate», есть «билайн»", async () => {
    renderLanding(WEB_BRANDS.beeline);
    await screen.findByRole("heading", { level: 1 });
    expect(document.body.innerHTML).not.toContain("GameCrate");
    expect(document.body.textContent).toContain("билайн");
    expect(document.body.textContent).not.toContain("Games in containers");
    expect(document.body.textContent).toContain(
      "© 2026 билайн. Steam является торговой маркой Valve Corporation.",
    );
  });

  it("лендинг GameCrate: как раньше со слоганом", async () => {
    renderLanding(WEB_BRANDS.gamecrate);
    await screen.findByRole("heading", { level: 1 });
    expect(document.body.textContent).toContain(
      "GameCrate · Games in containers",
    );
    expect(document.body.textContent).toContain("© 2026 GameCrate.");
  });

  const renderPanel = (brand: (typeof WEB_BRANDS)[keyof typeof WEB_BRANDS]) =>
    render(
      <BrandProvider brand={brand}>
        <LoginPanel
          providers={allProviders}
          next="/app"
          onLevel={noop}
          onTint={noop}
          onLit={noop}
        />
      </BrandProvider>,
    );

  it("панель входа билайна", () => {
    renderPanel(WEB_BRANDS.beeline);
    expect(document.body.innerHTML).not.toContain("GameCrate");
    expect(
      screen.getByRole("heading", { name: "Войти в билайн" }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("аккаунт билайн");
  });

  it("панель входа GameCrate", () => {
    renderPanel(WEB_BRANDS.gamecrate);
    expect(
      screen.getByRole("heading", { name: "Войти в GameCrate" }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("аккаунт GameCrate");
  });

  it("оболочка /app билайна: Rail и AppHeader без «GameCrate»", async () => {
    render(
      <BrandProvider brand={WEB_BRANDS.beeline}>
        <RouterProvider
          router={testRouter(
            <>
              <AppHeader user={gamer} />
              <Rail user={gamer} />
            </>,
          )}
        />
      </BrandProvider>,
    );
    await screen.findByRole("link", { name: "Мои игры" });
    expect(document.body.innerHTML).not.toContain("GameCrate");
    expect(document.body.textContent).toContain("билайн");
    expect(
      screen.getAllByRole("link", { name: "билайн" }).length,
    ).toBeGreaterThan(0);
  });

  it("оболочка /app GameCrate: как раньше", async () => {
    render(
      <BrandProvider brand={WEB_BRANDS.gamecrate}>
        <RouterProvider
          router={testRouter(
            <>
              <AppHeader user={gamer} />
              <Rail user={gamer} />
            </>,
          )}
        />
      </BrandProvider>,
    );
    await screen.findByRole("link", { name: "Мои игры" });
    expect(document.body.textContent).toContain("GameCrate");
    expect(screen.getByRole("link", { name: "GameCrate" })).toBeTruthy();
  });

  it("BrandLogo берёт логотип витрины и пробрасывает пропсы", () => {
    const { container } = render(
      <BrandProvider brand={WEB_BRANDS.beeline}>
        <BrandLogo height={40} />
      </BrandProvider>,
    );
    const mark = screen.getByRole("img", { name: "билайн" });
    expect(mark).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("40");
  });

  it("логотип билайна: iconOnly — без слова, title переопределяет подпись", () => {
    const { container } = render(
      <BrandProvider brand={WEB_BRANDS.beeline}>
        <BrandLogo iconOnly height={24} progress={0.5} title="Домой" />
      </BrandProvider>,
    );
    expect(screen.getByRole("img", { name: "Домой" })).toBeTruthy();
    expect(container.querySelector("text")).toBeNull();
  });

  it("authErrorMessage подставляет название витрины", () => {
    expect(
      authErrorMessage("ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER", "билайн"),
    ).toBe("Этот аккаунт уже привязан к другому пользователю билайн");
    expect(authErrorMessage("ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER")).toBe(
      "Этот аккаунт уже привязан к другому пользователю GameCrate",
    );
  });
});

describe("providersForPage", () => {
  it("оставляет только перечисленные в data-oauth", () => {
    expect(
      providersForPage(
        { google: true, yandex: true, pocketId: true, telegram: false },
        "yandex",
      ),
    ).toEqual({
      google: false,
      yandex: true,
      pocketId: false,
      telegram: false,
    });
  });

  it("не включает то, чего нет на сервере", () => {
    expect(
      providersForPage(
        { google: false, yandex: true, pocketId: false, telegram: false },
        "google yandex",
      ),
    ).toEqual({
      google: false,
      yandex: true,
      pocketId: false,
      telegram: false,
    });
  });

  it("токен pocket-id → pocketId", () => {
    expect(providersForPage(allProviders, "pocket-id")).toEqual({
      google: false,
      yandex: false,
      pocketId: true,
      telegram: false,
    });
    expect(providersForPage(allProviders, "google pocket-id telegram")).toEqual(
      { google: true, yandex: false, pocketId: true, telegram: true },
    );
  });

  it("атрибута нет (dev) — без изменений", () => {
    expect(providersForPage(allProviders, undefined)).toEqual(allProviders);
  });

  it("атрибут пустой — все способы выключены", () => {
    expect(providersForPage(allProviders, "")).toEqual({
      google: false,
      yandex: false,
      pocketId: false,
      telegram: false,
    });
  });
});

describe("BrandSlot", () => {
  const Fallback = ({ label }: { label: string }) => <p>запасной {label}</p>;

  it("без подмены рисует fallback с пропсами", () => {
    render(
      <BrandProvider brand={WEB_BRANDS.gamecrate}>
        <BrandSlot name="landing" fallback={Fallback} label="раз" />
      </BrandProvider>,
    );
    expect(screen.getByText("запасной раз")).toBeTruthy();
  });

  it("с подменой — после ожидания виден «свой», пропсы доходят", async () => {
    const Own = ({ label }: { label?: string }) => <p>свой {label}</p>;
    const brand = {
      ...WEB_BRANDS.gamecrate,
      overrides: {
        landing: lazy(() => Promise.resolve({ default: Own })),
      },
    };
    render(
      <BrandProvider brand={brand}>
        <BrandSlot name="landing" fallback={Fallback} label="два" />
      </BrandProvider>,
    );
    expect(await screen.findByText("свой два")).toBeTruthy();
    expect(screen.queryByText(/запасной/)).toBeNull();
  });

  it("подмена другого ключа не влияет", () => {
    const brand = {
      ...WEB_BRANDS.gamecrate,
      overrides: {
        plansPage: lazy(() => Promise.resolve({ default: () => <p>чужой</p> })),
      },
    };
    render(
      <BrandProvider brand={brand}>
        <BrandSlot name="landing" fallback={Fallback} label="три" />
      </BrandProvider>,
    );
    expect(screen.getByText("запасной три")).toBeTruthy();
  });
});
