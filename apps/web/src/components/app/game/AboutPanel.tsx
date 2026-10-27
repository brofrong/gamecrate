// Панель «Об игре» с описанием из Steam (спека 2026-10-27 §3.5): короткое описание
// абзацем, полное — очищенный HTML (`sanitizeSteamHtml`), свёрнутый до ~6 строк с
// «Читать дальше»/«Свернуть». Нужна ли кнопка — решаем по длине текста (в happy-dom
// размеры нулевые, а измерять `scrollHeight` ради одной кнопки не стоит).
import type { GameDetails } from "@cg/rpc";
import { BookOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { Panel, PanelHeader } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { sanitizeSteamHtml } from "@/lib/sanitizeSteamHtml";
import { cn } from "@/lib/utils";

/** Длиннее этого (символов HTML) — сворачиваем и показываем «Читать дальше». */
const COLLAPSE_AFTER = 600;

export function AboutPanel({ details }: { details: GameDetails }) {
  const [expanded, setExpanded] = useState(false);
  const html = useMemo(
    () => sanitizeSteamHtml(details.aboutTheGame),
    [details.aboutTheGame],
  );
  if (details.shortDescription === "" && html === "") return null;
  const collapsible = html.length > COLLAPSE_AFTER;

  return (
    <Panel>
      <PanelHeader icon={<BookOpen className="size-4" />} title="Об игре" />
      {details.shortDescription !== "" && (
        <p className="text-sm leading-relaxed text-[#eef1ff]">
          {details.shortDescription}
        </p>
      )}
      {html !== "" && (
        <div
          className={cn(
            "prose-steam text-sm leading-relaxed text-[#cfd3e6] [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-[#eef1ff] [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded-md [&_li]:ml-4 [&_li]:list-disc [&_p]:mt-2",
            collapsible && !expanded && "max-h-[9.5rem] overflow-hidden",
          )}
          // HTML уже прогнан через allowlist в `sanitizeSteamHtml`.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {collapsible && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Свернуть" : "Читать дальше"}
        </Button>
      )}
    </Panel>
  );
}
