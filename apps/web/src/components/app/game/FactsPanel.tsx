// Панель «Об игре» с фактами (спека 2026-10-27 §3.5): разработчик, издатель (если
// другой), дата выхода, жанры (до четырёх), Metacritic со ссылкой и всегда — ссылка
// «Открыть в Steam ↗». Без `details` остаётся только ссылка на Steam.
import type { GameView } from "@cg/rpc";
import { Info } from "lucide-react";
import { Panel, PanelHeader } from "@/components/app/Panel";
import {
  KeyValueList,
  type KeyValueRow,
} from "@/components/app/game/KeyValueList";
import { storeUrl } from "@/lib/gameHero";

const linkClassName = "text-[#3cc2ff] hover:underline";

export function FactsPanel({ game }: { game: GameView }) {
  const details = game.details;
  const rows: KeyValueRow[] = [];
  if (details !== null) {
    if (details.developers.length > 0)
      rows.push({ label: "Разработчик", value: details.developers.join(", ") });
    const publishers = details.publishers.join(", ");
    if (publishers !== "" && publishers !== details.developers.join(", "))
      rows.push({ label: "Издатель", value: publishers });
    if (details.releaseDate !== null)
      rows.push({ label: "Выход", value: details.releaseDate });
    if (details.genres.length > 0)
      rows.push({
        label: "Жанры",
        value: details.genres.slice(0, 4).join(", "),
      });
    if (details.metacriticScore !== null)
      rows.push({
        label: "Metacritic",
        value:
          details.metacriticUrl === null ? (
            String(details.metacriticScore)
          ) : (
            <a
              href={details.metacriticUrl}
              target="_blank"
              rel="noreferrer"
              className={linkClassName}
            >
              {details.metacriticScore}
            </a>
          ),
      });
  }
  rows.push({
    label: "Steam",
    value: (
      <a
        href={storeUrl(game.appId)}
        target="_blank"
        rel="noreferrer"
        className={linkClassName}
      >
        Открыть в Steam ↗
      </a>
    ),
  });

  return (
    <Panel>
      <PanelHeader icon={<Info className="size-4" />} title="Об игре" />
      <KeyValueList rows={rows} />
    </Panel>
  );
}
