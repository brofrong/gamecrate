// Форматирование времени и дат для главной `/app`: длительность сессии,
// суммарное время в игре, относительная дата последней игры и подпись/сдвиг месяца.
// Чистая логика, без React и без обращений к сети.

const MONTHS_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
] as const;

const MONTHS_FULL = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
] as const;

/** «2 ч 14 м», «2 ч», «38 м», «0 м». */
export function formatMinutes(min: number): string {
  if (min <= 0) return "0 м";
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours === 0) return `${rest} м`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} м`;
}

/** «7:40» — часы без паддинга, минуты всегда двузначные (панель и страница «Время»). */
export function formatHM(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}:${String(rest).padStart(2, "0")}`;
}

/** «14 ч в игре», «38 мин в игре», «не запускалась». */
export function formatHoursInGame(min: number): string {
  if (min <= 0) return "не запускалась";
  const hours = Math.floor(min / 60);
  return hours > 0 ? `${hours} ч в игре` : `${min} мин в игре`;
}

/** «41 ч», «38 мин», пусто при нуле — компактное значение на плитке игры (спека 2026-10-27 §3.3). */
export function formatHoursShort(min: number): string {
  if (min <= 0) return "";
  const hours = Math.floor(min / 60);
  return hours > 0 ? `${hours} ч` : `${min} мин`;
}

/** Полночь местного дня — для сравнения календарных дат без учёта времени суток. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * «сегодня», «вчера», «21 окт» (этот год), «21 окт 2025» (другой год) — по местному времени.
 */
export function formatRelativeDate(iso: string, now: Date): string {
  const date = new Date(iso);
  const diffDays = Math.round(
    (startOfLocalDay(now) - startOfLocalDay(date)) / MS_PER_DAY,
  );
  if (diffDays === 0) return "сегодня";
  if (diffDays === 1) return "вчера";
  const day = date.getDate();
  const month = MONTHS_SHORT[date.getMonth()];
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${month}`
    : `${day} ${month} ${date.getFullYear()}`;
}

/** `"2026-10"` → «Октябрь 2026». */
export function formatMonth(month: string): string {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const index = Number(monthStr) - 1;
  return `${MONTHS_FULL[index]} ${year}`;
}

/** Сдвигает `"YYYY-MM"` на `delta` месяцев, перенося год на границе января/декабря. */
export function monthShift(month: string, delta: -1 | 1): string {
  const [yearStr, monthStr] = month.split("-");
  let year = Number(yearStr);
  let m = Number(monthStr) + delta;
  if (m < 1) {
    m = 12;
    year -= 1;
  } else if (m > 12) {
    m = 1;
    year += 1;
  }
  return `${year}-${String(m).padStart(2, "0")}`;
}

/** Текущий месяц по местному времени в формате `"YYYY-MM"`. */
export function currentMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
