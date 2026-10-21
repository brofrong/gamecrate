// Hero: стена обложек, затемнение, чипы платформ, заголовок, одна кнопка «Играть» и
// шесть плюсов. Текстовый слой не перехватывает мышь (иначе ряд под курсором не
// определится), кнопка — перехватывает.
import { ArrowRight } from "lucide-react";
import { steamLoginFailed } from "@/lib/useSteamLogin";
import { CoverWall } from "./CoverWall";
import { perks, platforms } from "./data";
import { SteamButton } from "./SteamButton";

export function Hero({ error }: { error: boolean }) {
  return (
    <header
      id="top"
      className="relative flex min-h-dvh items-center overflow-hidden"
    >
      <CoverWall />
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_70%_60%_at_30%_55%,rgba(5,6,15,0.94),rgba(5,6,15,0.6)_60%,rgba(5,6,15,0.3)_100%),linear-gradient(180deg,rgba(5,6,15,0.8)_0%,rgba(5,6,15,0.15)_30%,rgba(5,6,15,0.15)_70%,#05060f_100%)]" />
      <div className="pointer-events-none relative z-[2] mx-auto w-full max-w-[1180px] px-7 pt-[120px] pb-[90px]">
        <div className="mb-6 flex flex-wrap gap-2">
          {platforms.map((p) => (
            <span
              key={p}
              className="inline-flex items-center rounded-full border border-white/10 bg-white/6 px-[11px] py-1.5 text-xs font-semibold text-[#c8cbe8] backdrop-blur-[6px]"
            >
              {p}
            </span>
          ))}
        </div>
        <h1 className="mb-[22px] max-w-[820px] text-[clamp(42px,6.6vw,86px)] leading-[0.96] font-extrabold tracking-[-0.045em]">
          Любая игра. <br />
          Где <span className="text-gradient">угодно</span>. <br />
          Прямо сейчас.
        </h1>
        <p className="mb-8 max-w-[540px] text-[clamp(16px,1.6vw,20px)] leading-normal text-[#b8bce0]">
          Твоя библиотека Steam на облачной видеокарте. В браузере, на ПК или с
          телефона — без установки и без мощного железа.
        </p>
        {error && (
          <p className="mb-4 text-sm text-red-400">{steamLoginFailed}</p>
        )}
        <SteamButton variant="primary" className="pointer-events-auto">
          Играть
          <ArrowRight className="size-[18px]" strokeWidth={2.4} />
        </SteamButton>
        <div className="mt-14 grid max-w-[980px] grid-cols-2 gap-2.5 min-[600px]:grid-cols-3 min-[1000px]:grid-cols-6">
          {perks.map(({ icon: Icon, title, text }) => (
            <div
              key={title}
              className="rounded-[14px] border border-brand-line bg-[rgba(10,13,28,0.6)] p-3.5 backdrop-blur-[10px]"
            >
              <Icon className="mb-2.5 size-[18px] text-brand-cyan" />
              <b className="mb-1 block text-[15px] tracking-[-0.01em]">
                {title}
              </b>
              <span className="block text-xs leading-[1.35] text-brand-muted">
                {text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
