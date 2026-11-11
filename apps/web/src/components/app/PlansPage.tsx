// Страница тарифов-заглушка `/app/plans` (дизайн §8, спека §7): плашка «Оплата на
// сайте скоро появится», карточки открытых тарифов (цена, приоритет словами, часы,
// качество, длина сессии; свой тариф отмечен), список пакетов часов. Кнопок покупки
// нет — оплата появится позже. Данные — `account.plan` (каталог без архивных,
// спека §2); сам атом читается здесь, как в других страницах `/app` (`CratePage`,
// `TimePage`, `TrendingPage`), а не передаётся пропом.
import type { HourPack, PlayerPlan, PublicTariff } from "@cg/rpc";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerUnreachable } from "@/components/ServerUnreachable";
import { formatMinutes, tariffPriorityLabel } from "@/lib/planFormat";
import { useStalled } from "@/lib/useStalled";
import { cn } from "@/lib/utils";
import { accountPlanAtom } from "@/rpc";

/** Цена тарифа — помесячно. */
const priceLabel = (priceRub: number | null) =>
  priceRub === null ? "—" : `${priceRub} ₽/мес`;

/** Цена пакета часов — разовая покупка. */
const packPriceLabel = (priceRub: number | null) =>
  priceRub === null ? "—" : `${priceRub} ₽`;

const hoursLabel = (monthlyMinutes: number | null) =>
  monthlyMinutes === null ? "безлимит" : formatMinutes(monthlyMinutes);

const sessionLengthLabel = (maxSessionMinutes: number | null) =>
  maxSessionMinutes === null ? "без лимита" : formatMinutes(maxSessionMinutes);

const qualityLabel = (tariff: PublicTariff) =>
  `${tariff.maxResolution} · ${tariff.maxBitrateMbps} Мбит/с`;

function TariffCard({
  tariff,
  tariffs,
  current,
}: {
  tariff: PublicTariff;
  tariffs: ReadonlyArray<PublicTariff>;
  current: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[20px] bg-[#13161d] p-[18px]",
        current && "ring-2 ring-brand-cyan",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-bold text-[#eef1ff]">{tariff.name}</h3>
        {current && <Badge>Текущий</Badge>}
      </div>
      <p className="text-xl font-bold text-[#eef1ff]">
        {priceLabel(tariff.priceRub)}
      </p>
      <p className="text-sm text-[#8a90a8]">
        {tariffPriorityLabel(tariff, tariffs)}
      </p>
      <p className="text-sm text-[#cfd3e6]">{hoursLabel(tariff.monthlyMinutes)}</p>
      <p className="text-sm text-[#cfd3e6]">{qualityLabel(tariff)}</p>
      <p className="text-sm text-[#cfd3e6]">
        {sessionLengthLabel(tariff.maxSessionMinutes)}
      </p>
    </div>
  );
}

function HourPackRow({ hourPack }: { hourPack: HourPack }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/5 py-2 first:border-t-0">
      <span className="font-medium text-[#eef1ff]">{hourPack.name}</span>
      <span className="text-sm text-[#8a90a8]">
        {formatMinutes(hourPack.minutes)}
      </span>
      <span className="text-sm text-[#8a90a8]">
        {packPriceLabel(hourPack.priceRub)}
      </span>
    </div>
  );
}

function PlansContent({ plan }: { plan: PlayerPlan }) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plan.tariffs.map((tariff) => (
          <TariffCard
            key={tariff.id}
            tariff={tariff}
            tariffs={plan.tariffs}
            current={tariff.id === plan.tariff.id}
          />
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-[20px] bg-[#13161d] p-[18px]">
        <h2 className="text-lg font-bold text-[#eef1ff]">Пакеты часов</h2>
        {plan.hourPacks.length === 0 ? (
          <p className="text-sm text-[#8a90a8]">Пакетов часов пока нет</p>
        ) : (
          <div className="flex flex-col">
            {plan.hourPacks.map((hourPack) => (
              <HourPackRow key={hourPack.id} hourPack={hourPack} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function PlansSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={`plan-skeleton-${i}`} className="h-48 rounded-[20px]" />
      ))}
    </div>
  );
}

export function PlansPage() {
  const result = useAtomValue(accountPlanAtom);
  const reload = useAtomRefresh(accountPlanAtom);
  const [stalled, restartWait] = useStalled(AsyncResult.isInitial(result));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-[#eef1ff]">Тарифы</h1>
      <div className="rounded-[20px] border border-brand-cyan/40 bg-brand-cyan/10 px-4 py-3 text-sm text-brand-text">
        Оплата на сайте скоро появится
      </div>
      {AsyncResult.isFailure(result) || stalled ? (
        <ServerUnreachable
          onRetry={() => {
            restartWait();
            reload();
          }}
        />
      ) : !AsyncResult.isSuccess(result) ? (
        <PlansSkeleton />
      ) : (
        <PlansContent plan={result.value} />
      )}
    </div>
  );
}
