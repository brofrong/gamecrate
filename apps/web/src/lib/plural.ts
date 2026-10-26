// Склонение числительных по русским правилам — подписи карточек «В тренде»
// («N играют»/«N игроков», спека §4.2). Последняя цифра решает форму, кроме
// исключения 11–14 (всегда «many»): 1 → one, 2–4 → few, 0 и 5–9 (и 11–14) → many.
// Для глаголов (`играет`/`играют`) few и many — один и тот же аргумент.
export function pluralize(
  n: number,
  one: string,
  few: string,
  many: string,
): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
