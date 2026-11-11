/**
 * Остаток минут по тарифу (спека 2026-11-10 §3 «Учёт минут»). Чистый модуль:
 * без Effect-сервисов и I/O — выдачи, начисления, отрезки игры и текущее время
 * передаются аргументами, загрузку из БД делает вызывающий код.
 *
 * Модель:
 * - **Полосы.** Время делится на полосы тарифа: выдачи (якорь периодов — их
 *   `startsAt`) и промежутки без выдачи — тариф по умолчанию (якорь —
 *   `userCreatedAt`).
 * - **Периоды.** Период `k` полосы — `[addMonthsClamped(anchor, k),
 *   addMonthsClamped(anchor, k + 1))`, пересечённый с полосой. Границы всегда
 *   считаются от якоря, не цепочкой: якорь 31 января даёт 29 февраля, а потом
 *   снова 31 марта.
 * - **Корзины.** Период лимитного тарифа даёт корзину на `monthlyMinutes`
 *   минут от своего начала до конца периода по якорю (с переносом — до конца
 *   следующего). Срок не обрезается концом полосы: при смене тарифа минуты
 *   старого доживают до своего срока. Ручное начисление — корзина без срока.
 * - **Списание.** Отрезки игры режутся по всем границам, каждый кусок
 *   списывается из действующих корзин в порядке срока (бессрочные последними).
 *   В безлимитной полосе кусок не списывается вовсе. Чего не хватило, уходит в
 *   долг: его гасит новая корзина того же периода (ручное начисление), а в
 *   начале каждого периода долг обнуляется — так смена тарифа по умолчанию с
 *   безлимита на лимит не делает долга за прошлые месяцы.
 */
import type { StreamResolution } from "@cg/rpc";

/** Лимиты тарифа, которые нужны расчёту остатка и ограничениям сессии. */
export type TariffLimits = {
  readonly id: string;
  readonly name: string;
  readonly queuePriority: number;
  /** `null` — безлимит. */
  readonly monthlyMinutes: number | null;
  readonly rollover: boolean;
  readonly maxResolution: StreamResolution;
  readonly maxBitrateMbps: number;
  /** `null` — без лимита длины сессии. */
  readonly maxSessionMinutes: number | null;
};

/**
 * Встроенный тариф на случай, когда тариф по умолчанию в БД не нашёлся: те же
 * значения, что сеет миграция («Базовый», безлимит). Никогда не запрет игры.
 */
export const FALLBACK_TARIFF: TariffLimits = {
  id: "fallback",
  name: "Базовый",
  queuePriority: 0,
  monthlyMinutes: null,
  rollover: false,
  maxResolution: "1440p",
  maxBitrateMbps: 40,
  maxSessionMinutes: null,
};

/** Выдача тарифа: действует в `[startsAt, endsAt)`, `endsAt = null` — бессрочно. */
export type GrantSpan = {
  readonly tariff: TariffLimits;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
};

/** Ручное начисление `minutes` минут в момент `at`; не сгорает. */
export type Credit = { readonly minutes: number; readonly at: Date };

/**
 * Оплачиваемый отрезок игры. У ещё открытого отрезка `endedAt` — сейчас;
 * часть после `now` не учитывается.
 */
export type Usage = { readonly startedAt: Date; readonly endedAt: Date };

export type BalanceInput = {
  readonly userCreatedAt: Date;
  readonly defaultTariff: TariffLimits;
  /** Не пересекаются (пересечение обрезается по началу следующей). */
  readonly grants: ReadonlyArray<GrantSpan>;
  readonly credits: ReadonlyArray<Credit>;
  readonly usage: ReadonlyArray<Usage>;
  readonly now: Date;
};

export type Balance = {
  /** Действующий сейчас тариф. */
  readonly tariff: TariffLimits;
  /** Конец действующей выдачи; `null` — бессрочно или тариф по умолчанию. */
  readonly grantEndsAt: Date | null;
  /** Конец текущего периода (в пределах полосы) = следующее пополнение. */
  readonly periodEndsAt: Date;
  /** `null` — безлимит; может быть меньше нуля (долг между тиками). */
  readonly remainingMs: number | null;
};

/**
 * Якорь плюс `months` календарных месяцев в UTC. Если такого дня в целевом
 * месяце нет, берётся последний день месяца (31 января + 1 → 29 февраля
 * 2028). Время суток сохраняется. Считать всегда от якоря, не цепочкой.
 */
