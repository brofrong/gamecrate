// Фильтры библиотеки: состояние ⇄ URL search params (`parseSearch`/`toSearch`) и
// применение фильтров/сортировки/группировки к списку игр (`applyFilters`,
// `countMatching`). Чистая логика без React — используется /app и /library.
import type { LibraryEntry, ProtonTier } from "@cg/rpc";

export type StatusFilter = "all" | "ready" | "installing" | "noprofile";
export type SortKey = "recent" | "name" | "playtime";
export type ProtonFilter = "any" | ProtonTier;
export type Chip = "never" | "10h";

export type Filters = {
  readonly status: StatusFilter;
  readonly sort: SortKey;
  readonly proton: ProtonFilter;
  readonly chips: ReadonlyArray<Chip>;
  readonly q: string;
};

export const DEFAULT_FILTERS: Filters = {
  status: "all",
  sort: "recent",
  proton: "any",
  chips: [],
  q: "",
};

const STATUS_VALUES: ReadonlyArray<StatusFilter> = [
  "all",
  "ready",
  "installing",
  "noprofile",
];
const SORT_VALUES: ReadonlyArray<SortKey> = ["recent", "name", "playtime"];
const PROTON_TIERS: ReadonlyArray<ProtonTier> = [
  "platinum",
  "gold",
  "silver",
  "bronze",
  "borked",
  "pending",
];
const CHIP_VALUES: ReadonlyArray<Chip> = ["never", "10h"];

const Q_MAX_LENGTH = 100;

function isStatusFilter(v: unknown): v is StatusFilter {
  return (
    typeof v === "string" &&
    (STATUS_VALUES as ReadonlyArray<string>).includes(v)
  );
}

function isSortKey(v: unknown): v is SortKey {
  return (
    typeof v === "string" && (SORT_VALUES as ReadonlyArray<string>).includes(v)
  );
}

function isProtonTier(v: unknown): v is ProtonTier {
  return (
    typeof v === "string" &&
    (PROTON_TIERS as ReadonlyArray<string>).includes(v)
  );
}

function isChip(v: string): v is Chip {
  return (CHIP_VALUES as ReadonlyArray<string>).includes(v);
}

/** URL search params → фильтры; неизвестные/некорректные значения → умолчания. */
export function parseSearch(search: Record<string, unknown>): Filters {
  const status = isStatusFilter(search.status)
    ? search.status
    : DEFAULT_FILTERS.status;
  const sort = isSortKey(search.sort) ? search.sort : DEFAULT_FILTERS.sort;
  const proton =
    search.proton === "any" || isProtonTier(search.proton)
      ? (search.proton as ProtonFilter)
      : DEFAULT_FILTERS.proton;
  const chips: ReadonlyArray<Chip> =
    typeof search.chips === "string"
      ? search.chips.split(",").filter(isChip)
      : DEFAULT_FILTERS.chips;
  const q =
    typeof search.q === "string"
      ? search.q.slice(0, Q_MAX_LENGTH)
      : DEFAULT_FILTERS.q;
  return { status, sort, proton, chips, q };
}

/** Фильтры → URL search params; только поля, отличные от умолчаний. */
export function toSearch(filters: Filters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.status !== DEFAULT_FILTERS.status) out.status = filters.status;
  if (filters.sort !== DEFAULT_FILTERS.sort) out.sort = filters.sort;
  if (filters.proton !== DEFAULT_FILTERS.proton) out.proton = filters.proton;
  if (filters.chips.length > 0) out.chips = filters.chips.join(",");
  if (filters.q.length > 0) out.q = filters.q;
  return out;
}

export type Section = "ready" | "installing" | "noprofile";

type SectionGroup = {
  readonly section: Section;
  readonly entries: ReadonlyArray<LibraryEntry>;
};

/** Поиск, тир ProtonDB и чипы — одна игра должна удовлетворять всем активным условиям. */
function matchesFilters(entry: LibraryEntry, filters: Filters): boolean {
  if (filters.proton !== "any" && entry.protonTier !== filters.proton) {
    return false;
  }
  for (const chip of filters.chips) {
    if (chip === "never" && entry.playtimeMinutes !== 0) return false;
    if (chip === "10h" && entry.playtimeMinutes < 600) return false;
  }
  const q = filters.q.trim().toLowerCase();
  if (q.length > 0 && !entry.name.toLowerCase().includes(q)) return false;
  return true;
}

function compareByName(a: LibraryEntry, b: LibraryEntry): number {
  return a.name.localeCompare(b.name, "ru");
}

function compareByPlaytime(a: LibraryEntry, b: LibraryEntry): number {
  return b.playtimeMinutes - a.playtimeMinutes || compareByName(a, b);
}

function compareByRecent(a: LibraryEntry, b: LibraryEntry): number {
  if (a.lastPlayedAt !== b.lastPlayedAt) {
    if (a.lastPlayedAt === null) return 1;
    if (b.lastPlayedAt === null) return -1;
    if (a.lastPlayedAt > b.lastPlayedAt) return -1;
    if (a.lastPlayedAt < b.lastPlayedAt) return 1;
  }
  return compareByPlaytime(a, b);
}

function sortEntries(
  entries: ReadonlyArray<LibraryEntry>,
  sort: SortKey,
): ReadonlyArray<LibraryEntry> {
  const compare =
    sort === "name"
      ? compareByName
      : sort === "playtime"
        ? compareByPlaytime
        : compareByRecent;
  return [...entries].sort(compare);
}

/** Секция карточки: без привязанного Steam-профиля все игры в `noprofile`. */
function sectionFor(entry: LibraryEntry, steamProfile: boolean): Section {
  if (!steamProfile) return "noprofile";
  return entry.cloud._tag === "Ready" ? "ready" : "installing";
}

const SECTION_ORDER: ReadonlyArray<Section> = [
  "ready",
  "installing",
  "noprofile",
];

/**
 * Применяет поиск/тир/чипы, группирует по секциям (`ready`, `installing` — качающиеся
 * игры первыми, затем ещё не установленные, `noprofile`) и сортирует каждую секцию.
 * Пустые секции не возвращаются.
 */
export function applyFilters(
  entries: ReadonlyArray<LibraryEntry>,
  filters: Filters,
  ctx: { steamProfile: boolean },
): ReadonlyArray<SectionGroup> {
  const matched = entries.filter((entry) => matchesFilters(entry, filters));

  const bySection = new Map<Section, LibraryEntry[]>();
  for (const entry of matched) {
    const section = sectionFor(entry, ctx.steamProfile);
    const list = bySection.get(section);
    if (list) {
      list.push(entry);
    } else {
      bySection.set(section, [entry]);
    }
  }

  const result: SectionGroup[] = [];
  for (const section of SECTION_ORDER) {
    if (filters.status !== "all" && filters.status !== section) continue;
    const list = bySection.get(section);
    if (!list || list.length === 0) continue;
    const sorted =
      section === "installing"
        ? [
            ...sortEntries(
              list.filter((entry) => entry.cloud._tag === "Installing"),
              filters.sort,
            ),
            ...sortEntries(
              list.filter((entry) => entry.cloud._tag === "Missing"),
              filters.sort,
            ),
          ]
        : sortEntries(list, filters.sort);
    result.push({ section, entries: sorted });
  }
  return result;
}

/** Сколько игр пройдёт фильтры — для кнопки «Показать N игр». */
export function countMatching(
  entries: ReadonlyArray<LibraryEntry>,
  filters: Filters,
  ctx: { steamProfile: boolean },
): number {
  return applyFilters(entries, filters, ctx).reduce(
    (sum, group) => sum + group.entries.length,
    0,
  );
}
