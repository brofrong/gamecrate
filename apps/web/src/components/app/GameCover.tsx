// Обложка игры, общая для `GameTile` (сетка `/app`) и `ActiveSessionPanel`:
// горизонтальная шапка Steam (у своей игры — наша `header.jpg`) → запасная
// вертикальная обложка → заглушка с именем.
// Заполняет родителя (`size-full`) — размер, форму и обрезку (aspect-ratio,
// `overflow-hidden`, скругление) задаёт обёртка вызывающего компонента.
import { isOwnAppId, ownGameAssetUrl } from "@cg/rpc";
import { Gamepad2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export type CoverGame = {
  readonly appId: number;
  readonly name: string;
  readonly coverUrl: string;
};

/** Горизонтальная шапка Steam (своей игры — `/own-games/…`) — основная картинка обложки. */
export const headerUrl = (appId: number) =>
  isOwnAppId(appId)
    ? ownGameAssetUrl(appId, "header.jpg")
    : `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

/** Какая картинка показана: шапка Steam, запасная вертикальная обложка или заглушка. */
type Art = "header" | "cover" | "none";

export function GameCover({
  game,
  dimmed = false,
  showNameInPlaceholder = true,
}: {
  game: CoverGame;
  /** Нет облачного профиля у пользователя — приглушить картинку (`GameTile`). */
  dimmed?: boolean;
  /** Заглушка показывает название игры — выключено в компактной `ActiveSessionPanel`. */
  showNameInPlaceholder?: boolean;
}) {
  const [art, setArt] = useState<Art>("header");

  if (art === "none") {
    return (
      <div
        role="img"
        aria-label={game.name}
        className="flex size-full flex-col items-center justify-center gap-2 bg-gradient-to-b from-secondary to-card p-3 text-center"
      >
        <Gamepad2 className="size-6 text-muted-foreground" />
        {showNameInPlaceholder && (
          <span className="line-clamp-3 text-xs font-medium">{game.name}</span>
        )}
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
