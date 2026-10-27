// Панель «Скриншоты и видео» на странице игры (спека 2026-10-27 §3.5): первым —
// трейлер (`highlight`, иначе первый фильм), затем скриншоты; показываем первые 8
// элементов, «ещё N» раскрывает все; клик по скриншоту — лайтбокс. Без медиа
// панели нет.
import type { GameDetails } from "@cg/rpc";
import { Images } from "lucide-react";
import { useState } from "react";
import { Lightbox } from "@/components/app/game/Lightbox";
import { TrailerPlayer } from "@/components/app/game/TrailerPlayer";
import { Panel, PanelHeader } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";

/** Сколько элементов (трейлер + скриншоты) видно до «ещё N». */
const VISIBLE = 8;

export function MediaStrip({
  details,
  name,
}: {
  details: GameDetails;
  name: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const trailer =
    details.movies.find((movie) => movie.highlight) ?? details.movies[0];
  const shots = details.screenshots;
  const total = shots.length + (trailer === undefined ? 0 : 1);
  if (total === 0) return null;

  const visibleShots = expanded
    ? shots
    : shots.slice(0, VISIBLE - (trailer === undefined ? 0 : 1));
  const hidden = shots.length - visibleShots.length;

  return (
    <Panel>
      <PanelHeader
        icon={<Images className="size-4" />}
        title="Скриншоты и видео"
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 [&>*:first-child]:col-span-2 [&>*:first-child]:row-span-2">
        {trailer !== undefined && (
          <TrailerPlayer
            hls={trailer.hls}
            poster={trailer.thumbnail}
            name={name}
          />
        )}
        {visibleShots.map((shot, i) => (
          <button
            key={shot.full}
            type="button"
            aria-label={`Скриншот ${i + 1}`}
            onClick={() => setOpen(i)}
            className="aspect-video overflow-hidden rounded-[10px] bg-[#1a1d26]"
          >
            <img
              src={shot.thumb}
              alt=""
              loading="lazy"
              className="size-full object-cover transition hover:scale-105"
            />
          </button>
        ))}
      </div>
      {hidden > 0 && (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          onClick={() => setExpanded(true)}
        >
          ещё {hidden}
        </Button>
      )}
      {open !== null && (
        <Lightbox
          items={shots.map((shot) => shot.full)}
          index={open}
          onClose={() => setOpen(null)}
          onIndex={setOpen}
        />
      )}
    </Panel>
  );
}
