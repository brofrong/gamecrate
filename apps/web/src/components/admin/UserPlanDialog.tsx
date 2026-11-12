// Диалог «Тариф пользователя» (карточка в «Пользователях», спека §2/§3/§8): текущий
// тариф и остаток, «Выдать тариф» (тариф + необязательная дата окончания), «Снять
// тариф», «Начислить часы» (целые часы и комментарий; RPC `admin.users.addMinutes`
// берёт минуты — отправляем часы × 60, спека говорит о часах) и история
// выдач/начислений. Формы очищаются после успешной отправки — повторное нажатие не
// начислит второй раз. Монтируется только когда выбран
// пользователь (`UsersTab`), как `GameRequirementsPanel` для раскрытой строки —
// не держит подписку на `admin.users.plan` впустую.
import type { AdminUserPlan } from "@cg/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import * as React from "react";
import { toast } from "sonner";
import { Polled } from "@/components/admin/Polled";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMinutes } from "@/lib/formatTime";
import { formatShortDate } from "@/lib/adminFormat";
import {
  adminAddMinutesArgs,
  adminAddMinutesAtom,
  adminGrantTariffArgs,
  adminGrantTariffAtom,
  adminRevokeTariffArgs,
  adminRevokeTariffAtom,
  adminTariffsAtom,
  adminUserPlanAtom,
} from "@/rpc";

const inputClass =
  "h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

/** «Осталось: 12 ч 30 м» / «Осталось: без лимита» — остаток текущего тарифа. */
function remainingLabel(remainingMinutes: number | null): string {
  return remainingMinutes === null
    ? "Осталось: без лимита"
    : `Осталось: ${formatMinutes(remainingMinutes)}`;
}

/** Текущий тариф, остаток и даты — верх диалога. */
function CurrentPlan({ plan }: { plan: AdminUserPlan }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <span className="font-medium">{plan.tariff.name}</span>
      <span className="text-sm text-muted-foreground">
        {remainingLabel(plan.remainingMinutes)}
      </span>
      {plan.grantEndsAt !== null && (
        <span className="text-sm text-muted-foreground">
          {`Выдача действует до ${formatShortDate(plan.grantEndsAt)}`}
        </span>
      )}
      {/* Безлимит — пополнять нечего. */}
      {plan.remainingMinutes !== null && (
        <span className="text-sm text-muted-foreground">
          {`Следующее пополнение: ${formatShortDate(plan.periodEndsAt)}`}
        </span>
      )}
    </div>
  );
}

/**
 * `"YYYY-MM-DD"` (значение `<input type="date">`) → ISO конец этого дня по местному
 * времени: дата окончания выдачи включительна (ревью Task 9, round 1, Finding 2) —
 * «до 31 декабря» значит «до конца 31 декабря», а не до полуночи UTC этой даты
 * (`new Date(endsAt)` на api парсит без времени как UTC-полночь — выбор «сегодня»
 * тогда всегда попадал в прошлое и падал в `"badEnd"`). `formatShortDate` в `CurrentPlan`
 * всё равно покажет выбранный день, время суток там не отображается.
 */
function endOfLocalDay(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 23, 59, 59, 999).toISOString();
}

/** «Выдать тариф»: выбор из открытых (не скрытых) тарифов и необязательная дата окончания. */
function GrantTariffForm({
  tariffs,
  onSubmit,
}: {
  tariffs: ReadonlyArray<{ id: string; name: string }>;
  /** `true` — выдано: форма возвращается к исходным значениям. */
  onSubmit: (tariffId: string, endsAt: string | null) => Promise<boolean>;
}) {
  const [tariffId, setTariffId] = React.useState(tariffs[0]?.id ?? "");
  const [endsAt, setEndsAt] = React.useState("");

  React.useEffect(() => {
    if (tariffId === "" && tariffs.length > 0) setTariffId(tariffs[0]!.id);
  }, [tariffs, tariffId]);

  if (tariffs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Нет ни одного открытого тарифа — сначала добавьте на вкладке «Тарифы»
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (tariffId === "") return;
        void onSubmit(
          tariffId,
          endsAt.trim() === "" ? null : endOfLocalDay(endsAt),
        ).then((ok) => {
          if (!ok) return;
          setTariffId(tariffs[0]!.id);
          setEndsAt("");
        });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="plan-grant-tariff" className="text-xs font-medium text-muted-foreground">
          Тариф для выдачи
        </label>
        <select
          id="plan-grant-tariff"
          value={tariffId}
          onChange={(event) => setTariffId(event.currentTarget.value)}
          className={inputClass}
        >
          {tariffs.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="plan-grant-ends-at" className="text-xs font-medium text-muted-foreground">
          Дата окончания (пусто — бессрочно)
        </label>
        <input
          id="plan-grant-ends-at"
          type="date"
          value={endsAt}
          onChange={(event) => setEndsAt(event.currentTarget.value)}
          className={inputClass}
        />
      </div>
      <Button type="submit" variant="outline" size="sm">
        Выдать
      </Button>
    </form>
  );
}

/** «Начислить часы»: целые часы и комментарий; RPC получает минуты = часы × 60. */
function AddMinutesForm({
  onSubmit,
}: {
  /** `true` — начислено: поля очищаются. */
  onSubmit: (minutes: number, comment: string) => Promise<boolean>;
}) {
  const [hours, setHours] = React.useState("");
  const [comment, setComment] = React.useState("");

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        // Целое число больше нуля — та же проверка, что у часов в `TariffsTab`.
        const value = Number(hours);
        if (!Number.isInteger(value) || value <= 0) return;
        void onSubmit(value * 60, comment.trim()).then((ok) => {
          if (!ok) return;
          setHours("");
          setComment("");
        });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="plan-add-hours" className="text-xs font-medium text-muted-foreground">
          Часы
        </label>
        <input
          id="plan-add-hours"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          placeholder="например, 2"
          value={hours}
          onChange={(event) => setHours(event.currentTarget.value)}
          className={`${inputClass} w-28`}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="plan-add-comment" className="text-xs font-medium text-muted-foreground">
          Комментарий
        </label>
        <input
          id="plan-add-comment"
          placeholder="например, компенсация"
          value={comment}
          onChange={(event) => setComment(event.currentTarget.value)}
          className={`${inputClass} w-56`}
        />
      </div>
      <Button type="submit" variant="outline" size="sm">
        Начислить
      </Button>
    </form>
  );
}

