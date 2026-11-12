# Очередь и тарифы — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** админ создаёт тарифы и выдаёт их игрокам. Тариф задаёт приоритет в очереди, часы в месяц,
качество стрима и длину сессии. Игрок в очереди видит своё место, сколько людей ждёт и примерное
время.

**Architecture:** тарифы, выдачи и ручные начисления лежат в Postgres (`packages/db`). Остаток минут
считает **чистая функция** `computeBalance` по выдачам, начислениям и `play_segments`. Её вызывают и
api, и оркестратор через общий загрузчик в `packages/db/src/tariffs.ts`. Место в очереди считает
оркестратор (только у него есть подключённые серверы и логика годности). Он раз в 5 с пишет место,
число ждущих и оценку в колонки `sessions`, а api отдаёт их в `SessionView`. Лимиты (часы, длина
сессии) соблюдает автомат `lifecycle.ts`: в снимок добавляется остаток.

**Tech Stack:** Bun 1.4, Effect 4 (RPC, Schema), Drizzle 1.0 rc + Postgres 18, React 19 + shadcn,
TanStack Router, `effect/reactivity` атомы, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-10-queue-and-tariffs-design.md`. Исполнитель читает спеку
и план вместе: план ссылается на разделы спеки (§N).

## Global Constraints

- Весь интерфейс на русском. Тексты, которые фиксирует спека, копировать дословно:
  - «Вы вышли из очереди»;
  - «Часы закончились»;
  - «Достигнут лимит длины сессии»;
  - «Часы заканчиваются — сохранитесь»;
  - «Сессия скоро закончится — сохранитесь»;
  - «В тарифе выше очередь короче»;
  - «Оплата на сайте скоро появится»;
  - «Доступно в тарифе выше»;
  - «Сервер готов — возвращайтесь в игру»;
  - «оцениваем…»;
  - «больше часа».
- Миграция: `cd packages/db && bunx drizzle-kit generate --name queue_tariffs`, затем ручная
  вставка тарифа по умолчанию в конец сгенерированного `migration.sql` (как в
  `20261109054134_multi_server`).
- Тариф по умолчанию из миграции: имя «Базовый», приоритет 0, минут в месяц `null` (безлимит),
  перенос `false`, `1440p`, 40 Мбит/с, длина сессии `null`, `is_default = true`.
- Если тариф пользователя определить не удалось (нет строки по умолчанию), действует встроенный
  `FALLBACK_TARIFF` с теми же значениями. Никогда не запрет игры (анти-цель спеки).
- Время тратится только по `play_segments.billable = true`.
- Общий код для api и оркестратора кладётся в `packages/db` (или `packages/rpc` для схем), не
  копируется.
- Порог выпадения из очереди 2 минуты. Предупреждения о лимите за 10 и за 2 минуты. Окно оценки
  очереди — 1 час, минимум 3 освобождения, округление до 5 мин, больше 60 мин — «больше часа».
- Проверка типов всегда `bunx turbo run check --force` (кэш turbo уже прятал поломку). Тесты db и
  orchestrator под нагрузкой гонять с `--timeout 30000`.
- Ветка `feat/tariffs-queue`, worktree `~/.t3/worktrees/imt-cloud-gaming/tariffs-queue`. Не пушить.
  Основной checkout `~/work/imt-cloud-gaming` общий с другими сессиями, в нём ничего не делать.

## Review Focus

1. **Сессия идёт, админ начислил часы или сменил тариф.** Игра продолжается без перезапуска,
   дедлайн пересчитывается на следующем тике. Тест в Task 8.
2. **Тариф по умолчанию изменили с безлимита на N часов.** Игроки не получают «долг» за прошлые
   месяцы: долг гасится только начислениями в том же периоде и обнуляется на границе периода.
   Тест в Task 2.
3. **Выдача на 31-е число.** Периоды 31 янв → 28/29 фев → 31 мар считаются от якоря, а не
   цепочкой. Тест в Task 2.
4. **Игрок в очереди ушёл со страницы сессии в библиотеку.** Место не теряется (heartbeat
   `queueOnly`), но сессии в `playing` такой heartbeat не делает видимым клиента. Тесты в Task 6
   (api) и Task 11 (web).
5. **Устаревший агент или оркестратор.** Без поля `maxBitrateMbps` в `StartSession` агент ставит
   прежний `SELKIES_VIDEO_BITRATE`. Тест в Task 8.

---

### Task 1: Схема БД и миграция

**Files:**
- Create: `packages/db/src/schema/tariffs.ts`
- Modify: `packages/db/src/schema/index.ts` (экспорт), `packages/db/src/schema/sessions.ts`
  (колонки `sessions`)
- Create: `packages/db/migrations/<timestamp>_queue_tariffs/` (generate + ручная вставка)
- Test: `packages/db/test/tariffsMigration.test.ts`

**Interfaces:**
- Produces: таблицы Drizzle `tariffs`, `hourPacks`, `tariffGrants`, `minuteCredits`, новые колонки
  `sessions.queuePriority`, `sessions.queuePosition`, `sessions.queueTotal`,
  `sessions.queueEtaMinutes`, тип `TariffRow = typeof tariffs.$inferSelect`.

Колонки:

- `tariffs`:
  - `id` text pk (uuid);
  - `name` text not null unique;
  - `price_rub` integer null;
  - `queue_priority` integer not null default 0;
  - `monthly_minutes` integer null;
  - `rollover` boolean not null default false;
  - `max_resolution` text enum `StreamResolution` not null default `'1440p'`;
  - `max_bitrate_mbps` integer not null default 40;
  - `max_session_minutes` integer null;
  - `is_default` boolean not null default false;
  - `archived_at` timestamptz null;
  - `created_at`, `updated_at`;
  - частичный уникальный индекс `tariffs_default_idx` on `(is_default) where is_default`.
- `hour_packs`: `id` text pk, `name` text not null, `minutes` integer not null, `price_rub` integer
  null, `archived_at` timestamptz null, `created_at`.
- `tariff_grants`:
  - `id` text pk;
  - `user_id` → `user.id` on delete cascade;
  - `tariff_id` → `tariffs.id`;
  - `starts_at` timestamptz not null;
  - `ends_at` timestamptz null;
  - `granted_by` → `user.id` on delete set null, null;
  - `created_at`;
  - индекс `(user_id, starts_at desc)`.
- `minute_credits`: `id` text pk, `user_id` → `user.id` cascade, `minutes` integer not null
  (check > 0), `comment` text not null default `''`, `granted_by` → `user.id` set null, `created_at`;
  индекс `(user_id, created_at)`.
- `sessions`:
  - `queue_priority` integer not null default 0;
  - `queue_position`, `queue_total`, `queue_eta_minutes` integer null;
  - индекс `sessions_queue_idx` on `(state, queue_priority desc, created_at)`.
  - Триггер `session_changed_notify` **не** трогать: `session.watch` и так перечитывает каждые 5 с.

- [ ] **Step 1: тест миграции.** `tariffsMigration.test.ts` на `DbTest`:
  - `default tariff is seeded`: ровно одна строка `is_default = true`, имя «Базовый»,
    `monthly_minutes` `null`, `max_resolution` `'1440p'`, `max_bitrate_mbps` 40, `queue_priority` 0;
  - `second default is rejected`: вставка второго `is_default = true` падает (уникальный индекс);
  - `minute credit must be positive`: `minutes = 0` падает.
- [ ] **Step 2:** `cd packages/db && bun test --env-file=../../.env test/tariffsMigration.test.ts`
  — FAIL (нет таблиц).
- [ ] **Step 3:** схема в `schema/tariffs.ts`, колонки в `sessions.ts`, `bunx drizzle-kit generate
  --name queue_tariffs`, в конец `migration.sql` дописать `INSERT INTO "tariffs" (...)` тарифа
  «Базовый» с `gen_random_uuid()::text`.
- [ ] **Step 4:** тест из Step 2 — PASS. Плюс `bun test --env-file=../../.env --timeout 30000` во
  всём `packages/db` — PASS.
- [ ] **Step 5:** commit `feat(db): тарифы, выдачи, начисления минут и поля очереди в sessions`.

---

### Task 2: Чистый расчёт остатка минут

**Files:**
- Create: `packages/db/src/minutes.ts` (без Effect и I/O)
- Modify: `packages/db/src/index.ts` (`export * from "./minutes"`)
- Test: `packages/db/test/minutes.test.ts`

**Interfaces:**
- Produces:

```ts
export type TariffLimits = {
  readonly id: string; readonly name: string; readonly queuePriority: number;
  readonly monthlyMinutes: number | null; readonly rollover: boolean;
  readonly maxResolution: StreamResolution; readonly maxBitrateMbps: number;
  readonly maxSessionMinutes: number | null;
};
export const FALLBACK_TARIFF: TariffLimits; // id "fallback", «Базовый», безлимит, 1440p, 40
export type GrantSpan = { readonly tariff: TariffLimits; readonly startsAt: Date; readonly endsAt: Date | null };
export type Credit = { readonly minutes: number; readonly at: Date };
export type Usage = { readonly startedAt: Date; readonly endedAt: Date };
export type BalanceInput = {
  readonly userCreatedAt: Date; readonly defaultTariff: TariffLimits;
  readonly grants: ReadonlyArray<GrantSpan>; // не пересекаются
  readonly credits: ReadonlyArray<Credit>; readonly usage: ReadonlyArray<Usage>; readonly now: Date;
};
export type Balance = {
  readonly tariff: TariffLimits;          // действующий сейчас
  readonly grantEndsAt: Date | null;      // конец действующей выдачи; null — бессрочно или тариф по умолчанию
  readonly periodEndsAt: Date;            // конец текущего периода = следующее пополнение
  readonly remainingMs: number | null;    // null — безлимит; может быть < 0 (долг)
};
export const addMonthsClamped: (anchor: Date, months: number) => Date;
export const computeBalance: (input: BalanceInput) => Balance;
```

Алгоритм (§3 спеки) — то, что тесты не определяют однозначно:

1. **Полосы времени.** Выдачи по возрастанию `startsAt`. Промежутки без выдачи (до первой, между
   выдачами, после окончания) — полосы тарифа по умолчанию. У них якорь `userCreatedAt`, у выдачи
   якорь — её `startsAt`.
2. **Периоды.** Период `k` полосы — это `[addMonthsClamped(anchor, k), addMonthsClamped(anchor, k+1))`,
   пересечённый с полосой. `addMonthsClamped` всегда считается от якоря: якорь 31-го даёт 28/29
   февраля, а потом снова 31 марта.
3. **Корзины.** У каждого периода с `monthlyMinutes !== null` есть корзина на `monthlyMinutes·60000`
   мс. Она действует от начала периода в полосе до `addMonthsClamped(anchor, k+1)`, а с `rollover`
   — до `addMonthsClamped(anchor, k+2)`. Срок корзины не обрезается концом полосы: минуты старого
   тарифа доживают до своего срока. Ручное начисление — корзина от `at` без срока.
4. **Списание.** Использование режется по всем границам (начала и сроки корзин, начала периодов).
   Кусок в момент `t`:
   - если полоса в `t` безлимитная, кусок пропускается;
   - иначе он списывается из действующих в `t` корзин в порядке срока (бессрочные последними);
   - чего не хватило, уходит в `debt`. Новая корзина, появившаяся в том же периоде, сначала гасит
     `debt`.
   - `debt` обнуляется в начале каждого периода активной полосы.
5. **Итог.** `remainingMs` = сумма остатков корзин, действующих в `now`, минус `debt`. Если полоса в
   `now` безлимитная, `null`.

- [ ] **Step 1: тесты** (`describe("computeBalance")`, минуты переводить хелпером `min(n)`):
  - `no grants, unlimited default → remainingMs null, tariff = default`;
  - `limited grant 600 min, used 100 → 500 min`;
  - `no rollover: unused 300 of previous period is lost → 600 − used this period`;
  - `rollover: previous unused 300 → 900; spending 200 takes rollover first; leftover 100 expires at the next boundary`;
  - `rollover only one month: leftovers of period 0 do not reach period 2`;
  - `manual credit spent last and never expires`: тариф 60, начисление 120, использовано 90 →
    `remainingMs = min(90)`; в следующем периоде `min(60 + 90)`;
  - `debt within period is paid by a later credit`: использовано 610 из 600, затем начисление 30 →
    `min(20)`;
  - `debt resets at period start`: использовано 610 в прошлом периоде → в этом `min(600)`;
  - `default tariff changed from unlimited to 600 min: past months create no debt` (полоса по
    умолчанию 600, много использования в прошлых периодах) → текущий `min(600 − used this period)`;
  - `tariff switch mid-period keeps old leftovers until their expiry and starts a new anchor`;
  - `anchor on Jan 31 → periods end Feb 29 2028 and Mar 31 2028` (через `periodEndsAt`);
  - `unlimited grant does not consume manual credits`;
  - `ended grant → default tariff, grantEndsAt null`;
  - `open usage up to now counts`.
- [ ] **Step 2:** `bun test test/minutes.test.ts` — FAIL.
- [ ] **Step 3:** реализовать `minutes.ts` по алгоритму выше.
- [ ] **Step 4:** тест — PASS.
- [ ] **Step 5:** commit `feat(db): расчёт остатка минут по тарифу`.

---

### Task 3: Загрузчики тарифа и остатка

**Files:**
- Create: `packages/db/src/tariffs.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/src/placement.ts` (только комментарий
  `allowedClasses` — «задел под тарифы» остаётся, классы к тарифу не привязываем, не-цель спеки)
- Test: `packages/db/test/tariffs.test.ts`

**Interfaces:**
- Consumes: Task 1 (таблицы), Task 2 (`computeBalance`, `TariffLimits`, `FALLBACK_TARIFF`).
- Produces:

```ts
export const toLimits: (row: TariffRow) => TariffLimits;
export const defaultTariff: () => Effect.Effect<TariffLimits, never, Db>;        // FALLBACK_TARIFF, если строки нет
export const currentTariff: (userId: string, now: Date) => Effect.Effect<TariffLimits, never, Db>;
export const loadBalance: (userId: string, now: Date) => Effect.Effect<Balance, never, Db>;
export type LimitReason = "minutes" | "session_length";
export type SessionLimit = { readonly remainingMs: number; readonly reason: LimitReason };
/** Меньший из остатков: минуты пользователя и длина сессии (billable-время сессии vs maxSessionMinutes); null — ограничений нет. */
export const sessionLimit: (userId: string, sessionId: string, now: Date) => Effect.Effect<SessionLimit | null, never, Db>;
```

`loadBalance` грузит:
- все выдачи пользователя;
- все начисления;
- `user.createdAt`;
- все отрезки `play_segments` с `billable = true`. У открытого отрезка конец берётся как
  `max(endedAt, startedAt)`, как он сохранён.

При равенстве остатков `sessionLimit` возвращает `"minutes"`.

- [ ] **Step 1: тесты на `DbTest`:**
  - `currentTariff returns the active grant, else default`;
  - `currentTariff falls back to FALLBACK_TARIFF when no default row` (удалить строку в тесте);
  - `loadBalance sums only billable segments`;
  - `sessionLimit picks the smaller of minutes and session length`: тариф 600 мин и сессия 60 мин,
    сессия уже 50 мин → `{ reason: "session_length", remainingMs: 10·60000 }`;
  - `sessionLimit is null for unlimited tariff without session cap`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** PASS (`--timeout 30000`).
- [ ] **Step 5:** commit `feat(db): загрузка действующего тарифа, остатка и лимита сессии`.

---

### Task 4: API админки — тарифы и пакеты часов

**Files:**
- Create: `packages/rpc/src/tariffs.ts` (схемы)
- Modify: `packages/rpc/src/admin.ts` (RPC + комментарий-справочник в стиле файла),
  `packages/rpc/src/index.ts`
- Create: `apps/api/src/admin/tariffs.ts`
- Modify: `apps/api/src/admin/rpc.ts`
- Test: `apps/api/test/adminTariffs.test.ts`

**Interfaces:**
- Produces в `@cg/rpc`:

```ts
export const Tariff = Schema.Struct({
  id: Schema.String, name: Schema.String, priceRub: Schema.NullOr(Schema.Int),
  queuePriority: Schema.Int, monthlyMinutes: Schema.NullOr(Schema.Int), rollover: Schema.Boolean,
  maxResolution: StreamResolution, maxBitrateMbps: Schema.Int, maxSessionMinutes: Schema.NullOr(Schema.Int),
  isDefault: Schema.Boolean, archived: Schema.Boolean,
});
export const TariffInput  // Tariff без id/isDefault/archived, с проверками:
// name 1..60 после trim; priceRub 0..1_000_000; queuePriority 0..1000; monthlyMinutes 60..100_000;
// maxBitrateMbps minBitrateMbps..maxBitrateMbps; maxSessionMinutes 10..10_000
export const HourPack = Schema.Struct({ id, name, minutes: Schema.Int, priceRub: Schema.NullOr(Schema.Int), archived: Schema.Boolean });
export const HourPackInput // name 1..60, minutes 60..100_000, priceRub 0..1_000_000
```

- RPC (все за `AdminMiddleware`):
  - `admin.tariffs.list` → `Array(Tariff)`, порядок `queue_priority asc, name asc`;
  - `admin.tariffs.create` `{input}` → `"ok" | "duplicate"`;
  - `admin.tariffs.update` `{id, input}` → `"ok" | "duplicate" | "notFound"`;
  - `admin.tariffs.setDefault` `{id}` → `"ok" | "archived" | "notFound"` (одной транзакцией снять
    старый и поставить новый);
  - `admin.tariffs.setArchived` `{id, archived}` → `"ok" | "isDefault" | "notFound"`;
  - `admin.hourPacks.list` → `Array(HourPack)`;
  - `admin.hourPacks.create` `{input}` → `"ok"`;
  - `admin.hourPacks.update` `{id, input}` → `"ok" | "notFound"`;
  - `admin.hourPacks.setArchived` `{id, archived}` → `"ok" | "notFound"`.

- [ ] **Step 1: тесты** по образцу `adminRegions.test.ts`:
  - `list contains seeded Базовый as default`;
  - `create rejects duplicate name`;
  - `update edits fields and keeps isDefault`;
  - `setDefault moves the flag atomically (exactly one default after)`;
  - `setDefault on archived tariff → "archived"`;
  - `cannot archive default → "isDefault"`;
  - `hour packs create/update/archive roundtrip`;
  - `player role gets Forbidden`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать. Конфликт уникальности имени ловить через
  `apps/api/src/admin/dbErrors.ts`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(admin): тарифы и пакеты часов (api)`.

