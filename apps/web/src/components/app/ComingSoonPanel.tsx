// Нижняя панель правой колонки `/app` — задел под будущие облачные провайдеры
// (Epic Games и т.д., спека §4.2): без действий, скрыта на телефоне (там нет места,
// и сводка там — `SummaryStrip`).
import { Panel, PanelHeader } from "@/components/app/Panel";

export function ComingSoonPanel({ name }: { name: string }) {
  return (
    <Panel className="hidden gap-0 px-[18px] py-3 md:block">
      <PanelHeader
        icon={name.slice(0, 2).toUpperCase()}
        title={name}
        className="text-[15px]"
        pill={
          <span className="rounded-xl bg-white/5 px-2.5 py-1 text-xs font-medium text-[#8a90a8]">
            Скоро
          </span>
        }
      />
    </Panel>
  );
}
