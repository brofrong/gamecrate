// Панель «Мои сессии» на странице игры (спека 2026-10-27 §3.5): до 10 последних
// сессий пользователя в этой игре (дата · длительность, моно-шрифт), ссылка
// «все сессии →» на `/app/time`; пусто — одна строка-подсказка.
import type { GameView } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";
import { Panel, PanelHeader } from "@/components/app/Panel";
import { KeyValueList } from "@/components/app/game/KeyValueList";
import { formatMinutes, formatRelativeDate } from "@/lib/formatTime";

export function SessionsPanel({ game, now }: { game: GameView; now: Date }) {
  return (
    <Panel>
      <PanelHeader
        icon={<History className="size-4" />}
        title="Мои сессии"
        pill={
          <Link
            to="/app/time"
            className="text-sm font-medium text-[#8a90a8] hover:text-[#eef1ff]"
          >
            все сессии →
          </Link>
        }
      />
      {game.sessions.length === 0 ? (
        <p className="text-sm text-[#8a90a8]">
          Ты ещё не запускал эту игру в облаке
        </p>
      ) : (
        <KeyValueList
          mono
          rows={game.sessions.map((session) => ({
            label: formatRelativeDate(session.startedAt, now),
            value: formatMinutes(session.minutes),
          }))}
        />
      )}
    </Panel>
  );
}
