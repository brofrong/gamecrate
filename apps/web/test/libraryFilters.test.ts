// Фильтры библиотеки: состояние ⇄ URL search params и применение к списку игр.
// Чистая логика без React — используется главной `/app`.
import type { LibraryEntry } from "@cg/rpc";
import { describe, expect, it } from "bun:test";
import {
  activeFilterCount,
  applyFilters,
  countMatching,
  DEFAULT_FILTERS,
  type Filters,
  parseSearch,
  toSearch,
} from "../src/lib/libraryFilters";

function entry(
  overrides: Partial<LibraryEntry> & { appId: number; name: string },
): LibraryEntry {
  return {
    appId: overrides.appId,
    name: overrides.name,
    playtimeMinutes: overrides.playtimeMinutes ?? 0,
    protonTier: overrides.protonTier ?? "platinum",
    coverUrl:
      overrides.coverUrl ?? `https://example.com/${overrides.appId}.jpg`,
    cloud: overrides.cloud ?? { _tag: "Ready" },
    lastPlayedAt: overrides.lastPlayedAt ?? null,
  };
}

describe("parseSearch / toSearch round-trip", () => {
  it("round-trips a fully customized set of filters", () => {
    const f: Filters = {
      status: "ready",
      sort: "name",
      proton: "gold",
      chips: ["never", "10h"],
      q: "portal",
    };
    expect(parseSearch(toSearch(f))).toEqual(f);
  });

  it("defaults produce an empty search object and round-trip", () => {
    expect(toSearch(DEFAULT_FILTERS)).toEqual({});
    expect(parseSearch({})).toEqual(DEFAULT_FILTERS);
  });
});

describe("parseSearch defaults on garbage input", () => {
  it("falls back to DEFAULT_FILTERS for unknown status/sort", () => {
    expect(parseSearch({ status: "garbage", sort: 42 })).toEqual(
      DEFAULT_FILTERS,
    );
  });

  it("falls back for an unknown proton tier", () => {
    expect(parseSearch({ proton: "nonsense" }).proton).toBe("any");
  });

  it("truncates q to 100 characters", () => {
    const long = "a".repeat(150);
    expect(parseSearch({ q: long }).q).toBe("a".repeat(100));
  });

  it("parses chips from a comma-separated string, dropping unknown tokens", () => {
    expect(parseSearch({ chips: "never,10h,bogus" }).chips).toEqual([
      "never",
      "10h",
    ]);
  });
});

