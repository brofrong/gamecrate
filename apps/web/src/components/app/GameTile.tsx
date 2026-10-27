// Карточка игры на `/app` (спека 2026-10-27 §3.3, правка владельца от 2026-10-27):
// вся плитка — ссылка на страницу игры. Обложка 460×215 с полосой установки по нижнему
// краю; под обложкой строка: слева название (одна строка, многоточие), справа одно
// короткое значение (`tileValue` или `caption` секции). Кнопок и тега ProtonDB на плитке
// нет — «Играть»/«Установить» и совместимость живут только на странице игры.
// Общий тип `TileGame` покрывает `LibraryEntry`, `RecentEntry` и `TrendingEntry`.
import type { CloudStatus } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import { GameCover } from "@/components/app/GameCover";
import { type TileTone, tileValue } from "@/lib/tileValue";
import { cn } from "@/lib/utils";

export type TileGame = {
  readonly appId: number;
  readonly name: string;
  readonly coverUrl: string;
  readonly cloud: CloudStatus;
  readonly playtimeMinutes?: number;
};

const toneClassName: Record<TileTone, string> = {
  muted: "text-[#aab0c6]",
  ok: "text-[#3ddc97]",
  warn: "text-[#ffd166]",
};

export function GameTile({
  game,
  dimmed = false,
  caption,
}: {
  game: TileGame;
  dimmed?: boolean;
  /** Подпись секции («вчера · 1 ч 20 м», «12 играют») — заменяет значение статуса. */
  caption?: string;
}) {
  const value =
    caption === undefined
      ? tileValue(game, dimmed)
      : { text: caption, tone: "muted" as const, percent: null };

  return (
    <Link
      to="/app/game/$appId"
      params={{ appId: game.appId }}
      aria-label={`Игра: ${game.name}`}
      className="group flex flex-col gap-2 rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-[#3cc2ff]"
    >
      <article className="relative aspect-[460/215] overflow-hidden rounded-[14px] bg-[#1a1d26] ring-1 ring-white/5 transition group-hover:ring-white/20">
        <GameCover game={game} dimmed={dimmed} />
        {value.percent !== null && (
          <span
            data-testid="install-bar"
            aria-hidden
            className="absolute bottom-0 left-0 h-[3px] bg-[#ffd166]"
            style={{ width: `${value.percent}%` }}
          />
        )}
      </article>
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <h3
          className="min-w-0 truncate text-[13px] font-semibold text-[#eef1ff] transition group-hover:text-white"
          title={game.name}
        >
          {game.name}
        </h3>
        {value.text !== "" && (
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              toneClassName[value.tone],
            )}
          >
            {value.text}
          </span>
        )}
      </div>
    </Link>
  );
}