function HistoryLists({ plan }: { plan: AdminUserPlan }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="mb-1 font-medium">Выдачи</p>
        {plan.grants.length === 0 ? (
          <p className="text-muted-foreground">Выдач не было</p>
        ) : (
          <ul className="flex flex-col gap-1 text-muted-foreground">
            {plan.grants.map((grant) => (
              <li key={grant.id}>
                {`${grant.tariffName}: с ${formatShortDate(grant.startsAt)}`}
                {grant.endsAt !== null && ` до ${formatShortDate(grant.endsAt)}`}
                {grant.grantedBy !== null && ` · выдал ${grant.grantedBy}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="mb-1 font-medium">Начисления</p>
        {plan.credits.length === 0 ? (
          <p className="text-muted-foreground">Начислений не было</p>
        ) : (
          <ul className="flex flex-col gap-1 text-muted-foreground">
            {plan.credits.map((credit) => (
              <li key={credit.id}>
                {`${formatShortDate(credit.createdAt)}: +${formatMinutes(credit.minutes)} — ${credit.comment}`}
                {credit.grantedBy !== null && ` · ${credit.grantedBy}`}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PlanContent({
  userId,
  plan,
}: {
  userId: string;
  plan: AdminUserPlan | null;
}) {
  const tariffsResult = useAtomValue(adminTariffsAtom);
  const openTariffs = AsyncResult.isSuccess(tariffsResult)
    ? tariffsResult.value.filter((t) => !t.archived)
    : [];

  const grantTariff = useAtomSet(adminGrantTariffAtom, { mode: "promiseExit" });
  const revokeTariff = useAtomSet(adminRevokeTariffAtom, { mode: "promiseExit" });
  const addMinutes = useAtomSet(adminAddMinutesAtom, { mode: "promiseExit" });

  const [error, setError] = React.useState<string | null>(null);

  const onGrant = async (tariffId: string, endsAt: string | null) => {
    setError(null);
    const exit = await grantTariff(adminGrantTariffArgs(userId, tariffId, endsAt));
    if (Exit.isFailure(exit)) {
      setError("Не удалось выдать тариф");
    } else if (exit.value === "archived") {
      setError("Тариф скрыт — его больше не выдают");
    } else if (exit.value === "badEnd") {
      setError("Дата окончания должна быть в будущем");
    } else if (exit.value === "notFound") {
      setError("Пользователь или тариф не найден");
    } else {
      toast.success("Тариф выдан");
      return true;
    }
    return false;
  };

  const onRevoke = async () => {
    const exit = await revokeTariff(adminRevokeTariffArgs(userId));
    if (Exit.isFailure(exit)) toast.error("Не удалось снять тариф");
    else if (exit.value === "none") toast.error("У пользователя нет текущей выдачи");
    else toast.success("Тариф снят — действует тариф по умолчанию");
  };

  const onAddMinutes = async (minutes: number, comment: string) => {
    const exit = await addMinutes(adminAddMinutesArgs(userId, minutes, comment));
    if (Exit.isFailure(exit)) toast.error("Не удалось начислить часы");
    else if (exit.value === "notFound") toast.error("Пользователь не найден");
    else {
      toast.success(`Начислено ${formatMinutes(minutes)}`);
      return true;
    }
    return false;
  };

  return (
    <div className="flex flex-col gap-4">
      {plan !== null && <CurrentPlan plan={plan} />}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Выдать тариф</p>
        <GrantTariffForm tariffs={openTariffs} onSubmit={onGrant} />
      </div>
      <div>
        <Button variant="outline" size="sm" onClick={() => void onRevoke()}>
          Снять тариф
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Начислить часы</p>
        <AddMinutesForm onSubmit={onAddMinutes} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {plan !== null && <HistoryLists plan={plan} />}
    </div>
  );
}

export function UserPlanDialog({
  userId,
  userName,
  open,
  onOpenChange,
}: {
  userId: string;
  userName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const result = useAtomValue(adminUserPlanAtom(userId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Тариф — ${userName}`}</DialogTitle>
        </DialogHeader>
        <Polled
          result={result}
          error="Не удалось загрузить тариф пользователя"
          skeleton={<Skeleton className="h-48 w-full" />}
        >
          {(value) => <PlanContent userId={userId} plan={value} />}
        </Polled>
      </DialogContent>
    </Dialog>
  );
}
