// Карточки подписок партнёра (билайн) на лендинге и `/app/plans`: название, цена и плюсы
// из реестра витрины. Подписка оформляется у партнёра — «Подключить» ведёт на его адрес и
// появляется, только когда адрес известен.
import type { PartnerPlan } from "@/brands";

export function PartnerPlanCards({
  plans,
  url,
}: {
  plans: readonly PartnerPlan[];
  url: string | null;
}) {
  if (plans.length === 0) return null;
  return (
    <ul className="grid max-w-[760px] grid-cols-1 gap-[18px] sm:grid-cols-2">
      {plans.map((plan) => (
        <li
          key={plan.name}
          className="flex flex-col rounded-3xl border border-brand-line bg-brand-card p-6"
        >
          <h3 className="mb-4 text-xl font-bold tracking-[-0.02em] text-brand-text">
            {plan.name}
          </h3>
          <div className="text-[40px] leading-none font-extrabold tracking-[-0.04em] text-brand-text">
            {plan.price}
          </div>
          <div className="mt-2 mb-5 text-sm text-brand-muted">
            {plan.priceNote}
          </div>
          <ul className="grid flex-1 gap-2.5">
            {plan.perks.map((perk) => (
              <li
                key={perk}
                className="flex items-start gap-2.5 text-sm text-[#c8cbe8]"
              >
                <i
                  aria-hidden="true"
                  className="mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-brand-ok/15 text-[11px] text-brand-ok not-italic"
                >
                  ✓
                </i>
                <span>{perk}</span>
              </li>
            ))}
          </ul>
          {url !== null && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-brand-gradient px-5 text-sm font-semibold text-brand-on-accent"
            >
              Подключить
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
