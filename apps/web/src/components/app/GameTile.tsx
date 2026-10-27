// Карточка игры на `/app` (спека 2026-10-27 §3.3, вариант C): вся плитка — ссылка на
// страницу игры, под обложкой ничего нет. На обложке: затемнённый низ с названием слева
// и одним коротким значением справа (`tileValue` или `caption` секции), полоса установки
// по нижнему краю, тег Proton в углу, кнопка «Играть»/«Установить» по центру при
// наведении (на тач-экранах — всегда). Клик по кнопке не всплывает в ссылку.
// Общий тип `TileGame` покрывает `LibraryEntry`, `RecentEntry` и `TrendingEntry`.
import { type CloudStatus, type ProtonTier, tierLabel } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import { Download, LoaderCircle, Play } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { GameCover } from "@/components/app/GameCover";
import type { CardAction } from "@/lib/cardAction";
import { type TileTone, tileValue } from "@/lib/tileValue";
import { cn } from "@/lib/utils";

export type TileGame = {
  readonly appId: number;
  readonly name: string;
  readonly coverUrl: string;
  readonly cloud: CloudStatus;
  readonly playtimeMinutes?: number;
  readonly protonTier?: ProtonTier;
};

const toneClassName: Record<TileTone, string> = {
  muted: "text-[#aab0c6]",
  ok: "text-[#3ddc97]",
  warn: "text-[#ffd166]",
};

function ProtonTag({ tier }: { tier: ProtonTier | undefined }) {
  if (tier === undefined || tier === "pending") return null;
  return (
    <span
      data-testid="proton-tag"
      title={tierLabel[tier]}
      className="absolute top-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#cfd3e6]"
    >
      {tier}
    </span>
  );
}

/** «Играть» у установленной игры, «Установить» у остальных — запрос один и тот же. */
export function playLabel(cloud: CloudStatus): "Играть" | "Установить" {
  return cloud._tag === "Ready" ? "Играть" : "Установить";
}

function CardButton({ action, game }: { action: CardAction; game: TileGame }) {
  // Кнопка живёт внутри ссылки: гасим переход по ссылке и всплытие клика.
  const stop = (e: React.MouseEvent, run: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    run();
  };
  switch (action.kind) {
    case "play": {
      const label = playLabel(game.cloud);
      return (
        <Button
          aria-label={`${label}: ${game.name}`}
          disabled={action.pending || action.disabled}
          onClick={(e) => stop(e, action.onPlay)}
        >
          {action.pending ? (
            <LoaderCircle className="animate-spin" />
          ) : label === "Играть" ? (
            <Play />
          ) : (
            <Download />
          )}
          {label}
        </Button>
      );
    }
    case "resume":
      return (
        <Button onClick={(e) => stop(e, action.onResume)}>
          <Play />
          Вернуться в игру
        </Button>
      );
    case "blocked":
      return null;
  }
}

export function GameTile({
  game,
  action,
  dimmed = false,
  caption,
}: {
  game: TileGame;
  action: CardAction;
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
      params={{ appId: String(game.appId) }}
      aria-label={`Игра: ${game.name}`}
      className="group block rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-[#3cc2ff]"
    >
      <article className="relative aspect-[460/215] overflow-hidden rounded-[14px] bg-[#1a1d26]">
        <GameCover game={game} dimmed={dimmed} />
        <ProtonTag tier={game.protonTier} />
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2.5 pt-7 pb-2">
          <h3
            className="min-w-0 truncate text-[13px] font-semibold text-[#eef1ff]"
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
        {value.percent !== null && (
          <span
            data-testid="install-bar"
            aria-hidden
            className="absolute bottom-0 left-0 h-[3px] bg-[#ffd166]"
            style={{ width: `${value.percent}%` }}
          />
        )}
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center opacity-0 transition",
            "group-hover:opacity-100 focus-within:opacity-100",
            "[@media(hover:none)]:opacity-100",
          )}
        >
          <CardButton action={action} game={game} />
        </div>
      </article>
    </Link>
  );
}