---

### Task 5: API админки — тариф и часы пользователя

**Files:**
- Modify: `packages/rpc/src/admin.ts` (`AdminUser.tariffName`, `AdminSession.queuePosition`, новые
  RPC), `apps/api/src/admin/users.ts`, `apps/api/src/admin/sessions.ts`, `apps/api/src/admin/rpc.ts`
- Create: `apps/api/src/admin/userPlans.ts`
- Test: `apps/api/test/adminUserPlans.test.ts`; дополнить `apps/api/test/adminUsers.test.ts`

**Interfaces:**
- Consumes: Task 3 (`loadBalance`, `currentTariff`), Task 4 (`Tariff`).
- Produces:

```ts
export const AdminUserPlan = Schema.Struct({
  tariff: Tariff, grantEndsAt: Schema.NullOr(Schema.String), periodEndsAt: Schema.String,
  remainingMinutes: Schema.NullOr(Schema.Int),     // floor(remainingMs/60000), null — безлимит; < 0 → 0
  grants: Schema.Array(Schema.Struct({ id, tariffName, startsAt, endsAt: NullOr(String), grantedBy: NullOr(String) })), // новые сверху
  credits: Schema.Array(Schema.Struct({ id, minutes: Schema.Int, comment: Schema.String, createdAt, grantedBy: NullOr(String) })),
});
```

