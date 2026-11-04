// Поиск и фильтры `/app` (правка владельца от 2026-10-27): верхняя строка — поле
// поиска на всю ширину (debounce 150 мс, ⌘K/Ctrl+K) и рядом кнопка «Фильтры» с числом
// активных фильтров; на планшете/десктопе она раскрывает панель под собой (сортировка,
// статус, время в игре, ProtonDB — применяются сразу), на телефоне — зовёт `onOpenSheet`
// (шторку `FilterSheet`). Вторая строка — три чипа: «Готовы к запуску», «Нужна
// установка» и «Играть бесплатно» (только свои игры, `status=free`).
// Контролируемый компонент: не знает про URL — адрес хранит родитель (`MyGamesPage`).
import { Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  activeFilterCount,
  type Chip,
  DEFAULT_FILTERS,
  type Filters,
  type ProtonFilter,
  type SortKey,
  type StatusFilter,
} from "@/lib/libraryFilters";
import { cn } from "@/lib/utils";
import { chipActiveClassName, PROTON_OPTIONS } from "./filterOptions";

/** Ниже этой ширины вместо панели под кнопкой открывается шторка (Tailwind `md`). */
const SHEET_MEDIA_QUERY = "(max-width: 767px)";

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "все" },
  { value: "ready", label: "готовы" },
  { value: "installing", label: "нужна установка" },
  { value: "noprofile", label: "нужен вход в Steam" },
  { value: "free", label: "бесплатно" },
];

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "recent", label: "недавние" },
  { value: "name", label: "по названию" },
  { value: "playtime", label: "по времени в игре" },
];

const PLAYTIME_CHIPS: ReadonlyArray<{ value: Chip; label: string }> = [
  { value: "never", label: "Не запускались" },
  { value: "10h", label: "Больше 10 ч в игре" },
];

const STATUS_CHIPS: ReadonlyArray<{
  value: StatusFilter;
  label: string;
  dot: string;
}> = [
  { value: "ready", label: "Готовы к запуску", dot: "bg-[#3ddc97]" },
  { value: "installing", label: "Нужна установка", dot: "bg-[#ffd166]" },
  { value: "free", label: "Играть бесплатно", dot: "bg-[#3cc2ff]" },
];

/**
 * Сравнение фильтров целиком (включая порядок `chips`) — для точки на кнопке
 * «Фильтры» на телефоне (`MyGamesPage`).
 */
export function filtersEqual(a: Filters, b: Filters): boolean {
  return (
    a.status === b.status &&
    a.sort === b.sort &&
    a.proton === b.proton &&
    a.q === b.q &&
    a.chips.length === b.chips.length &&
    a.chips.every((chip, i) => chip === b.chips[i])
  );
}

const chipClassName =
  "flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-full bg-[#13161d] px-3 text-xs font-medium text-[#cfd3e6] transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const optionClassName =
  "h-8 rounded-full bg-[#0d0f14] px-3 text-xs font-medium text-[#cfd3e6] transition-colors";

function GroupTitle({ children }: { children: string }) {
  return (
    <h3 className="mb-1.5 text-[11px] font-semibold tracking-wider text-[#8a90a8] uppercase">
      {children}
    </h3>
  );
}

