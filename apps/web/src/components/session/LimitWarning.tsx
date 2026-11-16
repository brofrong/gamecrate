// Предупреждение о лимите тарифа поверх стрима (спека §4/§7, бриф задачи 11): за 10 и
// за 2 минуты до `SessionView.limit.deadline` — плашка с обратным отсчётом; «Докупить»
// только при нехватке минут (`reason: "minutes"`), ведёт на страницу тарифов (заглушка
// оплаты) в новой вкладке — сессия не должна прерваться от ухода со страницы. У партнёрской
// витрины (билайн) вместо покупки — «Подписка» на ту же страницу (там подписка, без цен). Крестик
// закрывает плашку, но на отметке 2 минуты она обязательно возвращается — иначе игрок
// мог бы пропустить конец сессии. Отсчёт — тот же приём, что у `IdlePrompt`
// (подменяемые часы `now`, тик чаще секунды, чтобы цифра не «залипала»).
import type { SessionLimitView } from "@cg/rpc";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatCountdown } from "@/components/IdlePrompt";
import { useBrand } from "@/brands";
import { Button } from "@/components/ui/button";

/** Плашка видна с этого остатка до дедлайна (спека §4: «за 10 и за 2 минуты»). */
const WARN_MS = 10 * 60 * 1000;
/** На этом остатке плашка возвращается, даже если её закрыли раньше. */
const FINAL_MS = 2 * 60 * 1000;
/** Как часто обновлять отсчёт. */
const TICK_MS = 250;

export function LimitWarning({
  limit,
  now = Date.now,
}: {
  limit: SessionLimitView;
  /** Часы (подменяются в тестах). */
  now?: () => number;
}) {
  const ownPlans = useBrand().monetization.kind === "own";
  const deadlineMs = Date.parse(limit.deadline);
  const [left, setLeft] = useState(() => deadlineMs - now());
  const [dismissed, setDismissed] = useState(false);
  const wasFinal = useRef(false);

  useEffect(() => {
    setLeft(deadlineMs - now());
    const timer = setInterval(() => setLeft(deadlineMs - now()), TICK_MS);
    return () => clearInterval(timer);
  }, [deadlineMs, now]);

  const isFinal = left <= FINAL_MS;
  useEffect(() => {
    // Переход в последние 2 минуты снимает закрытие крестиком (спека §4).
    if (isFinal && !wasFinal.current) setDismissed(false);
    wasFinal.current = isFinal;
  }, [isFinal]);

  if (left > WARN_MS || dismissed) return null;

  const title =
    limit.reason === "minutes"
      ? "Часы заканчиваются — сохранитесь"
      : "Сессия скоро закончится — сохранитесь";

  return (
    <div className="fixed inset-x-0 top-4 z-30 flex justify-center px-4">
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border bg-background/95 px-4 py-2 text-sm shadow-lg"
      >
        <span className="font-medium">{title}</span>
        <span className="tabular-nums text-muted-foreground">
          {formatCountdown(Math.max(0, left))}
        </span>
        {limit.reason === "minutes" && (
          <Button asChild size="sm" variant="secondary">
            <a href="/app/plans" target="_blank" rel="noreferrer">
              {ownPlans ? "Докупить" : "Подписка"}
            </a>
          </Button>
        )}
        <button
          type="button"
          aria-label="Скрыть"
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