export const addMonthsClamped = (anchor: Date, months: number): Date => {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  // День 0 следующего месяца — последний день целевого (Date.UTC нормализует).
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
};

/** Полоса тарифа `[start, end)`; `end = null` — без конца. */
type Band = {
  readonly tariff: TariffLimits;
  readonly start: number;
  readonly end: number | null;
  readonly anchor: Date;
  /** Конец выдачи для `Balance.grantEndsAt`; у полосы по умолчанию `null`. */
  readonly grantEndsAt: Date | null;
};

type Bucket = {
  readonly start: number;
  /** `null` — бессрочная (ручное начисление). */
  readonly expiresAt: number | null;
  left: number;
};

/**
 * Событие в момент `at`. В один момент применяются по `order`: сначала начало
 * периода (обнуляет долг), затем начисления (гасят долг), затем отрезки игры.
 */
type TimelineEvent =
  | {
      readonly at: number;
      readonly order: 0;
      readonly unlimited: boolean;
      readonly bucket: Bucket | null;
    }
  | { readonly at: number; readonly order: 1; readonly bucket: Bucket }
  | { readonly at: number; readonly order: 2; readonly delta: 1 | -1 };

const boundary = (anchor: Date, k: number) =>
  addMonthsClamped(anchor, k).getTime();

/** Номер периода по якорю, в который попадает момент `t` (может быть < 0). */
const periodIndex = (anchor: Date, t: number): number => {
  const at = new Date(t);
  let k =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (at.getUTCMonth() - anchor.getUTCMonth());
  while (boundary(anchor, k) > t) k--;
  while (boundary(anchor, k + 1) <= t) k++;
  return k;
};

/**
 * Текущий период тарифа по умолчанию в момент `input.now` (якорь — `userCreatedAt`):
 * запасной вариант `computeBalance`, если ни одна полоса не накрыла `now`. При
 * корректных датах так не бывает, но анти-цель спеки — никогда не запрет игры,
 * поэтому вместо ошибки (сессия бы не запустилась, тик оркестратора упал бы) —
 * тариф по умолчанию.
 */
export const defaultPeriodAt = (
  input: BalanceInput,
): { readonly tariff: TariffLimits; readonly periodEndsAt: Date } => {
  const k = periodIndex(input.userCreatedAt, input.now.getTime());
  return {
    tariff: input.defaultTariff,
    periodEndsAt: new Date(boundary(input.userCreatedAt, k + 1)),
  };
};

/**
 * Полосы от `origin` без конца: выдачи по возрастанию начала, промежутки
 * между ними — тариф по умолчанию.
 */
const buildBands = (input: BalanceInput, origin: number): Band[] => {
  const grants = [...input.grants].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const bands: Band[] = [];
  const pushDefault = (start: number, end: number | null) => {
    if (end !== null && end <= start) return;
    bands.push({
      tariff: input.defaultTariff,
      start,
      end,
      anchor: input.userCreatedAt,
      grantEndsAt: null,
    });
  };
  let cursor = origin;
  for (const grant of grants) {
    const start = Math.max(grant.startsAt.getTime(), cursor);
    const end = grant.endsAt?.getTime() ?? null;
    if (end !== null && end <= start) continue;
    pushDefault(cursor, start);
    bands.push({
      tariff: grant.tariff,
      start,
      end,
      anchor: grant.startsAt,
      grantEndsAt: grant.endsAt,
    });
    if (end === null) return bands;
    cursor = end;
  }
  pushDefault(cursor, null);
  return bands;
};

/** Списать `amount` мс в момент `t`; возвращает, сколько не хватило. */
const charge = (buckets: Bucket[], t: number, amount: number): number => {
  const active = buckets
    .filter(
      (b) =>
        b.left > 0 && b.start <= t && (b.expiresAt === null || t < b.expiresAt),
    )
    .sort(
      (a, b) =>
        (a.expiresAt ?? Number.POSITIVE_INFINITY) -
          (b.expiresAt ?? Number.POSITIVE_INFINITY) || a.start - b.start,
    );
  let rest = amount;
  for (const b of active) {
    if (rest === 0) break;
    const take = Math.min(b.left, rest);
    b.left -= take;
    rest -= take;
  }
  return rest;
};

