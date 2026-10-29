# Админка: хвосты — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть отложенное после трёх частей админки: удаление игры убирает и её шаблон префикса
Proton; причина неудачного удаления видна на вкладке «Игры»; сессия не присоединяется к установке,
которую админ уже отменяет; мелочи ревью части 3 (тесты, дубль кода).

**Architecture:** Без новых механизмов — правки в существующих местах: план удаления агента
(`GameRemoval.planRemoval`) и его защита в `Installer.deleteGame`; итог `GameDeleteFailed`
оркестратор пишет в `gamestore_apps.delete_error`, api отдаёт его в `AdminGame`; планировщик не
берёт в установку сессию, чья активная задача отменяется.

**Tech Stack:** Bun, Effect 4, drizzle-orm 1.0 rc + Postgres, React 19, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-28-admin-orchestration-design.md` (решения «Удаление
игры», «Отмена установки админом»); шаблоны префикса — комментарий в начале
`apps/agent/src/PrefixTemplate.ts` и README «Шаблоны префикса Proton».

## Global Constraints

- Тексты — по-русски. Новая причина отказа агента: `"Собирается шаблон префикса"`. Строка на
  вкладке «Игры»: `Не удалось удалить: <причина>`.
- Удаление по-прежнему запрещено при живой сессии, установке или контейнере `cg.app=<appId>`;
  шаблон префикса удаляется вместе с игрой только через `.trash`, как остальные каталоги.
- Причина неудачи в админке — только строки агента (`deleteReasons`, сообщения об ошибках ФС без
  секретов); никаких токенов/имён аккаунтов Steam.
- Тесты: БД-тесты из worktree — `bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env`
  (файл не открывать и не выводить); `bun run check --force`, `bun run lint` в корне.
- Коммиты: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; ветка `feat/admin-tails` в
  worktree.

## Review Focus

1. Шаблон префикса игры как раз собирается (сборка запущена прошлой сессией, контейнера
   `cg.app` уже нет, перенос `rename` ещё впереди) — удаление отказывает «Собирается шаблон
   префикса», а не удаляет каталог, который сборка тут же вернёт (Task 1).
2. Две игры с общим `installdir` — `compatdata/<appId>` у каждой свой, удаляется только свой
   (Task 1).
3. Повторное удаление после неудачи — прежняя причина исчезает сразу при новой пометке, а не
   после ответа агента (Task 2).
4. Админ отменил идущую установку, и тут же другой игрок жмёт «Играть» в эту игру — его сессия
   ждёт в очереди и после конца отменённой задачи заводит новую, а не падает с «Установка
   отменена администратором» (Task 3).

---

### Task 1: Агент — удаление шаблона префикса вместе с игрой

**Files:**
- Modify: `apps/agent/src/GameRemoval.ts` (`planRemoval`), `apps/agent/src/PrefixTemplate.ts` (`PrefixTemplatesShape`), `apps/agent/src/Installer.ts` (`deleteReasons`, `deleteGame`)
- Modify: `deploy/README.md` (абзац «Удаление игры» и раздел «Шаблоны префикса Proton» — шаблон удаляется вместе с игрой)
- Test: `apps/agent/test/gameRemoval.test.ts`, `apps/agent/test/installer.test.ts`

**Interfaces:**
- Produces:
  - `planRemoval` добавляет в `dirs` `join(steamapps, "compatdata", String(appId))`, если он есть (после `common/<installdir>`, перед `shadercache/<appId>`; он не общий — по `appId`).
  - `PrefixTemplatesShape.building(appId: number): boolean` — для этой игры сейчас идёт `ensure` (запись в `inFlight`); значение по умолчанию у `Context.Reference` — `() => false`.
  - `deleteReasons.templateBuilding = "Собирается шаблон префикса"`; `deleteGame` отвечает `GameDeleteFailed` с этой причиной, если `building(appId)`, — проверка рядом с проверкой `cg.app` контейнеров, до переноса в корзину.

- [ ] **Step 1: Write the failing tests:** `gameRemoval.test.ts` › `planRemoval includes the prefix template` (есть `compatdata/<appId>` → он в `dirs`; `compatdata` другой игры — нет); `installer.test.ts` › `DeleteGame while the prefix template is building fails with Собирается шаблон префикса` (фейковый `PrefixTemplates` с `building: () => true` → `GameDeleteFailed`, манифест на месте) и что при удалении `compatdata/<appId>` уходит в корзину и корзина очищается.
- [ ] **Step 2: Run** `cd apps/agent && bun test test/gameRemoval.test.ts test/installer.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** весь `apps/agent`, `bun run check --force`, `bun run lint` — PASS/чисто.
- [ ] **Step 5: Commit** `feat(agent): удаление игры убирает и её шаблон префикса Proton`.

### Task 2: Причина неудачного удаления на вкладке «Игры»

