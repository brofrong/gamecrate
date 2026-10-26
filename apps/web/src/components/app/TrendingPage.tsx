// «В тренде» (`/app/trending`, Task 12): сейчас играют и за неделю — топ Steam по
// онлайну, карточки как в «Мои игры» (`GameTile`), но подпись — число игроков, не
// статус облака. Нет в библиотеке Steam у пользователя — кнопка скрыта («blocked»).
// Перезапрашивает `trendingAtom` раз в 30 с, пока страница смонтирована.
import type { TrendingEntry } from "@cg/rpc";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { GameSection } from "@/components/app/GameSection";
import { GameTile } from "@/components/app/GameTile";
import {
  cardAction,
  type CardAction,
  type LibraryPlay,
} from "@/lib/cardAction";
import { pluralize } from "@/lib/plural";
import { usePlaySession } from "@/lib/usePlaySession";
import { trendingAtom } from "@/rpc";

/** Раз в 30 с, пока компонент смонтирован, — см. спеку §4.2 и Task 12. */
const TRENDING_REFRESH_MS = 30_000;

/** Подпись карточки: число игроков (своя форма слова у каждой секции) или, если игры
 * нет в библиотеке Steam, фиксированный текст вместо кнопки. */
function caption(entry: TrendingEntry, kind: "now" | "week"): string {
  if (!entry.inLibrary) return "нет в твоей библиотеке Steam";
  return kind === "now"
    ? `${entry.players} ${pluralize(entry.players, "играет", "играют", "играют")}`
    : `${entry.players} ${pluralize(entry.players, "игрок", "игрока", "игроков")}`;
}

function trendingAction(entry: TrendingEntry, play: LibraryPlay): CardAction {
  if (!entry.inLibrary) return { kind: "blocked" };
  return cardAction(entry, play);
}

export function TrendingPage() {
  const trending = useAtomValue(trendingAtom);
  const refresh = useAtomRefresh(trendingAtom);
  const { play } = usePlaySession();

  useEffect(() => {
    const timer = setInterval(() => refresh(), TRENDING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const view = AsyncResult.isSuccess(trending) ? trending.value : undefined;
  const empty =
    view !== undefined && view.now.length === 0 && view.week.length === 0;

  return (
    <>
      <h1 className="text-2xl font-bold text-[#eef1ff]">В тренде</h1>
      {empty && (
        <p className="text-sm text-[#8a90a8]">
          Пока тихо. Запусти что-нибудь первым
        </p>
      )}
      {view !== undefined && view.now.length > 0 && (
        <GameSection title="Сейчас играют" count={view.now.length}>
          {view.now.map((entry) => (
            <GameTile
              key={entry.appId}
              game={entry}
              caption={caption(entry, "now")}
              action={trendingAction(entry, play)}
            />
          ))}
        </GameSection>
      )}
      {view !== undefined && view.week.length > 0 && (
        <GameSection title="За неделю" count={view.week.length}>
          {view.week.map((entry) => (
            <GameTile
              key={entry.appId}
              game={entry}
              caption={caption(entry, "week")}
              action={trendingAction(entry, play)}
            />
          ))}
        </GameSection>
      )}
    </>
  );
}