- RPC:
  - `admin.users.plan` `{userId}` → `NullOr(AdminUserPlan)` (нет пользователя — `null`);
  - `admin.users.grantTariff` `{userId, tariffId, endsAt: NullOr(String ISO)}` →
    `"ok" | "notFound" | "archived" | "badEnd"`. Транзакция: действующей выдаче
    `ends_at = now`, новая начинается в `now`. `endsAt <= now` → `"badEnd"`;
  - `admin.users.revokeTariff` `{userId}` → `"ok" | "none"`;
  - `admin.users.addMinutes` `{userId, minutes: Int 1..100_000, comment: String ≤ 200}` →
    `"ok" | "notFound"`.
- `AdminUser.tariffName: Schema.String` — имя действующего тарифа. Подзапрос SQL в `userColumns`,
  чтобы не было N+1: последняя действующая выдача, иначе тариф по умолчанию, иначе «Базовый».
- `AdminSession.queuePosition: Schema.NullOr(Schema.Int)` — из `sessions.queue_position`.

- [ ] **Step 1: тесты:**
  - `grantTariff replaces the active grant (old ends at now, new starts at now)`;
  - `grantTariff with past endsAt → "badEnd"`;
  - `grantTariff archived tariff → "archived"`;
  - `revokeTariff closes the grant → plan shows default`;
  - `addMinutes adds a credit and remainingMinutes grows` (тариф с лимитом);
  - `users.list shows tariffName (granted / default)`;
  - `sessions.list returns queuePosition`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать. `granted_by` — `CurrentUser.id`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(admin): выдача тарифа и начисление часов пользователю (api)`.

---

### Task 6: API игрока — план, старт сессии, heartbeat, поля `SessionView`

**Files:**
- Modify: `packages/rpc/src/tariffs.ts` (`AccountRpcs`, `PlayerPlan`), `packages/rpc/src/index.ts`
  (`AppRpcs`)
- Modify: `packages/rpc/src/session.ts`:
  - `SessionView.queue`, `SessionView.limit`;
  - `NoMinutes`;
  - `session.start` error union;
  - `heartbeat` payload `queueOnly`.
- Create: `apps/api/src/account/rpc.ts`
- Modify: `apps/api/src/http.ts` (handlers), `apps/api/src/session/SessionRepo.ts`,
  `apps/api/src/session/rpc.ts`
- Modify: фикстуры `SessionView` в `apps/web/test/*` и `apps/web/src/components/session/SessionControls.tsx`
  (добавить `queue: null, limit: null`)
- Test: `apps/api/test/account.test.ts`, дополнить `apps/api/test/session.test.ts`

**Interfaces:**
- Consumes: Task 3 (`loadBalance`, `sessionLimit`), Task 4 (`Tariff`, `HourPack`).
- Produces:

```ts
export const PublicTariff = Tariff.pick("id","name","priceRub","queuePriority","monthlyMinutes","rollover","maxResolution","maxBitrateMbps","maxSessionMinutes");
export const PlayerPlan = Schema.Struct({
  tariff: PublicTariff, remainingMinutes: Schema.NullOr(Schema.Int), // < 0 → 0
  grantEndsAt: Schema.NullOr(Schema.String), nextRefillAt: Schema.NullOr(Schema.String), // null при безлимите
  tariffs: Schema.Array(PublicTariff),   // не скрытые, queue_priority asc
  hourPacks: Schema.Array(HourPack),     // не скрытые
});
// RPC "account.plan" → PlayerPlan (AuthMiddleware)
export const SessionQueue = Schema.Struct({ position: Schema.Int, total: Schema.Int, etaMinutes: Schema.NullOr(Schema.Int) });
export const SessionLimitView = Schema.Struct({ deadline: Schema.String, reason: Schema.Literals(["minutes","session_length"]) });
// SessionView += queue: NullOr(SessionQueue), limit: NullOr(SessionLimitView)
export class NoMinutes extends Schema.TaggedError<NoMinutes>()("NoMinutes", {}) {}
export const noMinutesReason = "Часы закончились";
// session.heartbeat payload += queueOnly: Schema.optional(Schema.Boolean)
```

Поведение:

- `startSession` (`apps/api/src/session/SessionRepo.ts`). Порядок проверок:
  1. блокировка;
  2. владение игрой;
  3. уже есть активная сессия — вернуть её;
  4. `loadBalance`: `remainingMs !== null && remainingMs <= 0` → `"NoMinutes"`;
  5. `gameAvailable`;
  6. вставка с `queuePriority = balance.tariff.queuePriority`.
  
  `rpc.ts` превращает `"NoMinutes"` в `new NoMinutes()`.
- `toView`:
  - `queue` есть только при `state === "queued"` и непустом `queue_position`:
    `{ position, total, etaMinutes }` из колонок;
  - `limit` есть только при `playing | idle_warning`: `sessionLimit` → `deadline = now +
    max(0, remainingMs)` ISO.
- `heartbeat(userId, sessionId, inputAgeMs, queueOnly)`: при `queueOnly` обновляется **только**
  `client_seen_at` и только если `state = 'queued'`; `last_input_at` не трогается.

- [ ] **Step 1: тесты:**
  - `account.plan returns default unlimited plan for a new user`;
  - `account.plan lists non-archived tariffs by priority and hour packs`;
  - `session.start with zero minutes fails with NoMinutes`;
  - `session.start returns the existing active session even with zero minutes`;
  - `session.start stores queue_priority of the current tariff`;
  - `heartbeat queueOnly updates client_seen_at of a queued session`;
  - `heartbeat queueOnly does not touch a playing session` (`client_seen_at` прежний);
  - `watch view has queue from columns when queued, null otherwise`;
  - `watch view has limit deadline when playing with a limited tariff`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать. Обновить фикстуры web (`queue: null, limit: null`).
- [ ] **Step 4:** api тесты PASS; `bunx turbo run check --force` — PASS.
- [ ] **Step 5:** commit `feat(session): тариф игрока, запрет старта без минут, heartbeat очереди`.

---

### Task 7: Оркестратор — порядок очереди, выпадение, снимок места

**Files:**
- Modify: `apps/orchestrator/src/Scheduler.ts` (`lockOldestQueued` → порядок), `apps/orchestrator/src/lifecycle.ts`
  (порог `queued`)
- Create: `apps/orchestrator/src/QueueSnapshot.ts`
- Modify: `apps/orchestrator/src/main.ts` (запуск обновления снимка раз в 5 с)
- Test: `apps/orchestrator/test/queueSnapshot.test.ts`, дополнить `lifecycle.test.ts`, `scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 (колонки `sessions`), `eligibleWorkers` (`@cg/db`), `InstallRepo.installedOn`.
- Produces:

```ts
// lifecycle.ts
export const QUEUE_CLIENT_TIMEOUT_MS = 120_000;
failReasons.queueLeft = "Вы вышли из очереди";
// QueueSnapshot.ts
export type QueueEntry = { readonly id: string; readonly priority: number; readonly createdAt: Date; readonly targets: ReadonlySet<string> };
export type QueuePlace = { readonly position: number; readonly total: number; readonly etaMinutes: number | null };
/** Место/всего среди пересекающихся по targets; releasesPerHour(targets) — освобождения слотов за час. */
export const rankQueue: (entries: ReadonlyArray<QueueEntry>, releasesPerHour: (targets: ReadonlySet<string>) => number) => ReadonlyMap<string, QueuePlace>;
export const etaMinutes: (position: number, releasesPerHour: number) => number | null;
export const refreshQueue: (now: Date) => Effect.Effect<void, never, Db | AgentHub>;
export const QUEUE_REFRESH_INTERVAL = "5 seconds";
```

Правила:
- **Порядок размещения:** `orderBy(desc(sessions.queuePriority), asc(sessions.createdAt))`.
- **`queued` и порог клиента:** вместо `K` используется `QUEUE_CLIENT_TIMEOUT_MS` с причиной
  `failReasons.queueLeft`. У `starting` остаётся `K` с `clientGone`.
- **`rankQueue`:**
  - порядок как у планировщика;
  - `position` = 1 + число записей впереди, у которых `targets` пересекается с моими;
  - `total` = число всех записей, пересекающихся со мной, включая меня;
  - запись с пустыми `targets` получает `position = total = 1` среди таких же пустых (сервера нет
    вообще, её не разместят, но номер не врёт).
- **`etaMinutes`:**
  - `releasesPerHour < 3` → `null`;
  - иначе `ceil(position / (releasesPerHour/60))`, округлить **вверх** до кратного 5, минимум 5;
  - больше 60 → `61` (web покажет «больше часа»).
- **`refreshQueue`:**
  - берёт `queued` без `stop_requested_at`, где пользователь не заблокирован и нет активной
    установки (те же условия, что `lockOldestQueued`, без `FOR UPDATE`);
  - `targets` = `eligibleWorkers(userId, appId, { workerIds: подключённые worker })`. Для
    Steam-игры — пересечение с `installedOn(appId)`, если оно не пусто, иначе весь `eligible`;
  - освобождения = сессии с `worker_id` в `targets` и `slot_released_at >= now − 1h`;
  - пишет `queue_position/queue_total/queue_eta_minutes` **только если значения изменились**;
  - у сессий, вышедших из `queued`, обнуляет эти колонки.

- [ ] **Step 1: тесты:**
  - lifecycle: `queued without client for 2 min → ended with "Вы вышли из очереди"`;
    `queued client seen 90 s ago → keep`; `starting still uses disconnectGraceMinutes`;
  - scheduler: `higher queue_priority is placed first even if newer`;
  - `rankQueue`: `disjoint targets don't count`; `priority then createdAt`;
    `total includes self`; `empty targets`;
  - `etaMinutes`: `(1, 2) → null`, `(1, 12) → 5`, `(3, 6) → 30`, `(20, 6) → 61`;
  - `refreshQueue` (DbTest + фейковый хаб, как в `scheduler.test.ts`): `writes position/total
    for two queued sessions on the same worker`; `clears columns after the session leaves queued`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать, подключить `refreshQueue` в `main.ts` через `Effect.repeat` с
  `Schedule.spaced(QUEUE_REFRESH_INTERVAL)`, ошибки логировать, как у планировщика.
