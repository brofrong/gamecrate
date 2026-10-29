// Лендинг `/`: шапка, секции по порядку, призыв и футер. Открывается и вошедшему
// (владелец, 2026-10-29) — тогда кнопки ведут в `/app`, а не на `/login`.
import { Achievements } from "./Achievements";
import { FaqChat } from "./FaqChat";
import { FinalCta } from "./FinalCta";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import { LandingAuth } from "./PlayButton";
import { Plans } from "./Plans";
import { TechFlow } from "./TechFlow";

export function LandingPage({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <LandingAuth value={{ signedIn }}>
      <div className="landing min-h-dvh overflow-x-hidden bg-brand-bg font-sans text-brand-text antialiased">
        <LandingNav />
        <main>
          <Hero />
          <TechFlow />
          <HowItWorks />
          <Plans />
          <Achievements />
          <FaqChat />
          <FinalCta />
        </main>
        <LandingFooter />
      </div>
    </LandingAuth>
  );
}
