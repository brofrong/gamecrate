import { describe, expect, it } from "bun:test";

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
    expect(css).toContain("--brand-cyan: #3cc2ff");
    expect(css).toContain("--color-brand-cyan: var(--brand-cyan)");
    expect(css).not.toContain("googleapis");
  });
});
