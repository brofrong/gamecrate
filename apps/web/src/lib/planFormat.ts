// Форматирование плана тарифа игрока (дизайн §8, карточка `/app` и страница тарифов):
// остаток минут словами и даты по Москве. Отдельно от `lib/formatTime.ts` — там
// `formatMinutes` сокращает до букв («2 ч 14 м», сводка времени), здесь — до слов
// («12 ч 30 мин», «45 мин»), как того просит бриф задачи.
import type { PublicTariff } from "@cg/rpc";

/** «12 ч 30 мин», «40 ч», «45 мин», «0 мин» — остаток минут плана. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** «d MMMM» в московском времени (`grantEndsAt`/`nextRefillAt`) — датам игрока в §7. */
const planDateFormatter = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "long",
});

/** «10 декабря» — дата по Москве, независимо от часового пояса браузера. */
export function formatPlanDate(iso: string): string {
  return planDateFormatter.format(new Date(iso));
}

/**
 * Приоритет тарифа словами (дизайн §8, карточки `PlansPage`): самый высокий приоритет
 * среди каталога — «Без очереди», выше минимального — «Приоритет в очереди», иначе
 * (минимальный приоритет каталога) — «Общая очередь». Каталог может не включать сам
 * `tariff` (архивный тариф пользователя, снятый с продажи) — тогда сравнение идёт с его
 * собственным приоритетом как границей.
 */
export function tariffPriorityLabel(
  tariff: PublicTariff,
  tariffs: ReadonlyArray<PublicTariff>,
): string {
  const priorities = tariffs.map((t) => t.queuePriority);
  const max = Math.max(tariff.queuePriority, ...priorities);
  const min = Math.min(tariff.queuePriority, ...priorities);
  if (tariff.queuePriority === max) return "Без очереди";
  if (tariff.queuePriority > min) return "Приоритет в очереди";
  return "Общая очередь";
}
