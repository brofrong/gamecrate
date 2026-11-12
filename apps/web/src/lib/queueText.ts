// Строка очереди на экране загрузки вместо «Ждём свободный сервер» (дизайн §5/§7,
// спека §5): место игрока, сколько человек ждёт и оценка времени. Разделитель « · »,
// как у других составных подписей экрана загрузки (`loadingSteps.ts`).
import type { SessionQueue } from "@cg/rpc";

/**
 * Русское склонение «человек»: «человека» при остатке 2–4 по модулю 10, кроме
 * диапазона 11–14 по модулю 100 («12 человек», но «22 человека»); иначе «человек».
 */
function waitingWord(total: number): string {
  const mod10 = total % 10;
  const mod100 = total % 100;
  if (mod100 >= 11 && mod100 <= 14) return "человек";
  if (mod10 >= 2 && mod10 <= 4) return "человека";
  return "человек";
}

/**
 * Оценка времени: `null` — окно оценки не набрало данных («оцениваем…»); больше 60 —
 * «больше часа» (оркестратор отдаёт 61 ровно в этом смысле); иначе «≈ N мин».
 */
function etaPart(etaMinutes: number | null): string {
  if (etaMinutes === null) return "оцениваем…";
  if (etaMinutes > 60) return "больше часа";
  return `≈ ${etaMinutes} мин`;
}

/**
 * «Вы 3-й в очереди · ждут 7 человек · ≈ 10 мин» — вместо «Ждём свободный сервер»
 * (спека §5/§7), пока `SessionView.queue` не `null`. `position` считает самого игрока.
 */
export function queueLine(queue: SessionQueue): string {
  const { position, total, etaMinutes } = queue;
  return `Вы ${position}-й в очереди · ждут ${total} ${waitingWord(total)} · ${etaPart(etaMinutes)}`;
}
