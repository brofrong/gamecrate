// Тарифы: три карточки по часам игры. Цифры — заглушки, пока PLANS_ARE_PLACEHOLDERS.
import { cn } from "@/lib/utils";
import { PLANS_ARE_PLACEHOLDERS, plans } from "./data";
import { PlayButton } from "./PlayButton";
import { SectionHead } from "./SectionHead";

/** «1 490 ₽» — разряды через тонкий неразрывный пробел (Intl в ru-RU не делит 4 цифры). */
export const formatRub = (n: number) =>
  `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f")}\u00a0₽`;

export function Plans() {
  return (
    <section id="plans" className="relative py-[110px]">
      <div className="mx-auto max-w-[1180px] px-7">
        <SectionHead
          label="Тарифы"
          title="Платишь за часы игры"
          badge={
            PLANS_ARE_PLACEHOLDERS && (
              <span className="rounded-full border border-brand-warn/40 bg-brand-warn/10 px-2 py-0.5 text-[10px] tracking-[0.06em] text-brand-warn normal-case">
                цены и цифры — предварительные
              </span>
            )
          }
        >
          Час — это час с запуском игры и до выхода. Пока сидишь в меню сайта,
          ничего не списывается. Неиспользованные часы переносятся на следующий
          месяц.
        </SectionHead>
        <div className="grid gap-[18px] min-[900px]:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                "relative flex flex-col rounded-3xl border border-brand-line bg-brand-card p-[30px] transition-[transform,border-color] duration-200 hover:-translate-y-1 hover:border-brand-cyan/35",
                plan.popular &&
                  "border-brand-cyan/50 bg-[linear-gradient(160deg,rgb(var(--brand-glow-rgb)/0.12),rgb(var(--brand-accent-3-rgb)/0.12)),var(--brand-card)]",
              )}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-[30px] rounded-full bg-brand-gradient px-2.5 py-[5px] text-[11px] font-bold tracking-[0.06em] text-brand-on-accent">
                  ПОПУЛЯРНЫЙ
                </div>
              )}
              <h3 className="mb-1.5 text-[22px] font-bold tracking-[-0.02em]">
                {plan.name}
              </h3>
              <div className="mb-5 text-sm text-brand-muted">{plan.who}</div>
              <div className="text-[44px] leading-none font-extrabold tracking-[-0.04em]">
                {plan.hours}
                <small className="ml-1 text-[15px] font-medium tracking-normal text-brand-muted">
                  часов / мес
                </small>
              </div>
              <div className="mt-2 mb-[22px] text-sm text-brand-muted">
                {formatRub(plan.priceRub)} · {formatRub(plan.perHourRub)} за час
              </div>
              <ul className="mb-6 grid flex-1 gap-2.5">
                {plan.features.map((f) => (
                  <li
                    key={f.text}
                    className={cn(
                      "flex items-start gap-2.5 text-sm text-[#c8cbe8]",
                      !f.included && "text-[#5c6089]",
                    )}
                  >
                    <i
                      className={cn(
                        "mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[11px] not-italic",
                        f.included
                          ? "bg-brand-ok/15 text-brand-ok"
                          : "bg-white/5 text-[#5c6089]",
                      )}
                    >
                      {f.included ? "✓" : "–"}
                    </i>
                    <span>
                      {f.strong ? <b>{f.text}</b> : f.text}
                      {f.gpu && (
                        <>
                          {" "}
                          <span className="inline-block rounded bg-white/6 px-1.5 py-0.5 font-mono text-[11px] text-[#c9cdf0]">
                            {f.gpu}
                          </span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <PlayButton
                variant={plan.popular ? "primary" : "ghost"}
                className="w-full justify-center"
              >
                Выбрать
              </PlayButton>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
