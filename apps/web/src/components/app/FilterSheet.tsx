// Шторка фильтров на телефоне `/app` (см. прототип `app-home-mobile.html`):
// затемнение + панель снизу с сегментами «Статус»/«Сортировка», чипами
// Proton/«Ещё» (там же «Бесплатно» — `status: free`, в сегментах статуса ему тесно)
// и кнопкой «Показать N игр». Открывается кнопкой «Фильтры» из `FilterBar`. Шторка владеет своим черновиком —
// он инициализируется из `filters` при каждом открытии (компонент размонтирован,
// когда `open === false`, так что черновик просто создаётся заново из пропсов)
// и применяется только нажатием «Показать N игр» (`onApply` + `onClose`).
// Закрытие по `Escape` или клику по затемнению просто размонтирует шторку —
// черновик отбрасывается, `onApply` не вызывается.
import { useEffect, useState } from "react";
import {
  type Chip,
  DEFAULT_FILTERS,
  type Filters,
  type SortKey,
  type StatusFilter,
} from "@/lib/libraryFilters";
import { cn } from "@/lib/utils";
import { chipActiveClassName, PROTON_OPTIONS } from "./filterOptions";

const STATUS_SEGMENTS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "ready", label: "Готовы" },
  { value: "installing", label: "Установка" },
  { value: "noprofile", label: "Вход" },
];

const SORT_SEGMENTS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "recent", label: "Недавние" },
  { value: "name", label: "Название" },
  { value: "playtime", label: "Время в игре" },
];

const EXTRA_CHIPS: ReadonlyArray<{ value: Chip; label: string }> = [
  { value: "never", label: "Не запускались" },
  { value: "10h", label: "Больше 10 ч" },
];

const segmentClassName =
  "flex-1 rounded-[9px] px-2 py-2 text-xs font-semibold text-[#8a90a8] transition-colors";
const segmentActiveClassName = "bg-[#1a1d26] text-[#eef1ff]";

const chipClassName =
  "flex h-[30px] items-center rounded-full bg-[#0d0f14] px-3 text-xs font-medium text-[#cfd3e6] transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/** Содержимое шторки — отдельный компонент, чтобы `useState(filters)` инициализировал
 * черновик заново при каждом монтировании (т.е. при каждом открытии). */
function FilterSheetContent({
  filters,
  onApply,
  onClose,
  countFor,
}: {
  filters: Filters;
  onApply: (next: Filters) => void;
  onClose: () => void;
  countFor: (f: Filters) => number;
}) {
  const [draft, setDraft] = useState<Filters>(filters);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function toggleChip(chip: Chip) {
    setDraft((prev) => {
      const has = prev.chips.includes(chip);
      return {
        ...prev,
        chips: has
          ? prev.chips.filter((c) => c !== chip)
          : [...prev.chips, chip],
      };
    });
  }

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Закрыть фильтры"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Фильтры"
        className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-[#13161d] p-4 pb-7"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#eef1ff]">Фильтры</h2>
          <button
            type="button"
            onClick={() => setDraft(DEFAULT_FILTERS)}
            className="text-sm font-semibold text-[#3cc2ff]"
          >
            Сбросить
          </button>
        </div>

        <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-[#8a90a8] uppercase">
          Статус
        </h3>
        <div className="mb-3 flex gap-1 rounded-xl bg-[#0d0f14] p-1">
          {STATUS_SEGMENTS.map((segment) => (
            <button
              key={segment.value}
              type="button"
              aria-pressed={draft.status === segment.value}
              onClick={() =>
                setDraft((prev) => ({ ...prev, status: segment.value }))
              }
              className={cn(
                segmentClassName,
                draft.status === segment.value && segmentActiveClassName,
              )}
            >
              {segment.label}
            </button>
          ))}
        </div>

        <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-[#8a90a8] uppercase">
          Сортировка
        </h3>
        <div className="mb-3 flex gap-1 rounded-xl bg-[#0d0f14] p-1">
          {SORT_SEGMENTS.map((segment) => (
            <button
              key={segment.value}
              type="button"
              aria-pressed={draft.sort === segment.value}
              onClick={() =>
                setDraft((prev) => ({ ...prev, sort: segment.value }))
              }
              className={cn(
                segmentClassName,
                draft.sort === segment.value && segmentActiveClassName,
              )}
            >
              {segment.label}
            </button>
          ))}
        </div>

        <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-[#8a90a8] uppercase">
          Proton
        </h3>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {PROTON_OPTIONS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              aria-pressed={draft.proton === chip.value}
              onClick={() =>
                setDraft((prev) => ({ ...prev, proton: chip.value }))
              }
              className={cn(
                chipClassName,
                draft.proton === chip.value && chipActiveClassName,
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-[#8a90a8] uppercase">
          Ещё
        </h3>
        <div className="mb-4 flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={draft.status === "free"}
            onClick={() =>
              setDraft((prev) => ({
                ...prev,
                status: prev.status === "free" ? "all" : "free",
              }))
            }
            className={cn(
              chipClassName,
              draft.status === "free" && chipActiveClassName,
            )}
          >
            Бесплатно
          </button>
          {EXTRA_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              aria-pressed={draft.chips.includes(chip.value)}
              onClick={() => toggleChip(chip.value)}
              className={cn(
                chipClassName,
                draft.chips.includes(chip.value) && chipActiveClassName,
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            onApply(draft);
            onClose();
          }}
          className="h-[46px] w-full rounded-full bg-gradient-to-br from-[#3cc2ff] via-[#3a6cff] to-[#5b2fff] text-sm font-bold text-white"
        >
          Показать {countFor(draft)} игр
        </button>
      </div>
    </div>
  );
}

export function FilterSheet({
  open,
  filters,
  onApply,
  onClose,
  countFor,
}: {
  open: boolean;
  filters: Filters;
  onApply: (next: Filters) => void;
  onClose: () => void;
  countFor: (f: Filters) => number;
}) {
  if (!open) return null;
  return (
    <FilterSheetContent
      filters={filters}
      onApply={onApply}
      onClose={onClose}
      countFor={countFor}
    />
  );
}
