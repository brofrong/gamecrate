import { describe, expect, it } from "bun:test";
import {
  type BalanceInput,
  computeBalance,
  FALLBACK_TARIFF,
  type TariffLimits,
  type Usage,
} from "../src/minutes";

/** Минуты в миллисекунды — так считает `remainingMs`. */
const min = (n: number) => n * 60_000;

const d = (iso: string) => new Date(iso);

/** Тариф на базе встроенного с переопределёнными полями. */
const tariff = (over: Partial<TariffLimits>): TariffLimits => ({
  ...FALLBACK_TARIFF,
  id: "t",
  name: "Тест",
  ...over,
});

/** Отрезок игры длиной `minutes`, начиная с `from`. */
const use = (from: string, minutes: number): Usage => ({
  startedAt: d(from),
  endedAt: new Date(d(from).getTime() + min(minutes)),
});

const limited600 = tariff({ id: "l600", name: "600", monthlyMinutes: 600 });

/** Пользователь с одной бессрочной выдачей `t` от 10 января 2028. */
const withGrant = (
  t: TariffLimits,
  rest: Partial<BalanceInput> & { now: Date },
): BalanceInput => ({
  userCreatedAt: d("2028-01-10T00:00:00Z"),
  defaultTariff: FALLBACK_TARIFF,
  grants: [{ tariff: t, startsAt: d("2028-01-10T00:00:00Z"), endsAt: null }],
  credits: [],
  usage: [],
  ...rest,
});

