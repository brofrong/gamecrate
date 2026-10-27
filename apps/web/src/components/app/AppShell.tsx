// Сетка главной `/app`: полоска (Rail) + контент + правая колонка (aside) на десктопе
// (обе закреплены: полоска — на весь экран, правая колонка — `xl:sticky` с прокруткой
// внутри себя, если панелей больше, чем влезает; на планшете колонка под контентом и
// не закрепляется — спека 2026-10-27 §3.1–3.2)
// (`xl`: 84px/minmax(0,1fr)/330px — `minmax(0,1fr)`, а не просто `1fr`, иначе средняя
// колонка не сжимается ниже min-content содержимого (FilterBar) и сетка вылезает за
// экран на 1280 px), без правой колонки в сетке на планшете (aside — под контентом),
// без полоски и с нижней панелью (BottomTabs) и `sticky`-слотом над ней на телефоне.
//
// Страницы под `/app/*` рендерятся через `Outlet` и не могут передать `aside`/`sticky`
// как пропсы AppShell (их рендерит маршрут-предок `AppLayout`). `AsideSlot`/`StickySlot`
// решают это порталом: `AppShell` держит контейнеры правой колонки и sticky-зоны в
// контексте, а страница (`MyGamesPage` и т.д.) рисует туда содержимое через
// `createPortal`, из любого места в дереве. Пропсы `aside`/`sticky` остаются рабочими
// (используются в `appShell.test.tsx`) — их содержимое просто попадает в те же контейнеры.
// `wide` — без правой колонки вовсе (страница игры: владелец не хотел пустого места
// справа, 2026-10-27); контент занимает всё от полоски до края.
import type { CurrentUserShape } from "@cg/rpc";
import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import type * as React from "react";
import { BottomTabs } from "@/components/app/BottomTabs";
import { Rail } from "@/components/app/Rail";
import { cn } from "@/lib/utils";

type Slots = {
  readonly aside: HTMLDivElement | null;
  readonly sticky: HTMLDivElement | null;
};

const SlotContext = createContext<Slots>({ aside: null, sticky: null });

/** Правая колонка на десктопе/планшете — содержимое собирает страница, не AppShell. */
export function AsideSlot({ children }: { children: React.ReactNode }) {
  const { aside } = useContext(SlotContext);
  if (!aside) return null;
  return createPortal(children, aside);
}

/** Закреплённая карточка над нижней панелью на телефоне. */
export function StickySlot({ children }: { children: React.ReactNode }) {
  const { sticky } = useContext(SlotContext);
  if (!sticky) return null;
  return createPortal(children, sticky);
}

/**
 * `user` идёт в полоску и нижнюю панель (аватар); `AppLayout` передаёт его только после
 * проверки `meAtom`, поэтому сам тип гарантирует, что AppShell не смонтируют для
 * неавторизованного.
 */
export function AppShell(props: {
  user: CurrentUserShape;
  children: React.ReactNode;
  aside?: React.ReactNode;
  sticky?: React.ReactNode;
  wide?: boolean;
}) {
  const { user, children, aside, sticky, wide = false } = props;
  const [asideEl, setAsideEl] = useState<HTMLDivElement | null>(null);
  const [stickyEl, setStickyEl] = useState<HTMLDivElement | null>(null);

  return (
    <SlotContext.Provider value={{ aside: asideEl, sticky: stickyEl }}>
      <div
        className={cn(
          "min-h-dvh bg-[#0d0f14] text-[#eef1ff] md:grid md:grid-cols-[84px_minmax(0,1fr)] md:items-start md:gap-6 md:p-6",
          wide
            ? "xl:grid-cols-[84px_minmax(0,1fr)]"
            : "xl:grid-cols-[84px_minmax(0,1fr)_330px]",
        )}
      >
        <div className="hidden md:sticky md:top-6 md:block">
          <Rail user={user} />
        </div>
        <div className="flex min-w-0 flex-col gap-6 px-4 py-6 pb-28 md:px-0 md:py-0 md:pb-0">
          {children}
        </div>
        {!wide && (
          <div
            ref={setAsideEl}
            className="hidden md:col-start-2 md:flex md:flex-col md:gap-4 xl:sticky xl:top-6 xl:col-start-3 xl:max-h-[calc(100dvh-3rem)] xl:overflow-y-auto"
          >
            {aside}
          </div>
        )}
        <div className="fixed inset-x-0 bottom-0 z-40 md:hidden">
          <div ref={setStickyEl}>{sticky}</div>
          <BottomTabs user={user} />
        </div>
      </div>
    </SlotContext.Provider>
  );
}
