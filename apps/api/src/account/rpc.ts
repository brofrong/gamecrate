// Хендлер группы `account.*`: тариф и остаток минут текущего игрока (спека
// §2, §3) — действующий тариф с остатком и сроками, каталог не скрытых
// тарифов и пакетов часов (на будущую покупку). Эффективный тариф (полный
// `Tariff` с `priceRub`, которого нет в `TariffLimits`/`loadBalance`) берёт
// общий `loadEffectiveTariff` (`admin/tariffs.ts`) — та же функция, что и у
// `admin.users.plan`, маппинг `FALLBACK_TARIFF` не дублируется.
import { Db, hourPacks, loadBalance, tariffs } from "@cg/db";
import {
  AccountRpcs,
  CurrentUser,
  type PlayerPlan,
  toPublicTariff,
} from "@cg/rpc";
import { asc, isNull } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { loadEffectiveTariff, toHourPack, toTariff } from "../admin/tariffs";

/** Не архивные тарифы, по возрастанию приоритета очереди (спека §2). */
const publicTariffs = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select()
      .from(tariffs)
      .where(isNull(tariffs.archivedAt))
      .orderBy(asc(tariffs.queuePriority), asc(tariffs.name));
    return rows.map((row) => toPublicTariff(toTariff(row)));
  }).pipe(Effect.orDie);

/** Не архивные пакеты часов (докупка сверх тарифа, спека §1.3). */
const publicHourPacks = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db
      .select()
      .from(hourPacks)
      .where(isNull(hourPacks.archivedAt))
      .orderBy(asc(hourPacks.name));
    return rows.map(toHourPack);
  }).pipe(Effect.orDie);

export const AccountRpcHandlers = AccountRpcs.toLayer({
  "account.plan": () =>
    Effect.gen(function* () {
      const current = yield* CurrentUser;
      const now = yield* DateTime.nowAsDate;
      const balance = yield* loadBalance(current.id, now);
      const tariff = yield* loadEffectiveTariff(balance.tariff.id);
      const remainingMinutes =
        balance.remainingMs === null
          ? null
          : Math.max(0, Math.floor(balance.remainingMs / 60_000));
      const nextRefillAt =
        balance.remainingMs === null
          ? null
          : balance.periodEndsAt.toISOString();
      return {
        tariff: toPublicTariff(tariff),
        remainingMinutes,
        grantEndsAt: balance.grantEndsAt?.toISOString() ?? null,
        nextRefillAt,
        tariffs: yield* publicTariffs(),
        hourPacks: yield* publicHourPacks(),
      } satisfies PlayerPlan;
    }),
});
