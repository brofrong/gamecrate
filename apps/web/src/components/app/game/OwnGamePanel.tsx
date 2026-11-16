// Своя игра на странице игры (спека 2026-11-03 «Бесплатные игры» §4.2) — вместо
// Steam-блоков `MediaStrip`/`AboutPanel`: наши скриншоты (клик — `Lightbox`),
// описание абзацами со строкой «Фанатский ПК-порт» и ссылкой на проект, таблица
// «Управление» (действие, клавиатура, геймпад). Описание — простой текст, абзацы
// разделены пустой строкой; HTML не разбираем.
import type { OwnGameInfo } from "@cg/rpc";
import { BookOpen, Gamepad2, Images } from "lucide-react";
import { useState } from "react";
import { KeyValueList } from "@/components/app/game/KeyValueList";
import { Lightbox } from "@/components/app/game/Lightbox";
import { Panel, PanelHeader } from "@/components/app/Panel";

/** Абзацы описания: разделитель — пустая строка (строки из пробелов тоже). */
export function paragraphs(text: string): ReadonlyArray<string> {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

function Screenshots({ shots }: { shots: ReadonlyArray<string> }) {
  const [open, setOpen] = useState<number | null>(null);
  if (shots.length === 0) return null;
  return (
    <Panel>
      <PanelHeader icon={<Images className="size-4" />} title="Скриншоты" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 [&>*:first-child]:col-span-2 [&>*:first-child]:row-span-2">
        {shots.map((shot, i) => (
          <button
            key={shot}
            type="button"
            aria-label={`Скриншот ${i + 1}`}
            onClick={() => setOpen(i)}
            className="aspect-video overflow-hidden rounded-[10px] bg-[#1a1d26]"
          >
            <img
              src={shot}
              alt=""
              loading="lazy"
              className="size-full object-cover transition hover:scale-105"
            />
          </button>
        ))}
      </div>
      {open !== null && (
        <Lightbox
          items={shots}
          index={open}
          onClose={() => setOpen(null)}
          onIndex={setOpen}
        />
      )}
    </Panel>
  );
}

const cellClassName = "py-1.5 pr-3 align-top last:pr-0";

export function OwnGamePanel({ own }: { own: OwnGameInfo }) {
  return (
    <>
      <Screenshots shots={own.screenshots} />
      <Panel>
        <PanelHeader icon={<BookOpen className="size-4" />} title="Об игре" />
        {paragraphs(own.description).map((paragraph, i) => (
          <p
            // Абзацы не переставляются — индекс в ключе безопасен.
            key={i}
            className="text-sm leading-relaxed text-[#cfd3e6] first:text-[#eef1ff]"
          >
            {paragraph}
          </p>
        ))}
        <KeyValueList
          rows={[
            {
              label: "Фанатский ПК-порт",
              value: (
                <a
                  href={own.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-accent hover:underline"
                >
                  {own.source.label} ↗
                </a>
              ),
            },
          ]}
        />
      </Panel>
      {own.controls.length > 0 && (
        <Panel>
          <PanelHeader
            icon={<Gamepad2 className="size-4" />}
            title="Управление"
          />
          <div className="overflow-x-auto">
            <table aria-label="Управление" className="w-full text-sm">
              <thead>
                <tr className="text-left text-[#8a90a8]">
                  <th className={`${cellClassName} font-medium`}>Действие</th>
                  <th className={`${cellClassName} font-medium`}>Клавиатура</th>
                  <th className={`${cellClassName} font-medium`}>Геймпад</th>
                </tr>
              </thead>
              <tbody className="text-[#eef1ff]">
                {own.controls.map((control) => (
                  <tr key={control.action} className="border-t border-white/5">
                    <td className={cellClassName}>{control.action}</td>
                    <td className={`${cellClassName} font-mono text-xs`}>
                      {control.keyboard}
                    </td>
                    <td className={cellClassName}>{control.gamepad}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
