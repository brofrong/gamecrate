// Панель достижений на странице игры (спека 2026-10-27 §3.5): `Ready` — сетка иконок
// 48 px (открытые первыми, закрытые приглушены серой иконкой, скрытые без названия
// и описания), первые 32 и «ещё N»; `Private` — подсказка про приватность Steam;
// `None`/`Unlinked` — панели нет. Название и описание — в тултипе и в `alt`.
import type { GameAchievements } from "@cg/rpc";
import { Trophy } from "lucide-react";
import { useState } from "react";
import { Panel, PanelHeader } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelativeDate } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

/** Сколько иконок видно до «ещё N». */
const VISIBLE = 32;

type Item = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly unlockedAt: string | null;
};

function AchievementIcon({ item, now }: { item: Item; now: Date }) {
  const locked = item.unlockedAt === null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          {...(locked ? { "data-locked": "" } : {})}
          className={cn(
            "block aspect-square overflow-hidden rounded-lg bg-[#1a1d26]",
            locked && "opacity-40",
          )}
        >
          <img
            src={item.icon}
            alt={item.name}
            loading="lazy"
            className="size-full object-cover"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-56">
        <p className="font-semibold">{item.name}</p>
        {item.description !== "" && (
          <p className="text-xs opacity-80">{item.description}</p>
        )}
        {item.unlockedAt !== null && (
          <p className="text-xs opacity-80">
            получено {formatRelativeDate(item.unlockedAt, now)}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function AchievementsPanel({
  achievements,
}: {
  achievements: GameAchievements;
}) {
  const [expanded, setExpanded] = useState(false);
  const now = new Date();

  if (achievements._tag === "None" || achievements._tag === "Unlinked")
    return null;

  if (achievements._tag === "Private")
    return (
      <Panel>
        <PanelHeader icon={<Trophy className="size-4" />} title="Достижения" />
        <p className="text-sm text-[#8a90a8]">
          Steam скрывает твои достижения. Открой «Сведения об играх» в
          настройках приватности Steam.{" "}
          <a
            href="https://steamcommunity.com/my/edit/settings"
            target="_blank"
            rel="noreferrer"
            className="text-brand-accent hover:underline"
          >
            Настройки приватности ↗
          </a>
        </p>
      </Panel>
    );

  const items: ReadonlyArray<Item> = [
    ...achievements.unlocked.map((a) => ({
      key: a.apiName,
      name: a.name,
      description: a.description,
      icon: a.icon,
      unlockedAt: a.unlockedAt,
    })),
    ...achievements.locked.map((a) => ({
      key: a.apiName,
      name: a.hidden ? "Скрытое достижение" : a.name,
      description: a.hidden ? "" : a.description,
      icon: a.iconGray,
      unlockedAt: null,
    })),
  ];
  const visible = expanded ? items : items.slice(0, VISIBLE);
  const hidden = items.length - visible.length;

  return (
    <Panel>
      <PanelHeader
        icon={<Trophy className="size-4" />}
        title={`Достижения · ${achievements.unlocked.length} из ${achievements.total}`}
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-1.5">
        {visible.map((item) => (
          <AchievementIcon key={item.key} item={item} now={now} />
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
    </Panel>
  );
}
