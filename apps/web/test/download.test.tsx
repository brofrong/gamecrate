// Страница «Скачать» (`/download`): определение ОС, разбор `latest.json`, большая кнопка под
// ОС посетителя, остальные ниже, версия, инструкции «без подписи»; ссылка «Скачать приложение»
// в профиле и на лендинге — только в браузере.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { DownloadLink } from "../src/components/DownloadLink";
import { LandingFooter } from "../src/components/landing/LandingFooter";
import {
  DownloadContent,
  DownloadPage,
} from "../src/routes/download";
import { detectOs } from "../src/lib/detectOs";
import { parseRelease, type Release } from "../src/lib/desktopRelease";
import { testRouter } from "./router";

const ua = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

describe("detectOs", () => {
  it("по User-Agent: Windows, macOS, Linux", () => {
    expect(detectOs({ userAgent: ua.windows })).toBe("windows");
    expect(detectOs({ userAgent: ua.mac })).toBe("macos");
    expect(detectOs({ userAgent: ua.linux })).toBe("linux");
  });

  it("телефоны и неизвестное — null (Android — тоже Linux в UA, но приложения для него нет)", () => {
    expect(detectOs({ userAgent: ua.android })).toBeNull();
    expect(detectOs({ userAgent: ua.iphone })).toBeNull();
    expect(detectOs({ userAgent: "curl/8.0" })).toBeNull();
    expect(detectOs({ userAgent: "" })).toBeNull();
  });

  it("userAgentData.platform главнее User-Agent", () => {
    expect(
      detectOs({ userAgent: ua.linux, userAgentData: { platform: "Windows" } }),
    ).toBe("windows");
    expect(
      detectOs({ userAgent: "", userAgentData: { platform: "macOS" } }),
    ).toBe("macos");
    expect(
      detectOs({ userAgent: "", userAgentData: { platform: "Linux" } }),
    ).toBe("linux");
    expect(
      detectOs({ userAgent: ua.windows, userAgentData: { platform: "Android" } }),
    ).toBeNull();
  });

  it("без аргумента смотрит в navigator", () => {
    // User-Agent у happy-dom зависит от машины («X11; Darwin»/«X11; Linux»), поэтому задаём свой
    const original = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    const proto = Object.getPrototypeOf(navigator) as object;
    const inherited = Object.getOwnPropertyDescriptor(proto, "userAgent");
    const setAgent = (value: string) =>
      Object.defineProperty(navigator, "userAgent", {
        value,
        configurable: true,
      });
    try {
      setAgent(ua.windows);
      expect(detectOs()).toBe("windows");
      setAgent("curl/8.0");
      expect(detectOs()).toBeNull();
    } finally {
      if (original !== undefined)
        Object.defineProperty(navigator, "userAgent", original);
      else Reflect.deleteProperty(navigator, "userAgent");
      expect(Object.getOwnPropertyDescriptor(proto, "userAgent")).toEqual(
        inherited,
      );
    }
  });
});

const manifest = {
  version: "0.1.0",
  notes: "Первая версия",
  pub_date: "2026-11-16T12:00:00Z",
  platforms: {
    "darwin-aarch64": { signature: "s", url: "/download/desktop/0.1.0/m.app.tar.gz" },
    "darwin-x86_64": { signature: "s", url: "/download/desktop/0.1.0/m.app.tar.gz" },
    "windows-x86_64": { signature: "s", url: "/download/desktop/0.1.0/w-setup.exe" },
    "linux-x86_64": { signature: "s", url: "/download/desktop/0.1.0/l.AppImage" },
  },
  downloads: {
    macos: { url: "/download/desktop/0.1.0/m.dmg", size: 95 * 1024 * 1024 },
    windows: { url: "/download/desktop/0.1.0/w-setup.exe", size: 80 * 1024 * 1024 },
  },
};

describe("parseRelease", () => {
  it("берёт установщики из downloads, остальное — из platforms updater", () => {
    const release = parseRelease(manifest);
    expect(release?.version).toBe("0.1.0");
    expect(release?.downloads.macos).toEqual({
      url: "/download/desktop/0.1.0/m.dmg",
      size: 95 * 1024 * 1024,
    });
    expect(release?.downloads.windows?.url).toBe(
      "/download/desktop/0.1.0/w-setup.exe",
    );
    expect(release?.downloads.linux).toEqual({
      url: "/download/desktop/0.1.0/l.AppImage",
    });
  });

  it("без downloads macOS ведёт на архив updater", () => {
    const { downloads: _, ...plain } = manifest;
    expect(parseRelease(plain)?.downloads.macos?.url).toBe(
      "/download/desktop/0.1.0/m.app.tar.gz",
    );
  });

  it("мусор и чужие схемы ссылок — не релиз и не ссылка", () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease("x")).toBeNull();
    expect(parseRelease({})).toBeNull();
    expect(parseRelease({ version: 1, platforms: {} })).toBeNull();
    expect(
      parseRelease({
        version: "1.0.0",
        platforms: {},
        downloads: {
          windows: { url: "javascript:alert(1)" },
          linux: { url: "https://game.brofrong.ru/download/desktop/1.0.0/l.AppImage" },
        },
      })?.downloads,
    ).toEqual({
      linux: { url: "https://game.brofrong.ru/download/desktop/1.0.0/l.AppImage" },
    });
  });
});

const release = parseRelease(manifest) as Release;

const renderContent = (state: Parameters<typeof DownloadContent>[0]["state"], os: "windows" | "macos" | "linux" | null) =>
  render(
    <RouterProvider
      router={testRouter(<DownloadContent state={state} os={os} />)}
    />,
  );