describe("computeBalance", () => {
  it("no grants, unlimited default → remainingMs null, tariff = default", () => {
    const b = computeBalance({
      userCreatedAt: d("2028-01-10T00:00:00Z"),
      defaultTariff: FALLBACK_TARIFF,
      grants: [],
      credits: [],
      usage: [use("2028-01-12T10:00:00Z", 500)],
      now: d("2028-01-20T00:00:00Z"),
    });
    expect(b.remainingMs).toBeNull();
    expect(b.tariff).toBe(FALLBACK_TARIFF);
    expect(b.grantEndsAt).toBeNull();
    expect(b.periodEndsAt).toEqual(d("2028-02-10T00:00:00Z"));
  });

  it("limited grant 600 min, used 100 → 500 min", () => {
    const b = computeBalance(
      withGrant(limited600, {
        usage: [use("2028-01-12T10:00:00Z", 100)],
        now: d("2028-01-20T00:00:00Z"),
      }),
    );
    expect(b.remainingMs).toBe(min(500));
    expect(b.tariff).toBe(limited600);
    expect(b.grantEndsAt).toBeNull();
    expect(b.periodEndsAt).toEqual(d("2028-02-10T00:00:00Z"));
  });

  it("no rollover: unused 300 of previous period is lost → 600 − used this period", () => {
    const b = computeBalance(
      withGrant(limited600, {
        usage: [
          use("2028-01-12T10:00:00Z", 300),
          use("2028-02-15T10:00:00Z", 50),
        ],
        now: d("2028-02-20T00:00:00Z"),
      }),
    );
    expect(b.remainingMs).toBe(min(550));
  });

  it("rollover: previous unused 300 → 900; spending 200 takes rollover first; leftover 100 expires at the next boundary", () => {
    const t = tariff({ monthlyMinutes: 600, rollover: true });
    const period0 = use("2028-01-12T10:00:00Z", 300);
    const spend = use("2028-02-15T10:00:00Z", 200);
    const at = (now: string, usage: Usage[]) =>
      computeBalance(withGrant(t, { usage, now: d(now) })).remainingMs;

    expect(at("2028-02-12T00:00:00Z", [period0])).toBe(min(900));
    expect(at("2028-02-20T00:00:00Z", [period0, spend])).toBe(min(700));
    // Перенос 300 − 200 = 100 сгорает 10 марта; остаются 600 февраля
    // (перенос) и 600 марта. Если бы 200 ушли из февральских, было бы 1300 − 100.
    expect(at("2028-03-15T00:00:00Z", [period0, spend])).toBe(min(1200));
  });

  it("rollover only one month: leftovers of period 0 do not reach period 2", () => {
    const t = tariff({ monthlyMinutes: 600, rollover: true });
    const b = computeBalance(withGrant(t, { now: d("2028-03-15T00:00:00Z") }));
    expect(b.remainingMs).toBe(min(1200));
  });

  it("manual credit spent last and never expires", () => {
    const t = tariff({ monthlyMinutes: 60 });
    const input = (now: string) =>
      withGrant(t, {
        credits: [{ minutes: 120, at: d("2028-01-11T00:00:00Z") }],
        usage: [use("2028-01-12T10:00:00Z", 90)],
        now: d(now),
      });
    expect(computeBalance(input("2028-01-20T00:00:00Z")).remainingMs).toBe(
      min(90),
    );
    expect(computeBalance(input("2028-02-15T00:00:00Z")).remainingMs).toBe(
      min(60 + 90),
    );
  });

  it("debt within period is paid by a later credit", () => {
    const input = (now: string) =>
      withGrant(limited600, {
        credits: [{ minutes: 30, at: d("2028-01-16T00:00:00Z") }],
        usage: [use("2028-01-12T00:00:00Z", 610)],
        now: d(now),
      });
    expect(computeBalance(input("2028-01-15T00:00:00Z")).remainingMs).toBe(
      min(-10),
    );
    expect(computeBalance(input("2028-01-20T00:00:00Z")).remainingMs).toBe(
      min(20),
    );
  });

  it("debt resets at period start", () => {
    const b = computeBalance(
      withGrant(limited600, {
        usage: [use("2028-01-12T00:00:00Z", 610)],
        now: d("2028-02-15T00:00:00Z"),
      }),
    );
    expect(b.remainingMs).toBe(min(600));
  });

  it("default tariff changed from unlimited to 600 min: past months create no debt", () => {
    const b = computeBalance({
      userCreatedAt: d("2027-06-05T00:00:00Z"),
      defaultTariff: limited600,
      grants: [],
      credits: [],
      usage: [
        use("2027-07-10T00:00:00Z", 2000),
        use("2027-08-10T00:00:00Z", 2000),
        use("2027-12-10T00:00:00Z", 2000),
        use("2028-01-10T00:00:00Z", 100),
      ],
      now: d("2028-01-20T00:00:00Z"),
    });
    expect(b.tariff).toBe(limited600);
    expect(b.remainingMs).toBe(min(500));
    expect(b.periodEndsAt).toEqual(d("2028-02-05T00:00:00Z"));
  });

  it("tariff switch mid-period keeps old leftovers until their expiry and starts a new anchor", () => {
    const a = tariff({ id: "a", name: "A", monthlyMinutes: 600 });
    const bT = tariff({ id: "b", name: "B", monthlyMinutes: 300 });
    const input = (now: string): BalanceInput => ({
      userCreatedAt: d("2028-01-10T00:00:00Z"),
      defaultTariff: FALLBACK_TARIFF,
      grants: [
        {
          tariff: a,
          startsAt: d("2028-01-10T00:00:00Z"),
          endsAt: d("2028-01-25T00:00:00Z"),
        },
        { tariff: bT, startsAt: d("2028-01-25T00:00:00Z"), endsAt: null },
      ],
      credits: [],
      usage: [
        use("2028-01-12T10:00:00Z", 100),
        use("2028-01-27T10:00:00Z", 200),
      ],
      now: d(now),
    });

    // A: 600 − 100 − 200 (сгорает раньше B) = 300 до 10 фев; B: 300 до 25 фев.
    const mid = computeBalance(input("2028-01-28T00:00:00Z"));
    expect(mid.tariff).toBe(bT);
    expect(mid.grantEndsAt).toBeNull();
    expect(mid.remainingMs).toBe(min(600));
    expect(mid.periodEndsAt).toEqual(d("2028-02-25T00:00:00Z"));

    // Остаток A сгорел 10 февраля, B не тронут.
    const later = computeBalance(input("2028-02-12T00:00:00Z"));
    expect(later.remainingMs).toBe(min(300));
  });

  it("anchor on Jan 31 → periods end Feb 29 2028 and Mar 31 2028", () => {
    const t = tariff({ monthlyMinutes: 600 });
    const input = (now: string): BalanceInput => ({
      userCreatedAt: d("2028-01-01T00:00:00Z"),
      defaultTariff: FALLBACK_TARIFF,
      grants: [
        { tariff: t, startsAt: d("2028-01-31T10:00:00Z"), endsAt: null },
      ],
      credits: [],
      usage: [],
      now: d(now),
    });
    expect(computeBalance(input("2028-02-10T00:00:00Z")).periodEndsAt).toEqual(
      d("2028-02-29T10:00:00Z"),
    );
    // Граница считается от якоря, а не от 29 февраля.
    expect(computeBalance(input("2028-03-05T00:00:00Z")).periodEndsAt).toEqual(
      d("2028-03-31T10:00:00Z"),
    );
  });

  it("unlimited grant does not consume manual credits", () => {
    const unlimited = tariff({ id: "u", name: "Безлимит" });
    const def = tariff({ id: "def", name: "По умолчанию", monthlyMinutes: 60 });
    const input = (now: string): BalanceInput => ({
      userCreatedAt: d("2028-01-10T00:00:00Z"),
      defaultTariff: def,
      grants: [
        {
          tariff: unlimited,
          startsAt: d("2028-01-10T00:00:00Z"),
          endsAt: d("2028-01-25T00:00:00Z"),
        },
      ],
      credits: [{ minutes: 120, at: d("2028-01-11T00:00:00Z") }],
      usage: [use("2028-01-12T10:00:00Z", 500)],
      now: d(now),
    });
    expect(
      computeBalance(input("2028-01-20T00:00:00Z")).remainingMs,
    ).toBeNull();
    // После выдачи — тариф по умолчанию: его 60 минут плюс нетронутые 120.
    const after = computeBalance(input("2028-01-26T00:00:00Z"));
    expect(after.tariff).toBe(def);
    expect(after.remainingMs).toBe(min(60 + 120));
  });

  it("ended grant → default tariff, grantEndsAt null", () => {
    const input = (now: string): BalanceInput => ({
      userCreatedAt: d("2028-01-10T00:00:00Z"),
      defaultTariff: FALLBACK_TARIFF,
      grants: [
        {
          tariff: limited600,
          startsAt: d("2028-01-10T00:00:00Z"),
          endsAt: d("2028-01-20T00:00:00Z"),
        },
      ],
      credits: [],
      usage: [],
      now: d(now),
    });
    const during = computeBalance(input("2028-01-15T00:00:00Z"));
    expect(during.tariff).toBe(limited600);
    expect(during.grantEndsAt).toEqual(d("2028-01-20T00:00:00Z"));

    const after = computeBalance(input("2028-01-25T00:00:00Z"));
    expect(after.tariff).toBe(FALLBACK_TARIFF);
    expect(after.grantEndsAt).toBeNull();
    expect(after.remainingMs).toBeNull();
  });

  it("open usage up to now counts", () => {
    const now = d("2028-01-12T11:00:00Z");
    const b = computeBalance(
      withGrant(limited600, {
        usage: [{ startedAt: d("2028-01-12T10:00:00Z"), endedAt: now }],
        now,
      }),
    );
    expect(b.remainingMs).toBe(min(540));
  });
});