- [ ] **Step 4:** PASS (`--timeout 30000`).
- [ ] **Step 5:** commit `feat(orchestrator): приоритет тарифа в очереди, место и оценка ожидания`.

---

### Task 8: Оркестратор и агент — лимиты часов, длины и качества

**Files:**
- Modify: `apps/orchestrator/src/lifecycle.ts` (`Snapshot.limit`, остановка),
  `apps/orchestrator/src/SessionRepo.ts` (`snapshotOf(row, now)`, `displaySizeFor` с потолком
  тарифа)
- Modify: `apps/orchestrator/src/Scheduler.ts` (поле `maxBitrateMbps` в `StartSession`)
- Modify: `packages/rpc/src/agent.ts` (`StartSession.maxBitrateMbps: Schema.optional(Schema.Int)` +
  строка в справочном комментарии)
- Modify: `packages/rpc/src/streamSettings.ts` (`capResolution`)
- Modify: `apps/agent/src/SessionSupervisor.ts` (`SELKIES_VIDEO_BITRATE`)
- Test: `lifecycle.test.ts`, `runner.test.ts`, `scheduler.test.ts`, `apps/agent/test/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 3 (`sessionLimit`, `currentTariff`).
- Produces:

```ts
// lifecycle.ts
Snapshot.limit: { remainingMs: number; reason: "minutes" | "session_length" } | null;
failReasons.minutesOut = "Часы закончились";
failReasons.sessionTooLong = "Достигнут лимит длины сессии";
// streamSettings.ts
export const capResolution: (wanted: StreamResolution, max: StreamResolution) => StreamResolution;
// agent: SELKIES_VIDEO_BITRATE = `${Math.min(10_000, cap*1000)},2000-${cap*1000}`, cap = maxBitrateMbps ?? 40
```

Правила:
- `snapshotOf(row, now)` считает `limit` только для `playing | idle_warning`
  (`sessionLimit(row.userId, row.id, now)`), иначе `null`.
- В `onTick`, ветка `playing | idle_warning`: сразу **после** проверки `clientVisible` (ушедший
  клиент не тратит время) — если `s.limit && s.limit.remainingMs <= 0`, то
  `decision("stopping", closeAt(s, now, now), "StopContainer", reason === "minutes" ?
  failReasons.minutesOut : failReasons.sessionTooLong)`.
- Тариф и остаток читаются на каждом тике. Начисление или смена тарифа применяются без
  перезапуска (Review Focus 1).
- `displaySizeFor(userId, now)`: разрешение = `capResolution(settings.resolution,
  tariff.maxResolution)`.
- Планировщик кладёт `maxBitrateMbps: tariff.maxBitrateMbps` в `StartSession`.

- [ ] **Step 1: тесты:**
  - lifecycle: `playing with limit.remainingMs 0 (minutes) → stopping "Часы закончились"`;
    `same for session_length → "Достигнут лимит длины сессии"`;
    `disconnected client wins over limit` (не видим клиента → `disconnected`, не `stopping`);
    `limit null → keep`;
  - runner: `credit added mid-session keeps it playing on the next tick` (тариф 60 мин,
    использовано 60, начислили 30 → после тика `playing`);
  - `capResolution("1440p", "1080p") === "1080p"`, `("720p", "1080p") === "720p"`;
  - scheduler: `StartSession carries maxBitrateMbps of the tariff`; `display is capped by tariff`;
  - agent: `SELKIES_VIDEO_BITRATE uses maxBitrateMbps 20 → "10000,2000-20000"`;
    `missing maxBitrateMbps → "10000,2000-40000"`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** PASS для orchestrator и agent. `bunx turbo run check --force` — PASS.
- [ ] **Step 5:** commit `feat(orchestrator): лимиты часов и длины сессии, потолок качества по тарифу`.

---

### Task 9: Админка — вкладка «Тарифы» и тариф пользователя

**Files:**
- Modify: `apps/web/src/rpc.ts` (атомы `admin.tariffs.*`, `admin.hourPacks.*`, `admin.users.plan`,
  `grantTariff`, `revokeTariff`, `addMinutes`)
- Create: `apps/web/src/components/admin/TariffsTab.tsx`, `apps/web/src/components/admin/TariffDialog.tsx`,
  `apps/web/src/components/admin/UserPlanDialog.tsx`
- Modify: `apps/web/src/routes/admin.tsx` (`ADMIN_TABS` += `["tariffs", "Тарифы"]`),
  `apps/web/src/components/admin/UsersTab.tsx` (столбец «Тариф» + кнопка открытия
  `UserPlanDialog`), `AdminSessionsTable.tsx` (место в очереди у `queued`)
- Test: `apps/web/test/adminTariffs.test.tsx`

Вид экранов — по §8 спеки. В форме тарифа админ вводит **часы** (целые) и минуты длины сессии,
пустое поле значит безлимит. Отправляется `monthlyMinutes = часы·60`. Ответы `"duplicate"`,
`"isDefault"`, `"archived"`, `"badEnd"` показываются текстом у формы, как в `RegionsCard`.

- [ ] **Step 1: тесты** (стиль `adminInstalls.test.tsx`, фейковый клиент):
  - `tariffs tab lists tariffs with default badge`;
  - `create dialog sends minutes = hours × 60 and null for empty hours`;
  - `duplicate name shows an error`;
  - `user plan dialog grants a tariff with end date and shows remaining hours`;
  - `add minutes sends minutes and comment`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(admin): вкладка «Тарифы», тариф и часы в карточке пользователя`.

