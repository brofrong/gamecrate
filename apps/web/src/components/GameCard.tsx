// Карточка игры: вертикальная обложка 600×900, название, плашка ProtonDB, время в Steam, «Играть».
import type { LibraryEntry } from "@cg/rpc";
import { Clock, Gamepad2, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProtonBadge } from "./ProtonBadge";

/** Горизонтальная шапка Steam — запасная картинка, если у игры нет вертикальной обложки. */
const headerUrl = (appId: number) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

/** «12 ч 34 мин», «45 мин», «Не запускалась». */
export function formatPlaytime(minutes: number): string {
  if (minutes <= 0) return "Не запускалась";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** Какая картинка показана: вертикальная обложка, запасная шапка или заглушка с названием. */
type Art = "cover" | "header" | "none";

function Cover({ game }: { game: LibraryEntry }) {
  const [art, setArt] = useState<Art>("cover");

  if (art === "none") {
    return (
      <div
        role="img"
        aria-label={game.name}
        className="flex size-full flex-col items-center justify-center gap-3 bg-gradient-to-b from-secondary to-card p-4 text-center"
      >
        <Gamepad2 className="size-8 text-muted-foreground" />
        <span className="line-clamp-4 text-sm font-medium">{game.name}</span>
      </div>
    );
  }

  return (
    <img
      src={art === "cover" ? game.coverUrl : headerUrl(game.appId)}
      alt={game.name}
      loading="lazy"
      width={600}
      height={900}
      onError={() => setArt(art === "cover" ? "header" : "none")}
      className={
        art === "cover"
          ? "size-full object-cover transition duration-300 group-hover:scale-[1.03]"
          : "absolute inset-0 m-auto h-auto w-full"
      }
    />
  );
}

export function GameCard({ game }: { game: LibraryEntry }) {
  return (
    <article className="group flex flex-col gap-2">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-card shadow-lg ring-1 ring-white/5 transition group-hover:ring-white/20">
        <Cover game={game} />
        <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/80 to-transparent p-3 pt-10 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Отключённая кнопка не получает событий — подсказка висит на обёртке. */}
              <span tabIndex={0} className="w-full rounded-md">
                <Button disabled className="w-full">
                  <Play />
                  Играть
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Скоро</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1.5 px-0.5">
        <h3 className="w-full truncate text-sm font-medium" title={game.name}>
          {game.name}
        </h3>
        <ProtonBadge tier={game.protonTier} />
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title="Время в игре по данным Steam"
        >
          <Clock className="size-3" />
          {formatPlaytime(game.playtimeMinutes)}
        </span>
      </div>
    </article>
  );
}
