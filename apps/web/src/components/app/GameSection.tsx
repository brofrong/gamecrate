// Секция сетки карточек на главной `/app`: заголовок с количеством и линией
// до конца строки (как в прототипе `docs/brand/prototypes/app-home.html`),
// под ним сетка карточек — по 4 в ряд на десктопе, 3 на планшете, 2 на телефоне.
import type * as React from "react";

export function GameSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3.5">
      <h2 className="flex items-center gap-2 text-xl font-bold text-[#eef1ff]">
        {title}
        <small className="text-sm font-medium text-[#8a90a8]">({count})</small>
        <span aria-hidden className="h-px flex-1 bg-white/10" />
      </h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {children}
      </div>
    </section>
  );
}