---

### Task 10: Игрок — тариф на /app, страница тарифов, запуск без минут, качество

**Files:**
- Modify: `apps/web/src/rpc.ts` (`accountPlanAtom`, ключ реактивности `session` тоже обновляет его)
- Create: `apps/web/src/components/app/PlanPanel.tsx`, `apps/web/src/components/app/PlansPage.tsx`
- Modify: `apps/web/src/routes/app.tsx` (маршрут `/app/plans`), место `PlanPanel` рядом с `TimePanel`
- Modify: `apps/web/src/lib/usePlaySession.ts` (`NoMinutes` → «Часы закончились» + ссылка
  «Докупить» на `/app/plans`)
- Modify: `apps/web/src/components/session/SessionMenu.tsx` (разрешения выше
  `plan.tariff.maxResolution` недоступны, с замком и подписью «Доступно в тарифе выше»;
  ползунок битрейта не выше `maxBitrateMbps`)
- Modify: `apps/web/src/lib/selkiesBridge.ts`: `settingsMessages(settings, capMbps)`, потолок =
  `min(ceilingMbps(settings), capMbps)`
- Test: `apps/web/test/planPanel.test.tsx`, дополнить `sessionMenu.test.tsx`, `session.test.tsx`

**Interfaces:**
- Consumes: Task 6 (`PlayerPlan`, `NoMinutes`).
- Produces: `export const accountPlanAtom`; `export function formatMinutes(minutes: number): string`
  в `apps/web/src/lib/planFormat.ts`, например «12 ч 30 мин», «45 мин».

