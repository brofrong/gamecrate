// Общие атомы для панелей правой колонки `/app` (`SteamPanel`, `TimePanel`,
// `ActiveSessionPanel`, `InstallsPanel`, `ComingSoonPanel`): карточка-контейнер,
// заголовок с иконкой-кружком и плашкой справа, и ячейка числа/подписи («игр»/«готовы»
// и т.д., прототип `docs/brand/prototypes/app-home.html`).
import type * as React from "react";
import { cn } from "@/lib/utils";

/** Карточка панели: `rounded-[20px] bg-[#13161d] p-[18px]`, колонка с зазором. */
export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-[20px] bg-[#13161d] p-[18px]",
        className,
      )}
    >
      {children}
    </section>
  );
}

/**
 * Заголовок панели: кружок-иконка (lucide-иконка или текст-инициалы), название,
 * необязательная плашка справа (готовый `<span>`, бейдж «Скоро» или кнопка).
 */
export function PanelHeader({
  icon,
  title,
  pill,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  pill?: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "flex items-center gap-2.5 text-[17px] font-bold text-[#eef1ff]",
        className,
      )}
    >
      <span
        aria-hidden
        className="flex size-[30px] items-center justify-center rounded-full bg-[#2a2e3a] font-mono text-[10px] font-bold"
      >
        {icon}
      </span>
      {title}
      {pill !== undefined && (
        <span className="ml-auto flex items-center">{pill}</span>
      )}
    </h2>
  );
}

/** Число с подписью сверху (строка статистики `SteamPanel`: «игр»/«готовы»/«синхр.»). */
export function Stat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-[#8a90a8]">{label}</span>
      <span className="text-lg font-bold text-[#eef1ff]">{value}</span>
    </div>
  );
}
