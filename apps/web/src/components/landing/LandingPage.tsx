// Главная для невошедшего пользователя: шапка, секции по порядку, призыв и футер.
// `error` — Better Auth вернул `/?error=…` после неудачного входа через Steam.
import { steamLoginFailed } from "@/lib/useSteamLogin";
import { platforms } from "./data";
import { FinalCta } from "./FinalCta";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import { SteamButton } from "./SteamButton";

export function LandingPage({ error }: { error: boolean }) {
  return (
    <div
      id="top"
      className="landing min-h-dvh overflow-x-hidden bg-brand-bg font-sans text-brand-text antialiased"
    >
      <LandingNav />
      <main>
        <section className="relative mx-auto max-w-[1180px] px-7 pt-[160px] pb-[90px]">
          <div className="mb-6 flex flex-wrap gap-2">
            {platforms.map((p) => (
              <span
                key={p}
                className="rounded-full border border-brand-line bg-white/4 px-3 py-1 text-xs text-brand-muted"
              >
                {p}
              </span>
            ))}
          </div>
          <h1 className="max-w-[12ch] text-[clamp(42px,6.6vw,86px)] leading-[0.98] font-extrabold tracking-[-0.04em]">
            Любая игра. Где <span className="text-gradient">угодно</span>. Прямо
            сейчас.
          </h1>
          <p className="mt-6 max-w-[52ch] text-lg text-brand-muted">
            Твоя библиотека Steam на облачной видеокарте. В браузере, на ПК или
            с телефона — без установки и без мощного железа.
          </p>
          {error && (
            <p className="mt-4 text-sm text-red-400">{steamLoginFailed}</p>
          )}
          <div className="mt-8">
            <SteamButton variant="primary" />
          </div>
        </section>
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