/**
 * Остаток минут в момент `input.now`: действующий тариф, конец выдачи и
 * периода и остаток в мс (`null` — безлимит). Алгоритм — в комментарии к
 * модулю: события (начала периодов, начисления, концы отрезков игры)
 * проходятся по времени, между соседними границами (включая сроки корзин)
 * списание идёт кусками.
 */
export const computeBalance = (input: BalanceInput): Balance => {
  const now = input.now.getTime();
  const usage = input.usage
    .map((u) => ({
      start: u.startedAt.getTime(),
      end: Math.min(u.endedAt.getTime(), now),
    }))
    .filter((u) => u.end > u.start);
  const credits = input.credits.filter((c) => c.at.getTime() <= now);
  const origin = Math.min(
    input.userCreatedAt.getTime(),
    now,
    ...usage.map((u) => u.start),
    ...credits.map((c) => c.at.getTime()),
  );
  const bands = buildBands(input, origin);

  const events: TimelineEvent[] = [];
  const boundaries = new Set<number>([now]);
  let current: { band: Band; periodEnd: number } | null = null;

  for (const band of bands) {
    if (band.start > now) break;
    const limit = band.tariff.monthlyMinutes;
    const span = band.tariff.rollover ? 2 : 1;
    for (let k = periodIndex(band.anchor, band.start); ; k++) {
      const start = Math.max(boundary(band.anchor, k), band.start);
      if (start > now || (band.end !== null && start >= band.end)) break;
      const next = boundary(band.anchor, k + 1);
      let bucket: Bucket | null = null;
      if (limit !== null) {
        const expiresAt = boundary(band.anchor, k + span);
        bucket = { start, expiresAt, left: limit * 60_000 };
        boundaries.add(expiresAt);
      }
      events.push({ at: start, order: 0, unlimited: limit === null, bucket });
      boundaries.add(start);
      if (now < next && (band.end === null || now < band.end)) {
        current = {
          band,
          periodEnd: band.end === null ? next : Math.min(next, band.end),
        };
      }
    }
  }

  for (const c of credits) {
    const at = c.at.getTime();
    const bucket: Bucket = {
      start: at,
      expiresAt: null,
      left: c.minutes * 60_000,
    };
    events.push({ at, order: 1, bucket });
    boundaries.add(at);
  }
  for (const u of usage) {
    events.push({ at: u.start, order: 2, delta: 1 });
    events.push({ at: u.end, order: 2, delta: -1 });
    boundaries.add(u.start);
    boundaries.add(u.end);
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);

  // `origin <= now` и полосы покрывают время от `origin`, так что текущий
  // период находится всегда; иначе — тариф по умолчанию (`defaultPeriodAt`),
  // не ошибка.
  if (current === null) {
    const fallback = defaultPeriodAt(input);
    current = {
      band: {
        tariff: fallback.tariff,
        start: now,
        end: null,
        anchor: input.userCreatedAt,
        grantEndsAt: null,
      },
      periodEnd: fallback.periodEndsAt.getTime(),
    };
  }

  const times = [...boundaries].filter((t) => t <= now).sort((a, b) => a - b);
  const buckets: Bucket[] = [];
  let debt = 0;
  let unlimited = false;
  let playing = 0;
  let e = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i] as number;
    for (; e < events.length && (events[e] as TimelineEvent).at <= t; e++) {
      const ev = events[e] as TimelineEvent;
      if (ev.order === 2) {
        playing += ev.delta;
        continue;
      }
      if (ev.order === 0) {
        debt = 0;
        unlimited = ev.unlimited;
      }
      if (ev.bucket !== null) {
        const pay = Math.min(debt, ev.bucket.left);
        ev.bucket.left -= pay;
        debt -= pay;
        buckets.push(ev.bucket);
      }
    }
    const next = times[i + 1];
    if (next === undefined || playing === 0 || unlimited) continue;
    debt += charge(buckets, t, playing * (next - t));
  }

  const { band, periodEnd } = current;
  const remainingMs =
    band.tariff.monthlyMinutes === null
      ? null
      : buckets
          .filter(
            (b) =>
              b.start <= now && (b.expiresAt === null || now < b.expiresAt),
          )
          .reduce((sum, b) => sum + b.left, 0) - debt;
  return {
    tariff: band.tariff,
    grantEndsAt: band.grantEndsAt,
    periodEndsAt: new Date(periodEnd),
    remainingMs,
  };
};
