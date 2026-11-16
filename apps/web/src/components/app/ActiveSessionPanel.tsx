// Карточка активной сессии: панель в правой колонке на десктопе/планшете и
// (с `compact`) закреплённая карточка над нижней панелью на телефоне (`StickySlot`,
// прототип `docs/brand/prototypes/app-home-mobile.html`). Ничего не рендерит для
// терминальных состояний (`ended`/`failed`) — на деле `session.active` их и не
// возвращает, но компонент проверяет сам, чтобы не зависеть от инварианта вызывающего.
import { isTerminalSessionState, type SessionView } from "@cg/rpc";
import { Gamepad2 } from "lucide-react";
import { GameCover, headerUrl } from "@/components/app/GameCover";
import { Panel, PanelHeader } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";

/** Русская подпись состояния сессии (спека §4.4). */
function stateLabel(session: SessionView): string {
  switch (session.state) {
    case "playing":
      return "играет";
    case "installing":
      return session.installPercent === null
        ? "устанавливается"
        : `устанавливается ${session.installPercent} %`;
    case "starting":
      return "запускается";
    case "queued":
      return "в очереди";
    case "idle_warning":
    case "disconnected":
      return "пауза";
    case "stopping":
      return "останавливается";
    case "ended":
    case "failed":
      return "";
  }
}

export function ActiveSessionPanel({
  session,
  onResume,
  compact = false,
}: {
  session: SessionView;
  onResume: () => void;
  /** Закреплённая карточка над нижней панелью на телефоне — компактнее и без заголовка. */
  compact?: boolean;
}) {
  if (isTerminalSessionState(session.state)) return null;

  const label = stateLabel(session);
  const cover = {
    appId: session.appId,
    name: session.gameName,
    coverUrl: headerUrl(session.appId),
  };

  if (compact) {
    return (
      <div className="mx-3 mb-2 flex items-center gap-2.5 rounded-2xl border border-brand-accent/30 bg-[#13161d] p-2">
        <div className="aspect-[460/215] w-[58px] shrink-0 overflow-hidden rounded-[8px] bg-[#1a1d26]">
          <GameCover game={cover} showNameInPlaceholder={false} />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-semibold text-[#eef1ff]">
            {session.gameName}
          </span>
          <span className="truncate text-[11px] text-[#3ddc97]">
            {`● ${label}`}
          </span>
        </div>
        <Button type="button" size="sm" className="ml-auto" onClick={onResume}>
          Вернуться
        </Button>
      </div>
    );
  }

  return (
    <Panel>
      <PanelHeader icon={<Gamepad2 className="size-4" />} title="Сессия" />
      <div className="aspect-[460/215] overflow-hidden rounded-[12px] bg-[#1a1d26]">
        <GameCover game={cover} showNameInPlaceholder={false} />
      </div>
      <div className="flex flex-col">
        <span className="font-semibold text-[#eef1ff]">{session.gameName}</span>
        <span className="text-sm text-[#3ddc97]">{label}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onResume}
      >
        Вернуться в игру
      </Button>
    </Panel>
  );
}
