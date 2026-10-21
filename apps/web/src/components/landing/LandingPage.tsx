// Главная для невошедшего пользователя: шапка, секции по порядку, призыв и футер.
// `error` — Better Auth вернул `/?error=…` после неудачного входа через Steam.
import { Achievements } from "./Achievements";
import { FaqChat } from "./FaqChat";
import { FinalCta } from "./FinalCta";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import { Plans } from "./Plans";
import { TechFlow } from "./TechFlow";

export function LandingPage({ error }: { error: boolean }) {
  return (
    <div className="landing min-h-dvh overflow-x-hidden bg-brand-bg font-sans text-brand-text antialiased">
      <LandingNav />
      <main>
        <Hero error={error} />
        <TechFlow />
        <HowItWorks />
        <Plans />
        <Achievements />
        <FaqChat />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
