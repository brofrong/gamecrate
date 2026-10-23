// Сетка главной `/app`: полоска (Rail) + контент + правая колонка (aside) на десктопе
// (`xl`: 84px/1fr/330px), без правой колонки в сетке на планшете (aside — под контентом),
// без полоски и с нижней панелью (BottomTabs) и `sticky`-слотом над ней на телефоне.
//
// Страницы под `/app/*` рендерятся через `Outlet` и не могут передать `aside`/`sticky`
// как пропсы AppShell (их рендерит маршрут-предок `AppLayout`). `AsideSlot`/`StickySlot`
// решают это порталом: `AppShell` держит контейнеры правой колонки и sticky-зоны в
// контексте, а страница (`MyGamesPage` и т.д.) рисует туда содержимое через
// `createPortal`, из любого места в дереве. Пропсы `aside`/`sticky` остаются рабочими
// (используются в `appShell.test.tsx`) — их содержимое просто попадает в те же контейнеры.
import type { CurrentUserShape } from "@cg/rpc";
import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import type * as React from "react";
import { BottomTabs } from "@/components/app/BottomTabs";
import { Rail } from "@/components/app/Rail";

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
 * `user` пока не рендерится напрямую (следующие задачи — приветствие/аватар), но
 * обязателен в сигнатуре: `AppLayout` передаёт его только после проверки `meAtom`,
 * поэтому сам тип гарантирует, что AppShell не смонтируют для неавторизованного.
 */
export function AppShell(props: {
  user: CurrentUserShape;
  children: React.ReactNode;
  aside?: React.ReactNode;
  sticky?: React.ReactNode;
  /** Полоска подсвечивает «Установки» (`Rail`), когда активная сессия устанавливается. */
  installing?: boolean;
}) {
  const { children, aside, sticky, installing = false } = props;
  const [asideEl, setAsideEl] = useState<HTMLDivElement | null>(null);
  const [stickyEl, setStickyEl] = useState<HTMLDivElement | null>(null);

  return (
    <SlotContext.Provider value={{ aside: asideEl, sticky: stickyEl }}>
      <div className="min-h-dvh bg-[#0d0f14] text-[#eef1ff] md:grid md:grid-cols-[84px_1fr] md:items-start md:gap-6 md:p-6 xl:grid-cols-[84px_1fr_330px]">
        <div className="hidden md:block">
          <Rail installing={installing} />
        </div>
        <div className="flex flex-col gap-6 px-4 py-6 pb-28 md:px-0 md:py-0 md:pb-0">
          {children}
        </div>
        <div
          ref={setAsideEl}
          className="hidden md:col-start-2 md:flex md:flex-col md:gap-4 xl:col-start-3"
        >
          {aside}
        </div>
        <div className="fixed inset-x-0 bottom-0 z-40 md:hidden">
          <div ref={setStickyEl}>{sticky}</div>
          <BottomTabs />
        </div>
      </div>
    </SlotContext.Provider>
  );
}