describe("applyFilters sections and order", () => {
  const ready1 = entry({
    appId: 1,
    name: "Alpha",
    cloud: { _tag: "Ready" },
    playtimeMinutes: 100,
  });
  const ready2 = entry({
    appId: 2,
    name: "Beta",
    cloud: { _tag: "Ready" },
    playtimeMinutes: 200,
  });
  const installing = entry({
    appId: 3,
    name: "Gamma",
    cloud: { _tag: "Installing", percent: 40 },
  });
  const missing = entry({
    appId: 4,
    name: "Delta",
    cloud: { _tag: "Missing" },
  });

  it("groups into ready then installing (installing before missing); empty sections omitted", () => {
    const result = applyFilters(
      [ready1, ready2, installing, missing],
      DEFAULT_FILTERS,
      { steamProfile: true },
    );
    expect(result.map((g) => g.section)).toEqual(["ready", "installing"]);
    expect(result[1]?.entries.map((e) => e.appId)).toEqual([3, 4]);
  });

  it("puts everything into noprofile when steamProfile is false", () => {
    const a = entry({ appId: 5, name: "Epsilon" });
    const b = entry({ appId: 6, name: "Zeta" });
    const result = applyFilters([a, b], DEFAULT_FILTERS, {
      steamProfile: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.section).toBe("noprofile");
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([5, 6]);
  });

  it("status filter keeps only the requested section", () => {
    const result = applyFilters(
      [ready1, ready2, installing, missing],
      { ...DEFAULT_FILTERS, status: "installing" },
      { steamProfile: true },
    );
    expect(result.map((g) => g.section)).toEqual(["installing"]);
  });
});

describe("applyFilters sorting", () => {
  const a = entry({
    appId: 1,
    name: "Яблоко",
    playtimeMinutes: 10,
    lastPlayedAt: "2026-10-01T00:00:00.000Z",
  });
  const b = entry({
    appId: 2,
    name: "Берёза",
    playtimeMinutes: 900,
    lastPlayedAt: "2026-10-20T00:00:00.000Z",
  });
  const c = entry({
    appId: 3,
    name: "Вишня",
    playtimeMinutes: 500,
    lastPlayedAt: null,
  });

  it("recent: newest lastPlayedAt first, null last", () => {
    const result = applyFilters([a, b, c], DEFAULT_FILTERS, {
      steamProfile: true,
    });
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([2, 1, 3]);
  });

  it("name: localeCompare('ru') order", () => {
    const result = applyFilters(
      [a, b, c],
      { ...DEFAULT_FILTERS, sort: "name" },
      { steamProfile: true },
    );
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([2, 3, 1]);
  });

  it("playtime: descending, name tiebreak", () => {
    const result = applyFilters(
      [a, b, c],
      { ...DEFAULT_FILTERS, sort: "playtime" },
      { steamProfile: true },
    );
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([2, 3, 1]);
  });

  it("recent ties break on playtime desc, then name", () => {
    const sameDate = "2026-10-20T00:00:00.000Z";
    const x = entry({
      appId: 10,
      name: "Зебра",
      playtimeMinutes: 50,
      lastPlayedAt: sameDate,
    });
    const y = entry({
      appId: 11,
      name: "Антилопа",
      playtimeMinutes: 50,
      lastPlayedAt: sameDate,
    });
    const result = applyFilters([x, y], DEFAULT_FILTERS, {
      steamProfile: true,
    });
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([11, 10]);
  });
});

describe("applyFilters chips", () => {
  const never = entry({ appId: 1, name: "Never", playtimeMinutes: 0 });
  const some = entry({ appId: 2, name: "Some", playtimeMinutes: 300 });
  const tenHours = entry({ appId: 3, name: "Ten", playtimeMinutes: 600 });

  it("never: playtimeMinutes === 0", () => {
    const result = applyFilters(
      [never, some, tenHours],
      { ...DEFAULT_FILTERS, chips: ["never"] },
      { steamProfile: true },
    );
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([1]);
  });

  it("10h: playtimeMinutes >= 600", () => {
    const result = applyFilters(
      [never, some, tenHours],
      { ...DEFAULT_FILTERS, chips: ["10h"] },
      { steamProfile: true },
    );
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([3]);
  });
});

describe("applyFilters search and proton", () => {
  const portal = entry({ appId: 1, name: "Portal 2" });
  const halflife = entry({ appId: 2, name: "Half-Life 2" });

  it("search is case-insensitive and matches a substring of the name", () => {
    const result = applyFilters(
      [portal, halflife],
      { ...DEFAULT_FILTERS, q: "PORTAL" },
      { steamProfile: true },
    );
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([1]);
  });

  it("proton filter keeps only the matching tier", () => {
    const gold = entry({ appId: 3, name: "Gold game", protonTier: "gold" });
    const silver = entry({
      appId: 4,
      name: "Silver game",
      protonTier: "silver",
    });
    const result = applyFilters(
      [gold, silver],
      { ...DEFAULT_FILTERS, proton: "gold" },
      { steamProfile: true },
    );
    expect(result[0]?.entries.map((e) => e.appId)).toEqual([3]);
  });
});

describe("countMatching", () => {
  it("counts entries across all sections that pass the filters", () => {
    const ready1 = entry({ appId: 1, name: "Alpha", cloud: { _tag: "Ready" } });
    const installing = entry({
      appId: 2,
      name: "Beta",
      cloud: { _tag: "Installing", percent: null },
    });
    const missing = entry({
      appId: 3,
      name: "Gamma",
      cloud: { _tag: "Missing" },
    });
    expect(
      countMatching([ready1, installing, missing], DEFAULT_FILTERS, {
        steamProfile: true,
      }),
    ).toBe(3);
  });

  it("respects search and status filters like applyFilters", () => {
    const ready1 = entry({ appId: 1, name: "Alpha", cloud: { _tag: "Ready" } });
    const missing = entry({
      appId: 2,
      name: "Beta",
      cloud: { _tag: "Missing" },
    });
    expect(
      countMatching(
        [ready1, missing],
        { ...DEFAULT_FILTERS, status: "ready" },
        { steamProfile: true },
      ),
    ).toBe(1);
  });
});

describe("applyFilters performance", () => {
  it("filters 2000 entries with a search query in under 50ms", () => {
    const entries: LibraryEntry[] = Array.from({ length: 2000 }, (_, i) =>
      entry({
        appId: i,
        name: `Game ${i}`,
        playtimeMinutes: i % 1000,
        cloud:
          i % 3 === 0
            ? { _tag: "Ready" }
            : i % 3 === 1
              ? { _tag: "Installing", percent: i % 100 }
              : { _tag: "Missing" },
        lastPlayedAt:
          i % 2 === 0
            ? `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`
            : null,
      }),
    );
    const start = performance.now();
    applyFilters(
      entries,
      { ...DEFAULT_FILTERS, q: "a" },
      {
        steamProfile: true,
      },
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe("activeFilterCount", () => {
  it("умолчания — 0, поиск не считается", () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, q: "zelda" })).toBe(0);
  });

  it("статус, сортировка, Proton и каждый чип считаются по одному", () => {
    expect(
      activeFilterCount({
        status: "ready",
        sort: "name",
        proton: "gold",
        chips: ["never", "10h"],
        q: "",
      }),
    ).toBe(5);
  });
});

describe("own games (free)", () => {
  const own = (appId: number, name: string) =>
    entry({
      appId,
      name,
      protonTier: "pending",
      coverUrl: `/own-games/${appId}/cover.jpg`,
    });

  it("free status keeps only own games and URL round-trips status=free", () => {
    const filters: Filters = { ...DEFAULT_FILTERS, status: "free" };
    expect(toSearch(filters)).toEqual({ status: "free" });
    expect(parseSearch({ status: "free" })).toEqual(filters);

    const entries = [
      entry({ appId: 620, name: "Portal 2" }),
      entry({ appId: 570, name: "Dota 2", cloud: { _tag: "Missing" } }),
      own(1900000001, "Ocarina of Time"),
    ];
    // Разделы — как при «все»: своя игра — в «готовы».
    expect(applyFilters(entries, filters, { steamProfile: true })).toEqual([
      { section: "ready", entries: [own(1900000001, "Ocarina of Time")] },
    ]);
    expect(countMatching(entries, filters, { steamProfile: true })).toBe(1);
    // Поиск сочетается с «бесплатно».
    expect(
      countMatching(
        entries,
        { ...filters, q: "portal" },
        { steamProfile: true },
      ),
    ).toBe(0);
  });

  it("own game is ready even without Steam profile", () => {
    const entries = [
      entry({ appId: 620, name: "Portal 2" }),
      own(1900000001, "Ocarina of Time"),
    ];
    expect(
      applyFilters(entries, DEFAULT_FILTERS, { steamProfile: false }),
    ).toEqual([
      { section: "ready", entries: [own(1900000001, "Ocarina of Time")] },
      {
        section: "noprofile",
        entries: [entry({ appId: 620, name: "Portal 2" })],
      },
    ]);
  });
});
