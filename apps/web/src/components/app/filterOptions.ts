// Данные, общие для FilterBar (строка на десктопе) и FilterSheet (шторка на
// телефоне): список тиров ProtonDB с русской подписью «неизвестно» для
// `pending` — одинаковый в `<select>` строки и в чипах шторки — и класс
// активного чипа.
import type { ProtonFilter } from "@/lib/libraryFilters";

export const PROTON_OPTIONS: ReadonlyArray<{
  value: ProtonFilter;
  label: string;
}> = [
  { value: "any", label: "любой" },
  { value: "platinum", label: "platinum" },
  { value: "gold", label: "gold" },
  { value: "silver", label: "silver" },
  { value: "bronze", label: "bronze" },
  { value: "borked", label: "borked" },
  { value: "pending", label: "неизвестно" },
];

export const chipActiveClassName =
  "bg-brand-accent/14 text-[#eef1ff] shadow-[inset_0_0_0_1px_rgb(var(--brand-glow-rgb)/0.45)]";
