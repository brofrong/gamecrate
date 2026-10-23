// Строка фильтров на десктопе/планшете `/app` (см. прототип `app-home.html`):
// три `<select>` (Статус/Сортировка/Proton), переход к привязке аккаунта, поиск
// с debounce 150 мс и горячей клавишей ⌘K/Ctrl+K, вторая строка — чипы быстрых
// фильтров. Контролируемый компонент: не знает про URL — адрес хранит родитель
// (`MyGamesPage`, Task 10).
import { Link } from "@tanstack/react-router";
import { CirclePlus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type Chip,
  DEFAULT_FILTERS,
  type Filters,
  type ProtonFilter,
  type SortKey,
  type StatusFilter,
} from "@/lib/libraryFilters";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "все" },
  { value: "ready", label: "готовы" },
  { value: "installing", label: "нужна установка" },
  { value: "noprofile", label: "нужен вход в Steam" },
];

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "recent", label: "недавние" },
  { value: "name", label: "по названию" },
  { value: "playtime", label: "по времени в игре" },
];

const PROTON_OPTIONS: ReadonlyArray<{ value: ProtonFilter; label: string }> = [
  { value: "any", label: "любой" },
  { value: "platinum", label: "platinum" },
  { value: "gold", label: "gold" },
  { value: "silver", label: "silver" },
  { value: "bronze", label: "bronze" },
  { value: "borked", label: "borked" },
  { value: "pending", label: "неизвестно" },
];

const STATUS_CHIPS: ReadonlyArray<{
  value: StatusFilter;
  label: string;
  dot: string;
}> = [
  { value: "ready", label: "Готовы к запуску", dot: "bg-[#3ddc97]" },
  { value: "installing", label: "Нужна установка", dot: "bg-[#ffd166]" },
  { value: "noprofile", label: "Нужен вход в Steam", dot: "bg-[#8a90a8]" },
];

const EXTRA_CHIPS: ReadonlyArray<{ value: Chip; label: string }> = [
  { value: "never", label: "Не запускались" },
  { value: "10h", label: "Больше 10 ч в игре" },
];

/** Сравнение фильтров целиком (включая порядок `chips`) — для видимости «Сбросить». */
function filtersEqual(a: Filters, b: Filters): boolean {
  return (
    a.status === b.status &&
    a.sort === b.sort &&
    a.proton === b.proton &&
    a.q === b.q &&
    a.chips.length === b.chips.length &&
    a.chips.every((chip, i) => chip === b.chips[i])
  );
}

const selectClassName =
  "h-9 rounded-full border-none bg-[#13161d] px-3 text-sm font-medium text-[#cfd3e6] outline-none";

const chipClassName =
  "flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-full bg-[#13161d] px-3 text-xs font-medium text-[#cfd3e6] transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const chipActiveClassName =
  "bg-[#3cc2ff]/14 text-[#eef1ff] shadow-[inset_0_0_0_1px_rgba(60,194,255,.45)]";

export function FilterBar({
  filters,
  onChange,
  total,
  focusSearch,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  total: number;
  focusSearch?: boolean;
}) {
  const [query, setQuery] = useState(filters.q);
  const searchRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Внешний сброс/изменение `filters.q` (например, кнопкой «Сбросить») должен
  // отразиться в поле — компонент контролируемый.
  useEffect(() => {
    setQuery(filters.q);
  }, [filters.q]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleSearchChange(value: string) {
    setQuery(value);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChange({ ...filters, q: value });
    }, 150);
  }

  function toggleStatusChip(value: StatusFilter) {
    onChange({ ...filters, status: filters.status === value ? "all" : value });
  }

  function toggleChip(chip: Chip) {
    const has = filters.chips.includes(chip);
    onChange({
      ...filters,
      chips: has
        ? filters.chips.filter((c) => c !== chip)
        : [...filters.chips, chip],
    });
  }

  const isDefault = filtersEqual(filters, DEFAULT_FILTERS);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <select
          aria-label="Статус"
          className={selectClassName}
          value={filters.status}
          onChange={(e) =>
            onChange({ ...filters, status: e.target.value as StatusFilter })
          }
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Сортировка"
          className={selectClassName}
          value={filters.sort}
          onChange={(e) =>
            onChange({ ...filters, sort: e.target.value as SortKey })
          }
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Proton"
          className={selectClassName}
          value={filters.proton}
          onChange={(e) =>
            onChange({ ...filters, proton: e.target.value as ProtonFilter })
          }
        >
          {PROTON_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span aria-hidden className="h-6 w-px bg-white/10" />
        <Link
          to="/profile"
          className="flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-[#cfd3e6] hover:bg-white/5"
        >
          <CirclePlus aria-hidden className="size-4" />
          Привязать аккаунт
        </Link>
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTERS)}
            className="h-9 rounded-full px-3 text-sm font-medium text-[#8a90a8] hover:text-[#eef1ff]"
          >
            Сбросить
          </button>
        )}
        <div className="relative ml-auto flex h-9 w-[220px] items-center gap-2 rounded-full bg-[#13161d] px-3">
          <Search aria-hidden className="size-4 text-[#8a90a8]" />
          <input
            ref={searchRef}
            aria-label="Найти игру"
            autoFocus={focusSearch}
            placeholder={`Найти среди ${total} игр`}
            value={query}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full bg-transparent text-sm text-[#eef1ff] outline-none placeholder:text-[#8a90a8]"
          />
          <span aria-hidden className="font-mono text-[10px] text-[#8a90a8]">
            ⌘K
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_CHIPS.map((chip) => {
          const active = filters.status === chip.value;
          return (
            <button
              key={chip.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggleStatusChip(chip.value)}
              className={cn(chipClassName, active && chipActiveClassName)}
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-sm", chip.dot)}
              />
              {chip.label}
            </button>
          );
        })}
        {EXTRA_CHIPS.map((chip) => {
          const active = filters.chips.includes(chip.value);
          return (
            <button
              key={chip.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggleChip(chip.value)}
              className={cn(chipClassName, active && chipActiveClassName)}
            >
              {chip.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={false}
          disabled
          title="Скоро"
          className={chipClassName}
        >
          Из ящика
        </button>
      </div>
    </div>
  );
}
