// Сетка главной `/app`: полоска (Rail) + контент + правая колонка (aside) на десктопе
// (`xl`: 84px/1fr/330px), без правой колонки в сетке на планшете (aside — под контентом),
// без полоски и с нижней панелью (BottomTabs) и `sticky`-слотом над ней на телефоне.
import type { CurrentUserShape } from "@cg/rpc";
import type * as React from "react";
import { BottomTabs } from "@/components/app/BottomTabs";
import { Rail } from "@/components/app/Rail";

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
}) {
  const { children, aside, sticky } = props;
  return (
    <div className="min-h-dvh bg-[#0d0f14] text-[#eef1ff] md:grid md:grid-cols-[84px_1fr] md:items-start md:gap-6 md:p-6 xl:grid-cols-[84px_1fr_330px]">
      <div className="hidden md:block">
        <Rail installing={false} />
      </div>
      <div className="flex flex-col gap-6 px-4 py-6 pb-28 md:px-0 md:py-0 md:pb-0">
        {children}
      </div>
      {aside !== undefined && (
        <div className="hidden md:col-start-2 md:block xl:col-start-3">
          {aside}
        </div>
      )}
      <div className="fixed inset-x-0 bottom-0 z-40 md:hidden">
        {sticky}
        <BottomTabs />
      </div>
    </div>
  );
}
