// Полоска из двух-трёх плиток на телефоне (спека §4.6), замена правой колонки:
// Steam (ведёт на `/profile`; без Steam — ссылка «Подключить Steam» туда же, подключение
// по QR живёт на `/profile`), месяц (ведёт на `/app/time`) и, когда у пользователя идёт
// установка, «Установка · N %». Рисуется, как только загрузился `me` — даже без Steam и
// до того, как подтянулась библиотека (спека §4.6: ссылка на подключение должна быть
// видна сразу), поэтому `view` опционален — счётчики «N игр · M готовы» показываются
// только когда он есть и `_tag === "Ready"`.
import type { CurrentUserShape, LibraryView, SessionView } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { currentMonth, formatMinutes, formatMonth } from "@/lib/formatTime";

function Tile({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-11 flex-1 items-center justify-center rounded-full bg-[#13161d] px-3 text-center text-sm font-medium text-[#cfd3e6]">
      {children}
    </div>
  );
}

export function SummaryStrip({
  user,
  view,
  monthMinutes,
  activeSession,
}: {
  user: CurrentUserShape;
  view: LibraryView | undefined;
  monthMinutes: number;
  activeSession?: SessionView | null;
}) {
  const total = view?._tag === "Ready" ? view.entries.length : 0;
  const ready =
    view?._tag === "Ready"
      ? view.entries.filter((entry) => entry.cloud._tag === "Ready").length
      : 0;
  const month = formatMonth(currentMonth(new Date()));
  const installPercent =
    activeSession?.state === "installing" ? activeSession.installPercent : null;

  return (
    <div className="flex gap-2 md:hidden">
      {user.steamId === null ? (
        <Link to="/profile" className="flex-1">
          <Tile>Подключить Steam</Tile>
        </Link>
      ) : (
        <Link to="/profile" className="flex-1">
          <Tile>
            Steam · {total} игр · {ready} готовы
          </Tile>
        </Link>
      )}
      <Link to="/app/time" className="flex-1">
        <Tile>
          {month} · {formatMinutes(monthMinutes)}
        </Tile>
      </Link>
      {activeSession?.state === "installing" && (
        <Tile>
          Установка{installPercent !== null ? ` · ${installPercent} %` : ""}
        </Tile>
      )}
    </div>
  );
}
