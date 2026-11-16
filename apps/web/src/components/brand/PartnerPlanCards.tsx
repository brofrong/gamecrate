// Карточки подписок партнёра (билайн) на лендинге и `/app/plans`: название, цена и плюсы
// из реестра витрины, карточка с `highlight` выделена бейджем. Подписка оформляется у
// партнёра — «Подключить» ведёт на его адрес, когда он известен; иначе кнопка карточки —
// `action` (лендинг даёт «Играть», в `/app/plans` кнопок нет).
import type * as React from "react";
import type { PartnerPlan } from "@/brands";
import { cn } from "@/lib/utils";

export function PartnerPlanCards({
  plans,
  url,
  action,
}: {
  plans: readonly PartnerPlan[];
  url: string | null;
  /** Кнопка карточки, пока адреса подписки нет. */
  action?: (plan: PartnerPlan) => React.ReactNode;
}) {
  if (plans.length === 0) return null;
  return (
    <ul
      aria-label="Подписки"
      className="grid grid-cols-1 gap-5 pt-3 sm:grid-cols-2"
    >
      {plans.map((plan) => {
        const featured = plan.highlight !== undefined;
        return (
          <li
            key={plan.name}
            className={cn(
              "relative flex flex-col rounded-3xl border p-7 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-1",
              featured
                ? "border-brand-cyan/60 bg-[linear-gradient(160deg,rgb(var(--brand-glow-rgb)/0.16),rgb(var(--brand-glow-rgb)/0.03)_55%),var(--brand-card)] shadow-[0_24px_80px_-20px_rgb(var(--brand-glow-rgb)/0.45)]"
                : "border-brand-line bg-brand-card/90 hover:border-brand-cyan/35",
            )}
          >
            {featured && (
              <div className="absolute -top-3 left-7 rounded-full bg-brand-gradient px-3 py-[5px] text-[11px] font-bold tracking-[0.06em] text-brand-on-accent uppercase shadow-[0_6px_20px_rgb(var(--brand-glow-rgb)/0.45)]">
                {plan.highlight}
              </div>
            )}
            <h3 className="mb-4 text-[22px] font-bold tracking-[-0.02em] text-brand-text">
              {plan.name}
            </h3>
            <div
              className={cn(
                "leading-none font-extrabold tracking-[-0.04em]",
                featured
                  ? "text-[56px] text-brand-cyan [text-shadow:0_0_40px_rgb(var(--brand-glow-rgb)/0.35)]"
                  : "text-[48px] text-brand-text",
              )}
            >
              {plan.price}
            </div>
            <div className="mt-2 mb-6 text-sm text-brand-muted">
              {plan.priceNote}
            </div>
            <ul className="grid flex-1 gap-3">
              {plan.perks.map((perk) => (
                <li
                  key={perk}
                  className="flex items-start gap-2.5 text-[15px] text-[#c8cbe8]"
                >
                  <i
                    aria-hidden="true"
                    className={cn(
                      "mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[12px] not-italic",
                      featured
                        ? "bg-brand-cyan/20 text-brand-cyan"
                        : "bg-brand-ok/15 text-brand-ok",
                    )}
                  >
                    ✓
                  </i>
                  <span>{perk}</span>
                </li>
              ))}
            </ul>
            {url !== null ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="mt-7 inline-flex h-12 items-center justify-center rounded-xl bg-brand-gradient px-5 text-[15px] font-semibold text-brand-on-accent"
              >
                Подключить
              </a>
            ) : (
              action && <div className="mt-7 grid">{action(plan)}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
