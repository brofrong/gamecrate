import { describe, expect, it } from "bun:test";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { AppHeader } from "../src/components/AppHeader";
import { testRouter } from "./router";

const html = await Bun.file(
  new URL("../src/index.html", import.meta.url),
).text();
const css = await Bun.file(
  new URL("../src/styles.css", import.meta.url),
).text();
const fonts = await Bun.file(
  new URL("../src/fonts.ts", import.meta.url),
).text();

describe("branding", () => {
  it("index.html is titled GameCrate", () => {
    expect(html).toContain("<title>GameCrate — облачный гейминг</title>");
    expect(html).toContain('name="theme-color" content="#05060f"');
  });

  it("styles import self-hosted fonts and brand tokens", () => {
    // Только нужные подмножества: latin + cyrillic у Inter, latin у моноширинного.
    expect(fonts).toContain(
      "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    );
    expect(fonts).toContain(
      "@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2",
    );
    expect(fonts).toContain(
      "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
    );
    expect(css).not.toContain("@fontsource-variable");
    expect(css).toContain('--font-sans: "Inter Variable"');
    expect(css).toContain('--font-mono: "JetBrains Mono Variable"');
    expect(css).toContain("--brand-accent: #3cc2ff");
    expect(css).toContain("--brand-cyan: var(--brand-accent)");
    expect(css).toContain("--color-brand-cyan: var(--brand-cyan)");
    expect(css).not.toContain("googleapis");
  });

  it("brand assets exist and are svg", async () => {
    for (const f of [
      "logo-full.svg",
      "logo-full-light.svg",
      "logo-mark.svg",
      "favicon.svg",
    ]) {
      const text = await Bun.file(
        new URL(`../src/assets/brand/${f}`, import.meta.url),
      ).text();
      expect(text.startsWith("<svg")).toBe(true);
      expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
    }
    expect(
      await Bun.file(
        new URL("../src/assets/brand/apple-touch-icon.png", import.meta.url),
      ).exists(),
    ).toBe(true);
  });

  it("favicon is the ring, the mark is the cube", async () => {
    const read = (f: string) =>
      Bun.file(new URL(`../src/assets/brand/${f}`, import.meta.url)).text();
    const favicon = await read("favicon.svg");
    const mark = await read("logo-mark.svg");
    expect(favicon).not.toBe(mark);
    expect(favicon).toContain('opacity="1"');
    expect(mark).toContain('opacity="0"');
  });

  it("index.html links the favicon", () => {
    expect(html).toContain('href="./assets/brand/favicon.svg"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it("app header shows GameCrate", async () => {
    render(
      <RouterProvider router={testRouter(<AppHeader user={undefined} />)} />,
    );
    expect(await screen.findByText("GameCrate")).toBeTruthy();
    expect(screen.getByRole("img", { name: "GameCrate" })).toBeTruthy();
  });
});
