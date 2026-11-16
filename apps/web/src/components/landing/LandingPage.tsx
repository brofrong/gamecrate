// Лендинг `/`: шапка, секции по порядку, призыв и футер. Открывается и вошедшему
// (владелец, 2026-10-29) — тогда кнопки ведут в `/app`, а не на `/login`.
import { useBrand } from "@/brands";
import { BrandSlot } from "@/components/brand/BrandSlot";
import { Achievements } from "./Achievements";
import { FaqChat } from "./FaqChat";
import { FinalCta } from "./FinalCta";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import { LandingAuth } from "./PlayButton";
import { PartnerSubscription } from "./PartnerSubscription";
import { Plans } from "./Plans";
import { TechFlow } from "./TechFlow";

export function LandingPage({ signedIn = false }: { signedIn?: boolean }) {
  const { monetization } = useBrand();
  return (
    <LandingAuth value={{ signedIn }}>
      <div className="landing min-h-dvh overflow-x-hidden bg-brand-bg font-sans text-brand-text antialiased">
        <LandingNav />
        <main>
          <Hero />
          <HowItWorks />
          <TechFlow />
          <BrandSlot
            name="landingPlans"
            fallback={monetization.kind === "own" ? Plans : PartnerSubscription}
          />
          <Achievements />
          <FaqChat />
          <FinalCta />
        </main>
        <LandingFooter />
      </div>
    </LandingAuth>
  );
}
