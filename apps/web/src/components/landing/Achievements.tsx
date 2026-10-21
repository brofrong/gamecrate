// Ачивки: сетка карточек с эмодзи в шестиугольнике; сезонные — серые и подписаны.
import { cn } from "@/lib/utils";
import { achievements } from "./data";
import { SectionHead } from "./SectionHead";

export function Achievements() {
  return (
    <section id="ach" className="relative py-[110px]">
      <div className="mx-auto max-w-[1180px] px-7">
        <SectionHead label="Ачивки" title="Играй и собирай">
          Свои достижения за то, как ты играешь на GameCrate. Часть открыта
          только в сезонные ивенты.
        </SectionHead>
        <div className="grid grid-cols-2 gap-3.5 min-[960px]:grid-cols-4">
          {achievements.map((a) => (
            <div
              key={a.title}
              className={cn(
                "flex items-center gap-4 rounded-[18px] border border-brand-line bg-brand-card p-5 transition-[transform,border-color] duration-200 hover:-translate-y-[3px] hover:border-brand-cyan/35",
                a.season && "opacity-70",
              )}
            >
              <div
                aria-hidden="true"
                className={cn(
                  "flex size-14 shrink-0 items-center justify-center text-2xl [clip-path:polygon(50%_0,93%_25%,93%_75%,50%_100%,7%_75%,7%_25%)]",
                  a.season
                    ? "bg-[#1a1e3a] opacity-60 grayscale"
                    : "bg-brand-gradient",
                )}
              >
                {a.emoji}
              </div>
              <div>
                <b className="mb-[3px] block text-[15px] tracking-[-0.01em]">
                  {a.title}
                </b>
                <span className="block text-[12.5px] leading-[1.4] text-brand-muted">
                  {a.text}
                </span>
                {a.season && (
                  <em className="mt-1.5 inline-block text-[10px] font-bold tracking-[0.08em] text-brand-warn uppercase not-italic">
                    {a.season}
                  </em>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
