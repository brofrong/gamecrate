// Секция лендинга у партнёрской витрины (билайн) вместо тарифов — «сцена» в цветах бренда:
// свечение и большой знак на фоне, текст про подписку у партнёра, карточки его подписок
// (выгодная выделена, в каждой своя кнопка) и полоса «В любой подписке» — только то, что
// сервис уже даёт. Ссылка на партнёра — если адрес известен.
import { useBrand } from "@/brands";
import { PartnerPlanCards } from "@/components/brand/PartnerPlanCards";
import { partnerPerks } from "./data";
import { PlayButton } from "./PlayButton";
import { SectionHead } from "./SectionHead";

export function PartnerSubscription() {
  const brand = useBrand();
  const { monetization } = brand;
  if (monetization.kind !== "partner") return null;
  const hasPlans = monetization.plans.length > 0;

  return (
    <section id="plans" className="relative py-[110px]">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-7">
        <div className="relative isolate overflow-hidden rounded-[32px] border border-brand-cyan/25 bg-[radial-gradient(120%_90%_at_100%_0%,rgb(var(--brand-glow-rgb)/0.22),transparent_55%),radial-gradient(80%_70%_at_0%_100%,rgb(var(--brand-glow-rgb)/0.10),transparent_60%),var(--brand-card)] px-5 py-10 sm:p-12 lg:p-14">
          {/* Знак бренда на фоне — декор, без подписи. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-20 -right-24 -z-10 opacity-20 sm:-top-16 sm:-right-16 sm:opacity-35 lg:opacity-50 [filter:drop-shadow(0_0_80px_rgb(var(--brand-glow-rgb)/0.6))]"
          >
            <brand.Logo iconOnly height={380} />
          </div>

          <SectionHead label="Подписка" title={monetization.title}>
            {monetization.text}
          </SectionHead>

          <div className="max-w-[860px]">
            <PartnerPlanCards
              plans={monetization.plans}
              url={monetization.url}
              action={(plan) =>
                plan.highlight === undefined ? (
                  <PlayButton
                    variant="ghost"
                    className="h-12 w-full justify-center text-[15px]"
                  >
                    Играть
                  </PlayButton>
                ) : (
                  <PlayButton
                    variant="primary"
                    className="w-full justify-center"
                  />
                )
              }
            />
          </div>

          {(!hasPlans || monetization.url !== null) && (
            <div className="mt-10 flex flex-wrap items-center gap-3">
              {!hasPlans && <PlayButton variant="primary" />}
              {monetization.url !== null && (
                <a
                  href={monetization.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-12 items-center rounded-xl border border-white/12 bg-white/6 px-6 text-[15px] font-semibold text-brand-text hover:bg-white/10"
                >
                  {`Перейти в ${brand.name}`}
                </a>
              )}
            </div>
          )}

          <div className="mt-14 border-t border-white/8 pt-10">
            <h3
              id="partner-perks"
              className="mb-6 text-xs font-bold tracking-[0.16em] text-brand-cyan uppercase"
            >
              В любой подписке
            </h3>
            <ul
              aria-labelledby="partner-perks"
              className="grid grid-cols-1 gap-x-6 gap-y-5 min-[480px]:grid-cols-2 lg:grid-cols-4"
            >
              {partnerPerks.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-brand-cyan/25 bg-brand-cyan/10 text-brand-cyan">
                    <Icon aria-hidden="true" className="size-5" />
                  </span>
                  <span>
                    <span className="block text-[15px] font-semibold text-brand-text">
                      {title}
                    </span>
                    <span className="block text-[13px] leading-snug text-brand-muted">
                      {text}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
