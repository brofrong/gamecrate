// Панель «Совместимость» на странице игры (спека 2026-10-27 §3.5): ProtonDB,
// статус в облаке с размером, геймпад, Linux. Строки без данных не рисуются;
// панель без строк — не рисуется вовсе.
import { type GameView, tierLabel } from "@cg/rpc";
import { Gauge } from "lucide-react";
import { Panel, PanelHeader } from "@/components/app/Panel";
import {
  KeyValueList,
  type KeyValueRow,
} from "@/components/app/game/KeyValueList";

/** «122.0 ГБ» — размер установленной игры с одним знаком. */
export function formatGigabytes(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} ГБ`;
}

function cloudRow(game: GameView): string {
  switch (game.cloud._tag) {
    case "Ready":
      return game.sizeBytes === null
        ? "установлена"
        : `установлена, ${formatGigabytes(game.sizeBytes)}`;
    case "Installing":
      return "качается";
    case "Missing":
      return "не установлена";
  }
}

const tierClassName: Partial<Record<GameView["protonTier"], string>> = {
  platinum: "text-[#b4c7dc]",
  gold: "text-[#e0c552]",
  silver: "text-[#c0c0c0]",
  bronze: "text-[#cd7f32]",
  borked: "text-[#ff6b6b]",
};

export function CompatPanel({ game }: { game: GameView }) {
  const rows: KeyValueRow[] = [];
  if (game.protonTier !== "pending")
    rows.push({
      label: "ProtonDB",
      value: tierLabel[game.protonTier],
      className: tierClassName[game.protonTier],
    });
  rows.push({ label: "В облаке", value: cloudRow(game) });
  if (game.details?.controllerSupport === "full")
    rows.push({ label: "Геймпад", value: "полная поддержка" });
  if (game.details?.controllerSupport === "partial")
    rows.push({ label: "Геймпад", value: "частичная" });
  if (game.details?.linux)
    rows.push({ label: "Linux", value: "есть нативная версия" });

  return (
    <Panel>
      <PanelHeader icon={<Gauge className="size-4" />} title="Совместимость" />
      <KeyValueList rows={rows} />
    </Panel>
  );
}
