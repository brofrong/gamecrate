// Панель «Установки» в правой колонке `/app`: видна только когда активная сессия
// устанавливается — имя игры, полоса прогресса и процент (прочерк/«…», пока сервер
// его не знает).
import type { SessionView } from "@cg/rpc";
import { Download } from "lucide-react";
import { Panel, PanelHeader } from "@/components/app/Panel";

export function InstallsPanel({ session }: { session: SessionView }) {
  if (session.state !== "installing") return null;

  const percent = session.installPercent;

  return (
    <Panel>
      <PanelHeader icon={<Download className="size-4" />} title="Установки" />
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-[#cfd3e6]">
          {session.gameName}
        </span>
        <span className="font-mono text-[#ffd166]">
          {percent === null ? "…" : `${percent} %`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Установка ${session.gameName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1.5 overflow-hidden rounded-full bg-white/10"
      >
        <div
          className="h-full rounded-full bg-[#ffd166]"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </Panel>
  );
}