describe("DownloadContent", () => {
  it("большая кнопка — под ОС посетителя, остальные ниже, версия и размер", async () => {
    renderContent({ kind: "ready", release }, "windows");
    const main = await screen.findByRole("link", {
      name: /Скачать для Windows/,
    });
    expect(main.getAttribute("href")).toBe("/download/desktop/0.1.0/w-setup.exe");
    expect(main.textContent).toContain("80 МБ");
    expect(screen.getByText(/Версия 0\.1\.0/)).toBeTruthy();
    const others = screen.getByRole("group", { name: "Другие системы" });
    expect(others.textContent).toContain("macOS");
    expect(others.textContent).toContain("Linux");
    expect(others.textContent).not.toContain("Windows");
    expect(
      others.querySelector('a[href="/download/desktop/0.1.0/m.dmg"]'),
    ).not.toBeNull();
  });

  it("macOS: кнопка ведёт на dmg", async () => {
    renderContent({ kind: "ready", release }, "macos");
    const main = await screen.findByRole("link", { name: /Скачать для macOS/ });
    expect(main.getAttribute("href")).toBe("/download/desktop/0.1.0/m.dmg");
  });

  it("ОС не определилась — все три равноправны, без «Другие системы»", async () => {
    renderContent({ kind: "ready", release }, null);
    expect(
      await screen.findByRole("link", { name: /Скачать для Windows/ }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Скачать для macOS/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Скачать для Linux/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Другие системы" })).toBeNull();
  });

  it("ОС, для которой в манифесте нет файла, не получает ссылки", async () => {
    const partial = parseRelease({
      version: "0.2.0",
      platforms: {
        "windows-x86_64": { signature: "s", url: "/download/desktop/0.2.0/w-setup.exe" },
      },
    }) as Release;
    renderContent({ kind: "ready", release: partial }, "linux");
    expect(screen.queryByRole("link", { name: /Скачать для Linux/ })).toBeNull();
    expect(
      await screen.findByRole("link", { name: /Скачать для Windows/ }),
    ).toBeTruthy();
    expect(screen.getByText(/Для Linux пока нет сборки/)).toBeTruthy();
  });

  it("инструкции «без подписи» для всех трёх ОС", async () => {
    renderContent({ kind: "ready", release }, "windows");
    await screen.findByText(/Версия 0\.1\.0/);
    expect(screen.getByText(/Подробнее/).textContent).toContain(
      "Выполнить в любом случае",
    );
    expect(screen.getByText(/правой кнопкой/i).textContent).toContain("Открыть");
    expect(screen.getByText(/chmod \+x/)).toBeTruthy();
  });

  it("нет манифеста — «Скоро», а не ошибка и не пустота", async () => {
    renderContent({ kind: "missing" }, "windows");
    expect(await screen.findByText("Скоро")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Скачать для/ })).toBeNull();
    // в браузер играть можно
    expect(screen.getByRole("link", { name: /в браузере/i })).toBeTruthy();
  });

  it("пока грузится — без кнопок и без «Скоро»", async () => {
    renderContent({ kind: "loading" }, "windows");
    expect(await screen.findByText(/Загружаем/)).toBeTruthy();
    expect(screen.queryByText("Скоро")).toBeNull();
  });
});

describe("DownloadPage", () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  afterEach(() => fetchSpy.mockReset());

  it("читает /download/desktop/latest.json и показывает версию", async () => {
    fetchSpy.mockImplementation((async () =>
      new Response(JSON.stringify(manifest), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch);
    render(<RouterProvider router={testRouter(<DownloadPage />)} />);
    expect(await screen.findByText(/Версия 0\.1\.0/)).toBeTruthy();
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toBe("/download/desktop/latest.json");
  });

  it("404 от сервера — «Скоро»", async () => {
    fetchSpy.mockImplementation((async () =>
      new Response("Not found", { status: 404 })) as unknown as typeof fetch);
    render(<RouterProvider router={testRouter(<DownloadPage />)} />);
    expect(await screen.findByText("Скоро")).toBeTruthy();
  });

  it("сеть упала или не JSON — тоже «Скоро»", async () => {
    fetchSpy.mockImplementation((async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    const first = render(<RouterProvider router={testRouter(<DownloadPage />)} />);
    expect(await screen.findByText("Скоро")).toBeTruthy();
    first.unmount();

    fetchSpy.mockImplementation((async () =>
      new Response("<html>spa</html>")) as unknown as typeof fetch);
    render(<RouterProvider router={testRouter(<DownloadPage />)} />);
    await waitFor(() => expect(screen.getByText("Скоро")).toBeTruthy());
  });
});

describe("ссылка «Скачать приложение»", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("в браузере ведёт на /download", async () => {
    render(<RouterProvider router={testRouter(<DownloadLink />)} />);
    const link = await screen.findByRole("link", { name: "Скачать приложение" });
    expect(link.getAttribute("href")).toBe("/download");
  });

  it("в приложении её нет", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => {} } });
    render(<RouterProvider router={testRouter(<DownloadLink />)} />);
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Скачать приложение" })).toBeNull(),
    );
  });

  it("есть в подвале лендинга", async () => {
    render(<RouterProvider router={testRouter(<LandingFooter />)} />);
    const link = await screen.findByRole("link", { name: "Скачать приложение" });
    expect(link.getAttribute("href")).toBe("/download");
  });

  it("в подвале лендинга в приложении её нет", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => {} } });
    render(<RouterProvider router={testRouter(<LandingFooter />)} />);
    await screen.findByText(/торговой маркой Valve/);
    expect(screen.queryByRole("link", { name: "Скачать приложение" })).toBeNull();
  });
});
