// Секция сетки карточек на `/app` (спека 2026-10-27 §3.3–3.4): заголовок с количеством
// и линией до конца строки, опциональное действие справа («все сессии →»), под ним
// сетка 2/3/4/5 плиток в ряд. С `limit` показывает первые `limit` детей и кнопку
// «Показать ещё N · осталось M»; сброс раскрытия — через `key` у родителя (смена
// фильтров). `scroll` — горизонтальная прокрутка на телефоне («Запускал недавно»).
import { Children, useState } from "react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Сколько плиток секция показывает до первого «Показать ещё» (6 рядов по 4). */
export const SECTION_PAGE = 24;

export function GameSection({
  title,
  count,
  limit,
  scroll = false,
  action,
  children,
}: {
  title: string;
  count: number;
  limit?: number;
  scroll?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [shown, setShown] = useState(limit ?? Number.POSITIVE_INFINITY);
  const all = Children.toArray(children);
  const visible = all.slice(0, shown);
  const rest = all.length - visible.length;
  const step = Math.min(limit ?? 0, rest);

  return (
    <section className="flex flex-col gap-3.5">
      <h2 className="flex items-center gap-2 text-xl font-bold text-[#eef1ff]">
        {title}
        <small className="text-sm font-medium text-[#8a90a8]">({count})</small>
        <span aria-hidden className="h-px flex-1 bg-white/10" />
        {action}
      </h2>
      <div
        className={cn(
          "gap-3 sm:grid sm:grid-cols-3 lg:grid-cols-4 min-[1440px]:grid-cols-5",
          scroll
            ? "flex overflow-x-auto pb-1 [&>*]:min-w-[220px] sm:overflow-visible sm:[&>*]:min-w-0"
            : "grid grid-cols-2",
        )}
      >
        {visible}
      </div>
      {rest > 0 && (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          onClick={() => setShown((n) => n + step)}
        >
          Показать ещё {step} · осталось {rest}
        </Button>
      )}
    </section>
  );
}
