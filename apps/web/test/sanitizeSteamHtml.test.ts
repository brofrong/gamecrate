// Очистка HTML описания из Steam Store (спека 2026-10-27 §3.5): allowlist тегов,
// атрибуты срезаются, `img` только с steamstatic.com по https, скрипты удаляются.
import { describe, expect, it } from "bun:test";
import { sanitizeSteamHtml } from "../src/lib/sanitizeSteamHtml";

describe("sanitizeSteamHtml", () => {
  it("keeps allowed tags and strips attributes", () => {
    expect(
      sanitizeSteamHtml(
        '<p class="x" onclick="y">Hi <strong>there</strong></p>',
      ),
    ).toBe("<p>Hi <strong>there</strong></p>");
  });

  it("drops script with content and unwraps unknown tags", () => {
    expect(
      sanitizeSteamHtml("<div>a<script>alert(1)</script><span>b</span></div>"),
    ).toBe("ab");
  });

  it("keeps steamstatic images, drops others", () => {
    expect(
      sanitizeSteamHtml(
        '<img src="https://shared.akamai.steamstatic.com/x.gif" alt="a"><img src="https://evil.example/x.gif">',
      ),
    ).toBe('<img src="https://shared.akamai.steamstatic.com/x.gif" alt="a">');
  });

  it("drops javascript: and http: image sources", () => {
    expect(
      sanitizeSteamHtml(
        '<img src="javascript:alert(1)"><img src="http://cdn.steamstatic.com/x.gif"><br>',
      ),
    ).toBe("<br>");
  });

  it("keeps lists and headings, drops style blocks", () => {
    expect(
      sanitizeSteamHtml(
        "<style>p{}</style><h2>Особенности</h2><ul><li>одна</li><li>две</li></ul>",
      ),
    ).toBe("<h2>Особенности</h2><ul><li>одна</li><li>две</li></ul>");
  });
});
