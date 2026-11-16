// Секция лендинга у партнёрской витрины (билайн) вместо тарифов: текст про подписку у
// партнёра, ссылка на неё (если адрес известен) и кнопка входа. Цен нет.
import { useBrand } from "@/brands";
import { PlayButton } from "./PlayButton";
import { SectionHead } from "./SectionHead";

export function PartnerSubscription() {
  const brand = useBrand();
  const { monetization } = brand;
  if (monetization.kind !== "partner") return null;

  return (
    <section id="plans" className="relative py-[110px]">
      <div className="mx-auto max-w-[1180px] px-7">
        <SectionHead label="Подписка" title={monetization.title}>
          {monetization.text}
        </SectionHead>
        <div className="flex flex-wrap items-center gap-3">
          <PlayButton variant="primary" />
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
      </div>
    </section>
  );
}