**Files:**
- Modify: `packages/db/src/schema/gamestore.ts` (`gamestoreApps.deleteError: text("delete_error")`, nullable) + миграция `bunx drizzle-kit generate --name game_delete_error`
- Modify: `apps/orchestrator/src/GameRepo.ts`, `apps/orchestrator/src/GameDeleter.ts`
- Modify: `packages/rpc/src/admin.ts` (`AdminGame.deleteError: Schema.NullOr(Schema.String)`), `apps/api/src/admin/games.ts`
- Modify: `apps/web/src/components/admin/GamesTab.tsx`
- Test: `apps/orchestrator/test/gameDeleter.test.ts`, `apps/api/test/adminGames.test.ts`, `apps/web/test/adminGames.test.tsx`

**Interfaces:**
- Produces: `GameRepo.clearDeleting(appId: number, reason: string)` — `deleting_at = null`, `delete_error = reason`. api `deleteGame` при пометке (`"started"`) ставит `delete_error = null` в том же `update`. `AdminGame.deleteError` — значение колонки.

- [ ] **Step 1: Write the failing tests:** оркестратор › `GameDeleteFailed stores the reason` (`delete_error` = присланная причина, `deleting_at` null); api › `list returns deleteError` и `delete clears the previous error`; web › строка игры с `deleteError: "Игра запущена"` показывает «Не удалось удалить: Игра запущена», без ошибки — строки нет.
- [ ] **Step 2: Run** нужные файлы — FAIL.
- [ ] **Step 3: Implement.** В вебе — мелкий текст `text-destructive` под названием игры (как прочие подписи строки).
- [ ] **Step 4: Run** `apps/orchestrator`, `apps/api`, `apps/web` целиком, `bun run check --force`, `bun run lint` — PASS/чисто.
- [ ] **Step 5: Commit** `feat: причина неудачного удаления игры в админке`.

### Task 3: Сессия не присоединяется к отменяемой установке

**Files:**
- Modify: `apps/orchestrator/src/Scheduler.ts` (`placeOne`, ветка неустановленной игры)
- Test: `apps/orchestrator/test/install.test.ts`

**Interfaces:**
- Produces: в ветке `lockOldestQueued(sql\`not ${appInLibrary}\`)` добавлено условие: нет активной (`queued`/`running`) задачи этой игры с `cancel_requested_at is not null` (именованный `SQL`-фрагмент рядом с `appInLibrary`, с комментарием). Такая сессия остаётся `queued` без `installJobId`.

- [ ] **Step 1: Write the failing test:** `session waits while the game's install is being cancelled`: задача `running` с `cancel_requested_at`, новая `queued`-сессия этой игры → после `tick` сессия `queued`, `install_job_id` null, задача та же; задача завершилась `failed` → следующий `tick` заводит новую задачу и сессия `installing`.
- [ ] **Step 2: Run** `cd apps/orchestrator && bun test --env-file=… test/install.test.ts` — FAIL (сессия присоединилась).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** весь `apps/orchestrator`, `bun run check --force` — PASS/чисто.
- [ ] **Step 5: Commit** `fix(orchestrator): сессия не присоединяется к отменяемой установке`.

### Task 4: Мелочи ревью части 3

**Files:**
- Modify: `apps/api/src/session/SessionRepo.ts`, `apps/api/src/admin/users.ts`
- Test: `apps/api/test/adminUsers.test.ts`, `apps/web/test/adminUsers.test.tsx`, `apps/web/test/adminGames.test.tsx`, `apps/web/test/adminInstalls.test.tsx`

**Interfaces:**
- Produces: в `SessionRepo.ts` экспортируемый `requestStopAt(now: Date): SQL` — выражение `coalesce(stop_requested_at, now)`; им пользуются `stopSession` и `setBlocked` (дубль из `users.ts` убрать).

- [ ] **Step 1: Tests:** api › `list orders newest first and reports activeSession` (два пользователя с разными `created_at`, у одного `queued`-сессия); web `adminUsers.test.tsx` › тосты «Нельзя изменить себя» на `"self"` и «Пользователь не найден» на `"notFound"`; в `adminGames.test.tsx`/`adminInstalls.test.tsx` — заглушки `errorTag`/`resultErrorTag` в `mock.module` переделать так же, как в `adminUsers.test.tsx` (не протекают в другие файлы: весь `bun test` в `apps/web` зелёный при любом порядке, проверить `bun test --randomize` или прогоном файлов парами).
- [ ] **Step 2: Implement** `requestStopAt`.
- [ ] **Step 3: Run** `apps/api`, `apps/web` целиком, `bun run check --force`, `bun run lint` — PASS/чисто.
- [ ] **Step 4: Commit** `test: мелочи ревью админки — порядок и activeSession, тосты, изоляция моков`.
