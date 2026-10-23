// Карточка игры на главной `/app`: горизонтальная обложка 460×215, плашка «ГОТОВА»,
// уровень Proton, название и строка статуса с цветной точкой — см. спеку §4.3.
// Общий тип `TileGame` покрывает `LibraryEntry`, `RecentEntry` и `TrendingEntry`:
// все три несут `appId`/`name`/`coverUrl`/`cloud`, время и Proton — не у всех.
import { type CloudStatus, type ProtonTier, tierLabel } from "@cg/rpc";
import { Gamepad2, LoaderCircle, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CardAction } from "@/lib/cardAction";
import { formatHoursInGame } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

export type TileGame = {
  readonly appId: number;
  readonly name: string;
  readonly coverUrl: string;
  readonly cloud: CloudStatus;
  readonly playtimeMinutes?: number;
  readonly protonTier?: ProtonTier;
};

/** Горизонтальная шапка Steam — основная картинка карточки. */
const headerUrl = (appId: number) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

/**
 * Строка статуса под названием — ровно по таблице спеки §4.3. `dimmed`
 * (нет облачного профиля у пользователя) перекрывает статус облака.
 */
export function cloudLabel(game: TileGame, dimmed: boolean): string {
  if (dimmed) return "нужен вход в Steam";
  const hours = formatHoursInGame(game.playtimeMinutes ?? 0);
  switch (game.cloud._tag) {
    case "Ready":
      return `готова · ${hours}`;
    case "Installing":
      return game.cloud.percent === null
        ? "качается"
        : `качается · ${game.cloud.percent} %`;
    case "Missing":
      return `нужна установка · ${hours}`;
  }
}

/** Цвет точки статуса (зелёная/жёлтая/серая) — та же таблица §4.3. */
function dotClassName(game: TileGame, dimmed: boolean): string {
  if (dimmed) return "bg-[#8a90a8]";
  return game.cloud._tag === "Ready" ? "bg-[#3ddc97]" : "bg-[#ffd166]";
}

/** Какая картинка показана: шапка Steam, запасная вертикальная обложка или заглушка с именем. */
type Art = "header" | "cover" | "none";

function Cover({ game, dimmed }: { game: TileGame; dimmed: boolean }) {
  const [art, setArt] = useState<Art>("header");

  if (art === "none") {
    return (
      <div
        role="img"
        aria-label={game.name}
        className="flex size-full flex-col items-center justify-center gap-2 bg-gradient-to-b from-secondary to-card p-3 text-center"
      >
        <Gamepad2 className="size-6 text-muted-foreground" />
        <span className="line-clamp-3 text-xs font-medium">{game.name}</span>
      </div>
    );
  }

  return (
    <img
      src={art === "header" ? headerUrl(game.appId) : game.coverUrl}
      alt={game.name}
      loading="lazy"
      onError={() => setArt(art === "header" ? "cover" : "none")}
      className={cn(
        "size-full object-cover transition duration-300 group-hover:scale-[1.03]",
        dimmed && "opacity-70 saturate-50",
      )}
    />
  );
}

function ProtonTag({ tier }: { tier: ProtonTier | undefined }) {
  if (tier === undefined || tier === "pending") return null;
  return (
    <span
      title={tierLabel[tier]}
      className="absolute top-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#cfd3e6]"
    >
      {tier}
    </span>
  );
}

function CardButton({ action, name }: { action: CardAction; name: string }) {
  switch (action.kind) {
    case "play":
      return (
        <Button
          aria-label={`Играть: ${name}`}
          disabled={action.pending || action.disabled}
          onClick={action.onPlay}
        >
          {action.pending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Play />
          )}
          Играть
        </Button>
      );
    case "resume":
      return (
        <Button onClick={action.onResume}>
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
  caption?: string;
}) {
  return (
    <article className="group flex flex-col gap-2">
      <div className="relative aspect-[460/215] overflow-hidden rounded-[14px] bg-[#1a1d26]">
        <Cover game={game} dimmed={dimmed} />
        {game.cloud._tag === "Ready" && (
          <span className="absolute top-2 left-2 rounded-[7px] border border-[#3ddc97]/35 bg-[#3ddc97]/18 px-2 py-1 text-[10px] font-bold tracking-wide text-[#3ddc97] backdrop-blur-sm">
            ГОТОВА
          </span>
        )}
        <ProtonTag tier={game.protonTier} />
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 flex justify-center p-2.5 opacity-0 transition",
            "group-hover:opacity-100 focus-within:opacity-100",
            "[@media(hover:none)]:opacity-100",
          )}
        >
          <CardButton action={action} name={game.name} />
        </div>
      </div>
      <h3
        className="truncate text-sm font-semibold text-[#eef1ff]"
        title={game.name}
      >
        {game.name}
      </h3>
      <span className="flex items-center gap-1.5 text-xs text-[#8a90a8]">
        {caption === undefined && (
          <span
            aria-hidden
            className={cn("size-1.5 rounded-sm", dotClassName(game, dimmed))}
          />
        )}
        {caption ?? cloudLabel(game, dimmed)}
      </span>
    </article>
  );
}