Содержание `PlanPanel`:
- имя тарифа;
- «осталось 12 ч 30 мин» или «без лимита»;
- «до 10 декабря», если `grantEndsAt`;
- «пополнение 15 декабря», если `nextRefillAt`;
- кнопка «Докупить» → `/app/plans`.

Даты выводятся в `Europe/Moscow`, формат `d MMMM` через `Intl`.

`PlansPage`:
- плашка «Оплата на сайте скоро появится»;
- карточки тарифов: цена, приоритет словами (самый высокий — «Без очереди»; выше минимального —
  «Приоритет в очереди»; иначе «Общая очередь»), часы, качество, длина сессии; текущий отмечен;
- список пакетов часов;
- кнопок покупки нет.

- [ ] **Step 1: тесты:**
  - `PlanPanel shows remaining hours and refill date`;
  - `PlanPanel shows "без лимита" for unlimited`;
  - `PlansPage marks current tariff and shows the payment-soon banner`;
  - `NoMinutes on start shows «Часы закончились» with a link to /app/plans`;
  - `SessionMenu locks resolutions above the tariff with «Доступно в тарифе выше»`;
  - `settingsMessages caps auto and manual bitrate by capMbps`;
  - `formatMinutes(750) === "12 ч 30 мин"`, `formatMinutes(45) === "45 мин"`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(web): тариф игрока, страница тарифов, ограничения качества`.

---

### Task 11: Игрок — экран очереди, уведомление, предупреждения о лимите

**Files:**
- Modify: `apps/web/src/lib/loadingSteps.ts` (подпись `queued` из `view.queue`)
- Create: `apps/web/src/lib/queueText.ts`
- Create: `apps/web/src/components/QueueWatcher.tsx` (монтируется в `apps/web/src/routes/__root.tsx`
  для вошедшего пользователя)
- Create: `apps/web/src/components/session/LimitWarning.tsx` (поверх стрима, как `IdlePrompt`)
- Modify: `apps/web/src/components/LoadingScreen.tsx`: подсказка «В тарифе выше очередь короче»;
  кнопка «Сообщить, когда подойдёт очередь», если `Notification.permission === "default"`
- Modify: `apps/web/src/routes/session.$id.tsx` (подключить `LimitWarning`)
- Test: `apps/web/test/queueText.test.ts`, `apps/web/test/queueWatcher.test.tsx`,
  `apps/web/test/limitWarning.test.tsx`, дополнить `loadingScreen.test.tsx`

**Interfaces:**
- Consumes: Task 6 (`SessionView.queue`, `SessionView.limit`, `heartbeat.queueOnly`), Task 10
  (`accountPlanAtom`).
- Produces:

```ts
export function queueLine(q: SessionQueue): string;
// «Вы 3-й в очереди · ждут 7 человек · ≈ 10 мин»
// «человек/человека» по числу; eta null → «оцениваем…»; 61 → «больше часа»
```

Поведение:
- **Подпись очереди в `loadingSteps`:** при `view.queue` вместо «Ждём свободный сервер» стоит
  `queueLine(view.queue)`. Если `queue` ещё `null` (снимок не успел), остаётся «Ждём свободный
  сервер».
- **Подсказка про тариф:** показывается, если в `plan.tariffs` есть тариф с `queuePriority` больше,
  чем у текущего. Ссылка ведёт на `/app/plans`.
- **Разрешение на уведомления.** Отступление от спеки (§5 «сайт один раз просит»): браузеры
  (Safari) дают запросить разрешение только по нажатию. Поэтому вместо автоматического запроса
  кнопка «Сообщить, когда подойдёт очередь». Записать в итог плана.
- **`QueueWatcher`:**
  - пока у пользователя есть активная сессия (`activeSessionAtom`), раз в 5 с шлёт
    `session.heartbeat` с `{ queueOnly: true, inputAgeMs: 0 }` (сервер учтёт его только в
    `queued`);
  - подписан на `sessionWatchAtom(id)`. При переходе `queued → другое` и `document.hidden` играет
    короткий сигнал (WebAudio, осциллятор ~0.3 с, без файлов). Если разрешение `granted`,
    показывает `new Notification("Сервер готов — возвращайтесь в игру")`.
- **`LimitWarning`:**
  - видна, когда `view.limit` есть и до `deadline` ≤ 10 мин;
  - текст «Часы заканчиваются — сохранитесь» (`minutes`) или «Сессия скоро закончится —
    сохранитесь» (`session_length`) плюс обратный отсчёт;
  - кнопка «Докупить» только для `minutes`, открывает `/app/plans` в новой вкладке;
  - закрывается крестиком и снова появляется при ≤ 2 мин.

- [ ] **Step 1: тесты:**
  - `queueLine({position:3,total:7,etaMinutes:10}) === "Вы 3-й в очереди · ждут 7 человек · ≈ 10 мин"`;
  - `total 2 → «ждут 2 человека»`; `etaMinutes null → «оцениваем…»`; `61 → «больше часа»`;
  - `loading screen shows queue line and upsell when a higher tariff exists`;
  - `QueueWatcher sends queueOnly heartbeat while a session is active`;
  - `QueueWatcher notifies when state leaves queued while hidden`
    (`document.hidden = true`, мок `Notification`);
  - `LimitWarning hidden at 11 min, shown at 9 min, reappears at 2 min after dismiss`;
  - `no «Докупить» for session_length`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализовать.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(web): экран очереди, уведомление о готовности, предупреждения о лимите`.

