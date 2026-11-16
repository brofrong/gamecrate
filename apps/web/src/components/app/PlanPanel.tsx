// Панель «Тариф» на главной `/app`, рядом с `TimePanel` (дизайн §8): название тарифа,
// остаток минут («осталось 12 ч 30 мин» или «без лимита»), до какого числа действует
// выдача и когда следующее пополнение — обе даты по Москве. «Докупить» ведёт на
// страницу тарифов (`/app/plans`, заглушка оплаты); у партнёрской витрины вместо неё
// «Подписка» на ту же страницу (там подписка партнёра). `plan` не загрузился — панель пока
// не рисуется (как `ActiveSessionPanel`/`InstallsPanel` без своей сессии).
import type { PlayerPlan } from "@cg/rpc";
import { Link } from "@tanstack/react-router";
import { Ticket } from "lucide-react";
import { useBrand } from "@/brands";
import { Panel, PanelHeader } from "@/components/app/Panel";
import { Button } from "@/components/ui/button";
import { formatMinutes, formatPlanDate } from "@/lib/planFormat";

export function PlanPanel({ plan }: { plan: PlayerPlan | undefined }) {
  const { monetization } = useBrand();
  if (plan === undefined) return null;

  const remaining =
    plan.remainingMinutes === null
      ? "без лимита"
      : `осталось ${formatMinutes(plan.remainingMinutes)}`;

  return (
    <Panel>
      <PanelHeader icon={<Ticket className="size-4" />} title="Тариф" />
      <p className="text-lg font-semibold text-[#eef1ff]">{plan.tariff.name}</p>
      <p className="text-sm text-[#cfd3e6]">{remaining}</p>
      {plan.grantEndsAt !== null && (
        <p className="text-sm text-[#8a90a8]">
          до {formatPlanDate(plan.grantEndsAt)}
        </p>
      )}
      {plan.nextRefillAt !== null && (
        <p className="text-sm text-[#8a90a8]">
          пополнение {formatPlanDate(plan.nextRefillAt)}
        </p>
      )}
      <Button asChild size="sm" variant="secondary">
        <Link to="/app/plans">
          {monetization.kind === "own" ? "Докупить" : "Подписка"}
        </Link>
      </Button>
    </Panel>
  );
}
