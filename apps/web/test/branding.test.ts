import { describe, expect, it } from "bun:test";

const html = await Bun.file(new URL("../src/index.html", import.meta.url)).text();
const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

describe("branding", () => {
  it("index.html is titled GameCrate", () => {
    expect(html).toContain("<title>GameCrate — облачный гейминг</title>");
    expect(html).toContain('name="theme-color" content="#05060f"');
  });

  it("styles import self-hosted fonts and brand tokens", () => {
    expect(css).toContain('@import "@fontsource-variable/inter"');
    expect(css).toContain('@import "@fontsource-variable/jetbrains-mono"');
    expect(css).toContain("--brand-cyan: #3cc2ff");
    expect(css).toContain("--color-brand-cyan: var(--brand-cyan)");
    expect(css).not.toContain("googleapis");
  });
});
