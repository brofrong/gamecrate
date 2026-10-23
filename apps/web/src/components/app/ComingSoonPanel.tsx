// Нижняя панель правой колонки `/app` — задел под будущие облачные провайдеры
// (Epic Games и т.д., спека §4.2): без действий, скрыта на телефоне (там нет места,
// и сводка там — `SummaryStrip`).
export function ComingSoonPanel({ name }: { name: string }) {
  return (
    <section className="hidden rounded-[20px] bg-[#13161d] px-[18px] py-3 md:block">
      <h2 className="flex items-center gap-2.5 text-[15px] font-bold text-[#eef1ff]">
        <span
          aria-hidden
          className="flex size-[30px] items-center justify-center rounded-full bg-[#2a2e3a] font-mono text-[10px] font-bold"
        >
          {name.slice(0, 2).toUpperCase()}
        </span>
        {name}
        <span className="ml-auto rounded-xl bg-white/5 px-2.5 py-1 text-xs font-medium text-[#8a90a8]">
          Скоро
        </span>
      </h2>
    </section>
  );
}