function OptionRow<T extends string>({
  options,
  selected,
  onSelect,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={selected === option.value}
          onClick={() => onSelect(option.value)}
          className={cn(
            optionClassName,
            selected === option.value && chipActiveClassName,
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Панель под кнопкой «Фильтры»: всё применяется сразу через `onChange`. */
function FilterPanel({
  filters,
  onChange,
  onClose,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function onMouseDown(event: MouseEvent) {
      const root = panelRef.current?.parentElement;
      if (root && event.target instanceof Node && !root.contains(event.target))
        onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  function toggleChip(chip: Chip) {
    const has = filters.chips.includes(chip);
    onChange({
      ...filters,
      chips: has
        ? filters.chips.filter((c) => c !== chip)
        : [...filters.chips, chip],
    });
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Фильтры"
      className="absolute top-full right-0 z-40 mt-2 w-[340px] rounded-2xl bg-[#13161d] p-4 shadow-[0_16px_40px_rgba(0,0,0,.5)] ring-1 ring-white/10"
    >
      <GroupTitle>Сортировка</GroupTitle>
      <OptionRow
        options={SORT_OPTIONS}
        selected={filters.sort}
        onSelect={(sort) => onChange({ ...filters, sort })}
      />
      <GroupTitle>Статус</GroupTitle>
      <OptionRow
        options={STATUS_OPTIONS}
        selected={filters.status}
        onSelect={(status) => onChange({ ...filters, status })}
      />
      <GroupTitle>Время в игре</GroupTitle>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PLAYTIME_CHIPS.map((chip) => {
          const active = filters.chips.includes(chip.value);
          return (
            <button
              key={chip.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggleChip(chip.value)}
              className={cn(optionClassName, active && chipActiveClassName)}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
      <GroupTitle>ProtonDB</GroupTitle>
      <OptionRow<ProtonFilter>
        options={PROTON_OPTIONS}
        selected={filters.proton}
        onSelect={(proton) => onChange({ ...filters, proton })}
      />
      <div className="flex items-center justify-between border-t border-white/10 pt-3">
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_FILTERS, q: filters.q })}
          className="text-sm font-medium text-[#8a90a8] hover:text-[#eef1ff]"
        >
          Сбросить
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-semibold text-[#3cc2ff]"
        >
          Готово
        </button>
      </div>
    </div>
  );
}

export function FilterBar({
  filters,
  onChange,
  onOpenSheet,
  total,
  focusSearch,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  /** На телефоне кнопка «Фильтры» открывает шторку вместо панели. */
  onOpenSheet: () => void;
  total: number;
  focusSearch?: boolean;
}) {
  const [query, setQuery] = useState(filters.q);
  const [panelOpen, setPanelOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Внешний сброс/изменение `filters.q` должен отразиться в поле — компонент
  // контролируемый.
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

  function onFiltersClick() {
    if (window.matchMedia(SHEET_MEDIA_QUERY).matches) {
      onOpenSheet();
      return;
    }
    setPanelOpen((open) => !open);
  }

  const activeCount = activeFilterCount(filters);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <div className="relative flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-[#13161d] px-4">
          <Search aria-hidden className="size-4 shrink-0 text-[#8a90a8]" />
          <input
            ref={searchRef}
            aria-label="Найти игру"
            autoFocus={focusSearch}
            placeholder={`Найти среди ${total} игр`}
            value={query}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full min-w-0 bg-transparent text-sm text-[#eef1ff] outline-none placeholder:text-[#8a90a8]"
          />
          <span
            aria-hidden
            className="hidden font-mono text-[10px] text-[#8a90a8] md:inline"
          >
            ⌘K
          </span>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={panelOpen}
            onClick={onFiltersClick}
            className={cn(
              "flex h-10 items-center gap-2 rounded-full bg-[#13161d] px-4 text-sm font-medium text-[#cfd3e6] transition-colors hover:text-[#eef1ff]",
              (panelOpen || activeCount > 0) && chipActiveClassName,
            )}
          >
            <SlidersHorizontal aria-hidden className="size-4" />
            Фильтры
            {activeCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#3cc2ff] px-1.5 text-[11px] font-bold text-[#0d0f14]">
                {activeCount}
              </span>
            )}
          </button>
          {panelOpen && (
            <FilterPanel
              filters={filters}
              onChange={onChange}
              onClose={() => setPanelOpen(false)}
            />
          )}
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
        {activeCount > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_FILTERS, q: filters.q })}
            className="h-[30px] rounded-full px-3 text-xs font-medium text-[#8a90a8] hover:text-[#eef1ff]"
          >
            Сбросить
          </button>
        )}
      </div>
    </div>
  );
}
