// Панель «Установки» в правой колонке `/app`: видна только когда активная сессия
// устанавливается — имя игры, полоса прогресса и процент (прочерк/«…», пока сервер
// его не знает).
import type { SessionView } from "@cg/rpc";
import { Download } from "lucide-react";

export function InstallsPanel({ session }: { session: SessionView }) {
  if (session.state !== "installing") return null;

  const percent = session.installPercent;

  return (
    <section className="flex flex-col gap-3 rounded-[20px] bg-[#13161d] p-[18px]">
      <h2 className="flex items-center gap-2.5 text-[17px] font-bold text-[#eef1ff]">
        <span
          aria-hidden
          className="flex size-[30px] items-center justify-center rounded-full bg-[#2a2e3a]"
        >
          <Download className="size-4" />
        </span>
        Установки
      </h2>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-[#cfd3e6]">
          {session.gameName}
        </span>
        <span className="font-mono text-[#ffd166]">
          {percent === null ? "…" : `${percent} %`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-[#ffd166]"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </section>
  );
}
