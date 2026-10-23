// Блок «Запускал недавно» на главной `/app` (спека §4.2): до трёх последних игр с
// отличающимся `appId`, карточка — обложка слева, дата и длительность последней сессии
// моно-шрифтом, название, строка статуса и «Играть». Не реагирует на фильтры — скрывать
// его при непустом поиске решает родитель (`MyGamesPage`). На телефоне — горизонтальная
// прокрутка, на планшете/десктопе — сетка в 2/3 колонки.
import type { RecentEntry } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import { LoaderCircle, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GameCover } from "@/components/app/GameCover";
import { cardAction, type LibraryPlay } from "@/lib/cardAction";
import { formatMinutes, formatRelativeDate } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

/** Упрощённая строка статуса (§4.3) — без времени в игре, оно тут не нужно. */
function statusLabel(cloud: RecentEntry["cloud"]): string {
  switch (cloud._tag) {
    case "Ready":
      return "Готова";
    case "Installing":
      return cloud.percent === null
        ? "качается"
        : `качается · ${cloud.percent} %`;
    case "Missing":
      return "нужна установка";
  }
}

function statusDotClassName(cloud: RecentEntry["cloud"]): string {
  return cloud._tag === "Ready" ? "bg-[#3ddc97]" : "bg-[#ffd166]";
}

function RecentCard({ game, play }: { game: RecentEntry; play: LibraryPlay }) {
  const action = cardAction(game, play);
  return (
    <article className="grid w-[260px] shrink-0 grid-cols-[118px_1fr] gap-3 rounded-[18px] bg-[#13161d] p-2.5 sm:w-auto sm:shrink">
      <div className="relative aspect-[460/215] overflow-hidden rounded-[10px] bg-[#1a1d26]">
        <GameCover game={game} showNameInPlaceholder={false} />
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-0.5">
        <span className="truncate font-mono text-[10px] tracking-wide text-[#8a90a8] uppercase">
          {formatRelativeDate(game.lastPlayedAt, new Date())} ·{" "}
          {formatMinutes(game.lastDurationMinutes)}
        </span>
        <h3
          className="truncate text-[15px] font-semibold text-[#eef1ff]"
          title={game.name}
        >
          {game.name}
        </h3>
        <span className="mb-1.5 flex items-center gap-1.5 text-xs text-[#8a90a8]">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-sm",
              statusDotClassName(game.cloud),
            )}
          />
          {statusLabel(game.cloud)}
        </span>
        {action.kind !== "blocked" && (
          <Button
            size="sm"
            className="w-fit"
            disabled={
              action.kind === "play" && (action.pending || action.disabled)
            }
            onClick={action.kind === "play" ? action.onPlay : action.onResume}
          >
            {action.kind === "play" && action.pending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Play />
            )}
            {action.kind === "resume" ? "Вернуться в игру" : "Играть"}
          </Button>
        )}
      </div>
    </article>
  );
}

export function RecentRow({
  items,
  play,
}: {
  items: ReadonlyArray<RecentEntry>;
  play: LibraryPlay;
}) {
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-3.5">
      <h2 className="flex items-center gap-2 text-xl font-bold text-[#eef1ff]">
        Запускал недавно
        <span aria-hidden className="h-px flex-1 bg-white/10" />
        <Link
          to="/app/time"
          className="text-sm font-medium text-[#8a90a8] hover:text-[#eef1ff]"
        >
          все сессии →
        </Link>
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-3">
        {items.map((game) => (
          <RecentCard key={game.appId} game={game} play={play} />
        ))}
      </div>
    </section>
  );
}