---

### Task 12: Финальная проверка и итог

**Files:**
- Modify: этот план (раздел «Итог исполнения»)

- [ ] **Step 1:** `bunx turbo run check --force` — PASS.
- [ ] **Step 2:** `bunx turbo run lint --force` — PASS.
- [ ] **Step 3:** тесты по пакетам последовательно: `packages/db`, `apps/api`, `apps/orchestrator`
  (`--timeout 30000`), `apps/agent`, `apps/web`. Ожидание — PASS, кроме заранее известного падения
  `SteamQrLogin > shows QR and statuses` (падает и на `main`). Любое другое падение нужно
  исправить.
- [ ] **Step 4:** раздел «Итог исполнения» в конце плана:
  - отступления от спеки (кнопка разрешения уведомлений; битрейт ограничивается и в браузере, и
    через `SELKIES_VIDEO_BITRATE`);
  - отложенное.
- [ ] **Step 5:** commit `docs(plan): итог очереди и тарифов`.

## Итог исполнения (2026-11-11)

Диапазон: `9f385da..252c2bc` (от слияния части 1 multi-server до последнего коммита финальной
fix-волны, перед этим документом). Задачи 1–12 сделаны, по задачам и всей ветке прошли ревью.

Что сделано: админ создаёт тарифы (приоритет в очереди, часы в месяц, перенос остатка, разрешение
стрима, потолок битрейта, длина сессии) и разовые пакеты часов, выдаёт тарифы и начисляет часы
игрокам из админки. Остаток считает чистая функция `computeBalance` по выдачам, начислениям и
`play_segments`, общая для api и оркестратора. Игрок в очереди видит место, число ждущих и оценку
времени (оркестратор пишет их в `sessions` раз в 5 с); на вкладке в фоне или после выхода с сайта
можно попросить браузерное уведомление «подойдёт очередь». В сессии показываются предупреждения
о близком конце часов/длины сессии со ссылкой на покупку. Лимиты соблюдает `lifecycle.ts`
оркестратора.

Отступления от спеки и плана:
- разрешение на браузерные уведомления запрашивается не сразу, а по клику на кнопку «Сообщить,
  когда подойдёт очередь» — Safari даёт показать системный запрос только из обработчика клика;
- потолок битрейта стрима действует дважды: в браузере (`capMbps` в `selkiesBridge`) и на агенте
  через `SELKIES_VIDEO_BITRATE`, которую `SessionSupervisor` выставляет контейнеру при старте
  сессии;
- долг по минутам (игра в долг при коротком провале сети) сбрасывается в начале каждого периода,
  а не переносится и гасится следующим начислением через границу периода — так админ может сменить
  тариф на дефолтный без того, чтобы игроку «выставили счёт» за прошлый месяц; долг не крупнее
  одного тика;
- перед остановкой по лимиту гарантировано окно предупреждения не короче 2 минут
  (`sessions.limit_grace_until`, миграция `limit_grace`): если остаток обваливается резко (грант
  закончился/отозван, админ понизил лимит), сессию не обрывают на этом же тике, а дают доиграть
  до конца окна — до 2 минут сверх лимита. При обычном плавном отсчёте окно может добавить до
  одного тика раннера (5 с) сверх точного нуля — это принятая погрешность, не дефект;
- начисление часов в админке — только целыми часами (ввод «Часы», отправляется как часы × 60);
- дата окончания выдачи тарифа включительная: «до» выбранного дня означает до его конца
  (23:59:59.999) по местному времени администратора, а не до полуночи UTC этого дня;
