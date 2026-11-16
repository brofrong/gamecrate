// `/app/plans` у партнёрской витрины (билайн): вместо каталога тарифов и пакетов — текст
// про подписку у партнёра, ссылка на неё (если адрес известен) и блок «Ваш тариф»:
// имя и остаток минут из `account.plan`. Цен и кнопок покупки нет.
import type { PlayerPlan } from "@cg/rpc";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useBrand } from "@/brands";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMinutes } from "@/lib/planFormat";
import { useStalled } from "@/lib/useStalled";
import { accountPlanAtom } from "@/rpc";

function YourPlan({ plan }: { plan: PlayerPlan }) {
  const remaining =
    plan.remainingMinutes === null
      ? "без лимита"
      : `осталось ${formatMinutes(plan.remainingMinutes)}`;
  return (
    <section className="flex flex-col gap-1 rounded-[20px] bg-[#13161d] p-[18px]">
      <h2 className="text-sm font-medium text-[#8a90a8]">Ваш тариф</h2>
      <p className="text-lg font-semibold text-[#eef1ff]">{plan.tariff.name}</p>
      <p className="text-sm text-[#cfd3e6]">{remaining}</p>
    </section>
  );
}

export function PartnerPlansPage() {
  const brand = useBrand();
  const result = useAtomValue(accountPlanAtom);
  const reload = useAtomRefresh(accountPlanAtom);
  const [stalled, restartWait] = useStalled(AsyncResult.isInitial(result));
  const { monetization } = brand;
  if (monetization.kind !== "partner") return null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-[#eef1ff]">
        {monetization.title}
      </h1>
      <p className="max-w-[620px] text-sm leading-relaxed text-[#cfd3e6]">
        {monetization.text}
      </p>
      {monetization.url !== null && (
        <a
          href={monetization.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-10 w-fit items-center rounded-xl bg-brand-gradient px-5 text-sm font-semibold text-brand-on-accent"
        >
          {`Перейти в ${brand.name}`}
        </a>
      )}
      {AsyncResult.isFailure(result) || stalled ? (
        <ServerUnreachable
          onRetry={() => {
            restartWait();
            reload();
          }}
        />
      ) : !AsyncResult.isSuccess(result) ? (
        <Skeleton className="h-24 rounded-[20px]" />
      ) : (
        <YourPlan plan={result.value} />
      )}
    </div>
  );
}
