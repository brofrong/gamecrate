// Панель «Время» в правой колонке `/app`: плашка с текущим месяцем, итог за месяц
// и три самые долгие игры (`H:MM`), ссылка «подробнее» на `/app/time` (там же —
// полная история месяцев, Task 12). Пусто (ещё не играл) — одна строка вместо цифр.
import type { TimeSummary } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { Panel, PanelHeader } from "@/components/app/Panel";
import { currentMonth, formatMinutes, formatMonth } from "@/lib/formatTime";

/** «7:40» — часы без паддинга, минуты всегда двузначные. */
function formatHM(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}:${String(rest).padStart(2, "0")}`;
}

export function TimePanel({ summary }: { summary: TimeSummary | undefined }) {
  const month = summary?.month ?? currentMonth(new Date());
  const empty = summary === undefined || summary.totalMinutes <= 0;

  return (
    <Panel>
      <PanelHeader
        icon={<Clock className="size-4" />}
        title="Время"
        pill={
          <span className="rounded-xl bg-[#3cc2ff]/10 px-2.5 py-1 text-xs font-medium text-[#3cc2ff]">
            {formatMonth(month).split(" ")[0]}
          </span>
        }
      />

      {empty ? (
        <p className="text-sm text-[#8a90a8]">Ты ещё не играл в этом месяце</p>
      ) : (
        <>
          <p className="text-2xl font-bold text-[#eef1ff]">
            {formatMinutes(summary.totalMinutes)}
          </p>
          <div className="flex flex-col gap-1.5">
            {summary.byGame.slice(0, 3).map((game) => (
              <div
                key={game.appId}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 truncate text-[#cfd3e6]">
                  {game.name}
                </span>
                <span className="font-mono text-[#8a90a8]">
                  {formatHM(game.minutes)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <Link
        to="/app/time"
        className="text-sm font-medium text-[#8a90a8] hover:text-[#eef1ff]"
      >
        подробнее →
      </Link>
    </Panel>
  );
}
