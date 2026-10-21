// Главная для невошедшего пользователя: шапка, секции по порядку, призыв и футер.
// `error` — Better Auth вернул `/?error=…` после неудачного входа через Steam.
import { FinalCta } from "./FinalCta";
import { Hero } from "./Hero";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";

export function LandingPage({ error }: { error: boolean }) {
  return (
    <div className="landing min-h-dvh overflow-x-hidden bg-brand-bg font-sans text-brand-text antialiased">
      <LandingNav />
      <main>
        <Hero error={error} />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
