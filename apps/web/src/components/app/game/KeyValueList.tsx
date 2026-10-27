// Таблица «ключ — значение» для панелей страницы игры (совместимость, факты, сессии).
import type * as React from "react";
import { cn } from "@/lib/utils";

export type KeyValueRow = {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly className?: string | undefined;
};

export function KeyValueList({
  rows,
  mono = false,
}: {
  rows: ReadonlyArray<KeyValueRow>;
  /** Моно-шрифт значений (список сессий). */
  mono?: boolean;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-1.5 text-sm",
        mono && "font-mono text-xs",
      )}
    >
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`} className="contents">
          <dt className="text-[#8a90a8]">{row.label}</dt>
          <dd className={cn("min-w-0 text-[#eef1ff]", row.className)}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
