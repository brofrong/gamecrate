// Шапка страницы игры (спека 2026-10-27 §3.5): широкая картинка Steam с затемнением,
// название, ряд чипов (облако, ProtonDB, часы, последний запуск) и кнопка
// «Играть»/«Установить»/«Вернуться в игру» — та же `cardAction`, что у плиток.
// `library_hero.jpg` не загрузилась → `header.jpg` размытой подложкой.
import type { GameView } from "@cg/rpc";
import { Download, LoaderCircle, Play } from "lucide-react";
import { useState } from "react";
import { headerUrl } from "@/components/app/GameCover";
import { playLabel } from "@/components/app/GameTile";
import { Button } from "@/components/ui/button";
import type { CardAction } from "@/lib/cardAction";
import {
  formatHoursShort,
  formatMinutes,
  formatRelativeDate,
} from "@/lib/formatTime";
import { heroUrl } from "@/lib/gameHero";
import { cn } from "@/lib/utils";

type Tone = "muted" | "ok" | "warn";

const chipClassName: Record<Tone, string> = {
  muted: "border-white/10 text-[#cfd3e6]",
  ok: "border-[#3ddc97]/35 text-[#3ddc97]",
  warn: "border-[#ffd166]/35 text-[#ffd166]",
};

/** Чип статуса облака: «В облаке» / «качается · N %» / «не установлена». */
export function cloudChip(cloud: GameView["cloud"]): {
  text: string;
  tone: Tone;
} {
  switch (cloud._tag) {
    case "Ready":
      return { text: "В облаке", tone: "ok" };
    case "Installing":
      return {
        text:
          cloud.percent === null ? "качается" : `качается · ${cloud.percent} %`,
        tone: "warn",
      };
    case "Missing":
      return { text: "не установлена", tone: "muted" };
  }
}

function Chip({ text, tone = "muted" }: { text: string; tone?: Tone }) {
  return (
    <span
      className={cn(
        "rounded-full border bg-black/40 px-2.5 py-1 text-xs font-medium backdrop-blur-sm",
        chipClassName[tone],
      )}
    >
      {tone === "ok" ? `● ${text}` : text}
    </span>
  );
}

/** Кнопка шапки — тот же `CardAction`, что у плиток; экспортируется для `StickySlot`. */
export function HeroButton({
  game,
  action,
  className,
}: {
  game: GameView;
  action: CardAction;
  className?: string;
}) {
  switch (action.kind) {
    case "play": {
      const label = playLabel(game.cloud);
      return (
        <Button
          size="lg"
          className={className}
          aria-label={`${label}: ${game.name}`}
          disabled={action.pending || action.disabled}
          onClick={action.onPlay}
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
        <Button size="lg" className={className} onClick={action.onResume}>
          <Play />
          Вернуться в игру
        </Button>
      );
    case "blocked":
      return null;
  }
}

export function GameHero({
  game,
  action,
  now,
}: {
  game: GameView;
  /** `null` — игры нет в библиотеке пользователя: кнопки нет. */
  action: CardAction | null;
  now: Date;
}) {
  const [heroFailed, setHeroFailed] = useState(false);
  const cloud = cloudChip(game.cloud);
  const hours = formatHoursShort(game.playtimeMinutes);

  return (
    <header className="relative h-[180px] overflow-hidden rounded-[18px] bg-[#1a1d26] md:h-[280px]">
      {heroFailed ? (
        <img
          src={headerUrl(game.appId)}
          alt=""
          className="size-full scale-110 object-cover blur-sm"
        />
      ) : (
        <img
          src={heroUrl(game.appId)}
          alt=""
          className="size-full object-cover"
          onError={() => setHeroFailed(true)}
        />
      )}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-[#0d0f14]/10 via-[#0d0f14]/40 to-[#0d0f14]/95"
      />
      <div className="absolute inset-x-4 bottom-4 flex flex-col gap-3 md:inset-x-6 md:bottom-5 md:flex-row md:items-end md:justify-between md:gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="truncate text-2xl font-bold text-[#eef1ff] md:text-3xl">
            {game.name}
          </h1>
          <div className="flex flex-wrap gap-2">
            <Chip text={cloud.text} tone={cloud.tone} />
            {game.protonTier !== "pending" && (
              <Chip text={`ProtonDB: ${game.protonTier}`} />
            )}
            {game.inLibrary && hours !== "" && (
              <Chip text={`${hours} сыграно`} />
            )}
            {game.inLibrary && game.lastSession !== null && (
              <Chip
                text={`последний запуск: ${formatRelativeDate(game.lastSession.startedAt, now)}, ${formatMinutes(game.lastSession.minutes)}`}
              />
            )}
          </div>
        </div>
        {action !== null && (
          <HeroButton game={game} action={action} className="hidden md:flex" />
        )}
      </div>
    </header>
  );
}