- приоритетные очереди (T6/T11): сигнал «ваша очередь подошла» уведомляет только при переходе
  `queued → starting/playing/idle_warning` — конечные состояния (выход из очереди, отмена) и
  возврат в установку не считаются «сервер готов»; `heartbeat` с `queueOnly` на уже идущей
  (не стоящей в очереди) сессии — не ошибка, а no-op, чтобы не падать при гонке с переходом
  очереди в старт; при равном приоритете у всех тарифов очередь называется «Общая очередь», а не
  «Без очереди».

Известные ограничения и отложенное:

- **Граничные случаи корректности:**
  - пересекающиеся выдачи тарифа обрабатываются не так, как описано в комментарии: более новый
    грант всегда выигрывает, а открытый по срок (без даты окончания) старый грант при этом
    обрывается раньше, чем ожидалось по спеке («последний выигрывает») — `packages/db/src/minutes.ts`;
  - повторный вход в тариф по умолчанию в середине периода даёт игроку свежий полный остаток
    часов, а не продолжение прежнего (буквальное прочтение брифа, не проверено отдельно);
  - `grantTariff` с кривой датой окончания (`endsAt`, не-ISO строка) приводит к `Invalid Date` и
    падает в 500 вместо типизированной ошибки (`apps/api/src/admin/rpc.ts`);
  - `queueOf` подставляет `total = queuePosition`, когда `queue_total` не записан — маскирует
    возможный дефект планировщика (`SessionRepo.ts` оркестратора);
  - `limit_grace_until` не входит в список колонок, которые будят `session_changed`-триггер: при
    резком обвале остатка экран может на ~5 с показать «0:00», пока не придёт следующее
    периодическое обновление watch-подписки (раз в 5 с), и только потом — новые 2:00;
  - при выходе из `playing` в `disconnected` окно `limit_grace_until` не очищается; если игрок
    вернётся после истечения окна с остатком ≤ 0, сессия остановится на первом тике — игрок уже
    получил предупреждение за 2 минуты до отключения;
  - `meAtom` теперь закреплён в корне `QueueWatcher`'ом и не перезапрашивается при переходах между
    страницами — если кука протухла посреди визита, часть экрана может недолго показывать старого
    пользователя, пока какой-то RPC не упадёт с `Unauthorized` (страницы профиля, игр и способов
    входа сами его обновляют);
  - двойной клик по «Начислить» в админке во время висящего запроса может отправить два
    начисления (кнопка не блокируется на время запроса) — виден в истории начислений, админский
    сценарий;
  - транзитная ошибка `auth.me` (сеть недоступна) оставляет `QueueWatcher` выключенным до
    следующей перезагрузки страницы — как и у `/app` в том же случае.
- **Производительность:**
  - `loadBalance` на каждый тик читает всю историю `play_segments` пользователя одним запросом
    (сознательный выбор — кредиты не истекают, точный баланс нужен только по истории; индекс
    есть; при текущих масштабах — приемлемо, при росте — снэпшот потраченных минут);
  - `loadBalance` выполняет 5 независимых запросов последовательно, а не параллельно
    (`Effect.all`);
  - `loadUserPlan` в админке делает лишний запрос на существование пользователя перед
    `loadBalance` (2 round-trip вместо 1);
  - `heartbeat` с `queueOnly` делает `UPDATE` + `SELECT` (2 round-trip);
  - планировщик (`Scheduler.ts`) при размещении читает текущий тариф дважды (для разрешения
    экрана и для потолка битрейта) — можно объединить в один запрос;
  - очистка очереди сканирует все сессии раз в 5 с вместо фильтра по `queue_position` или
    частичного индекса;
  - добавленный в финальной волне запрос текущего тарифа на горячем пути лимита сессии
    (`sessionLimit`) не удорожает типичный случай — безлимитные тарифы по умолчанию этот запрос
    не делают и выигрывают по сравнению со старым кодом.
- **Тесты:**
  - нет тестов на отклонение значений вне диапазона в `TariffInput`/`HourPackInput` на уровне
    схемы, и на «не найден»/«дубликат имени» при переименовании тарифа (`updateTariff`);
  - нет тестов на обрезание `periodEndsAt` по дате окончания гранта и на сброс долга при
    переключении лимитированный/безлимитный тариф;
  - тесты watch-представления сессии проверяются через `session.active`, а не `session.watch`
    (используют общий `toView`);
  - тест «`starting` всё ещё использует `disconnectGraceMinutes`» в lifecycle держится на том, что
    дефолтный `startTimeoutMinutes` больше 5 — не закреплено явно;
  - ветка `tariffName` для не-«Базового» дефолтного тарифа не покрыта тестом (SQL-инвариант
    проверен контроллером БД, но не тестом);
  - нет тестов на провязку `accountPlanAtom` → `qualityLimits` плеера в `session.$id.tsx`, и на
    `hasHigherTariff` в том же файле;
  - `computeBalance` не удаётся довести до ветки `current === null` даже прицельным фаззингом
    200k комбинаций выдач/начислений — ветка-страховка (M7, `defaultPeriodAt`) проверена только
    своим отдельным тестом и sweep-тестом «не бросает», а не RED-тестом самой `computeBalance`.
- **Полировка:**
  - у сгенерированной миграции `20261111013440_queue_tariffs` нет завершающего перевода строки в
    `migration.sql`;
  - `IntBetween`-хелпер продублирован в `packages/rpc/src/admin.ts` и `tariffs.ts` — стоит
    вынести один;
  - `TariffDialog` в админке не подсказывает границы значений (цена/приоритет/длина
    сессии/битрейт) на клиенте — об ошибке узнаёшь только из общего текста ошибки сохранения;
  - смена тарифа посреди сессии не переставляет потолок битрейта в браузере сразу — он
    подхватится при следующей смене настроек или перезагрузке (серверный потолок действует с
    самого старта сессии);
  - `NotifyWhenReady` читает `Notification.permission` только при монтировании и клике, не
    подписывается на его изменение.

Верификация (все команды — на `252c2bc`):

| Проверка | Результат |
|---|---|
| `bunx turbo run check --force` | 6/6 пакетов, без ошибок типов |
| `bunx turbo run lint --force` | 6/6 пакетов, без замечаний |
| `packages/db` тесты | 74 pass, 0 fail (9 файлов) |
| `apps/api` тесты | 294 pass, 0 fail (34 файла) |
| `apps/orchestrator` тесты | 251 pass, 0 fail (13 файлов) |
| `apps/agent` тесты | 415 pass, 0 fail (26 файлов) |
| `apps/web` тесты | 617 pass, 1 fail (61 файл) |

Единственное падение — заранее известный флейк `SteamQrLogin > shows QR and statuses`; падает и
на `main`, не в этом диффе и не из-за этой ветки.
