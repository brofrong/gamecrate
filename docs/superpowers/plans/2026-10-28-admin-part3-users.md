# Админка, часть 3: пользователи — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вкладка «Пользователи» в `/admin`: список (имя, почта, роль, способы входа, Steam,
регистрация, последняя сессия, наиграно, профиль) и действия «сменить роль», «заблокировать /
разблокировать», «сбросить вход Steam».

**Architecture:** Как в частях 1–2: api только помечает намерение в БД (`user.blocked_at`,
`user.steam_login_reset_at`, `sessions.stop_requested_at`), оркестратор на своём пути превращает
пометки в поведение. Блокировка: api не создаёт сессию (`AccessDenied`) и штатно останавливает
живую; оркестратор перед размещением валит сессию заблокированного (гонка с `session.start`).
Сброс входа Steam: оркестратор выбрасывает посеянный до сброса вход и передаёт агенту момент
сброса в `StartSession`/`InstallGame`; агент после восстановления профиля стирает вход из тех же
четырёх файлов, что пишет посев, и возвращает момент в `ProfileCommit`; принятый коммит снимает
пометку.

**Tech Stack:** Bun, Effect 4 (`effect/rpc`, `effect/reactivity`), drizzle-orm 1.0 rc + Postgres,
React 19 + TanStack Router + Tailwind, `bun test` (+ Testing Library в web).

**Spec:** `docs/superpowers/specs/2026-10-28-admin-orchestration-design.md` (цель 5, решения
«Блокировка», «Сброс входа Steam», анти-цель «ни один секрет не уходит в браузер»). Части 1–2 —
`docs/superpowers/plans/2026-10-28-admin-part{1-workers-sessions,2-games-installs}.md` (в `main`
02f51d3).

## Global Constraints

- Тексты интерфейса — по-русски: вкладка «Пользователи» (между «Установки» и «Настройки»);
  кнопки «Сделать админом» / «Сделать игроком», «Заблокировать» / «Разблокировать», «Сбросить
  вход Steam»; ошибка игроку — `"Доступ закрыт"` (и как `fail_reason` сессии, и как тост при
  «Играть»).
- Себя заблокировать и сменить себе роль нельзя: сервер отвечает `"self"`, кнопки у своей строки
  неактивны.
- Вход на сайт заблокированному не запрещаем (better-auth не трогаем); запрещены только новые
  сессии (а значит и установки — их создаёт только сессия).
- Блокировка останавливает живую сессию пользователя штатно (`stop_requested_at`, профиль
  сохраняется) — тем же `coalesce`, что `admin.sessions.stop`.
- Сброс входа Steam не трогает `user.steam_id`, привязку `account` и сохранения; стираются только
  данные входа: `ConnectCache` в `local.vdf`, пользователи в `loginusers.vdf`, `Accounts` в
  `config.vdf`, `AutoLoginUser`/`RememberPassword` в `registry.vdf`.
- Ни refresh-токен, ни имя аккаунта Steam не попадают в ответы `admin.*`, логи и ошибки; в
  `AdminUser` — только `steamId` (SteamID64) и способы входа (`account.provider_id`).
- Почта: синтетические адреса (`isSyntheticEmail` из `@cg/rpc`) отдаются как `null`.
- Новые поля протокола агента — необязательные (`Schema.optional`), отсутствие = «сброса нет».
- Тесты: БД-тесты из worktree — `bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env`
  (файл не открывать и не выводить); `bun run check --force`, `bun run lint` в корне.
- Коммиты: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; ветка `feat/admin-users`
  в worktree, `main` — общий чекаут.

## Review Focus

1. Админ блокирует игрока, пока тот жмёт «Играть»: `session.start` прочитал «не заблокирован», а
   сессию вставил после коммита блокировки — оркестратор не размещает её, а завершает с «Доступ
   закрыт» (Task 3).
2. Сброс, затем игрок сразу входит по QR на сайте: новый посев (положен после сброса) не
   выбрасывается; агент сначала стирает вход, потом сеет новый; коммит снимает и посев, и пометку
   (Task 2, Task 3).
3. Сброс во время живой сессии: её коммит (без эха сброса) пометку не снимает, следующий старт
   стирает вход (Task 3).
4. Повторный сброс, пока шла сессия с прежним сбросом: коммит с эхом старого момента новую
   пометку не снимает (`<=`) (Task 3).
5. Пользователь входит через Pocket ID: роль пересчитывается из группы при каждом входе — UI
   подсказывает это у строки, а не молча «теряет» смену роли (Task 4).

---

### Task 1: БД и api — список пользователей, роль, блокировка, сброс; `AccessDenied` в `session.start`

**Files:**
- Modify: `packages/db/src/schema/auth.ts` (поля `user`), новая миграция `bunx drizzle-kit generate --name admin_users` в `packages/db/migrations/`
- Modify: `packages/rpc/src/admin.ts`, `packages/rpc/src/session.ts`
- Create: `apps/api/src/admin/users.ts`
- Modify: `apps/api/src/admin/rpc.ts`, `apps/api/src/session/SessionRepo.ts`, `apps/api/src/session/rpc.ts`
- Test: `apps/api/test/adminUsers.test.ts` (новый, по образцу `adminGames.test.ts`), `apps/api/test/session.test.ts`

**Interfaces:**
- Produces:
  - `user.blockedAt: timestamptz("blocked_at")` и `user.steamLoginResetAt: timestamptz("steam_login_reset_at")`, оба nullable, без default. В better-auth `additionalFields` их **не** добавлять (пользователь не должен задавать их сам).
  - `packages/rpc/src/session.ts`: `export const accessDeniedReason = "Доступ закрыт"`; `export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", {})`; `session.start` — `error: Schema.Union([GameNotOwned, AccessDenied])`.
  - `packages/rpc/src/admin.ts`:
    ```ts
    AdminUser = Schema.Struct({
      id: Schema.String, name: Schema.String,
      email: Schema.NullOr(Schema.String),          // синтетическая → null
      role: Schema.Literals(["player", "admin"]),
      providers: Schema.Array(Schema.String),       // distinct account.provider_id, по алфавиту
      steamId: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
      lastSessionAt: Schema.NullOr(Schema.String),  // max(sessions.created_at)
      playedSeconds: NonNegativeInt,                // как TimeRepo: billable и закрытые отрезки
      profileSizeBytes: Schema.NullOr(Schema.Number),
      profileVersion: Schema.NullOr(Schema.Int),
      blockedAt: Schema.NullOr(Schema.String),
      steamLoginResetPending: Schema.Boolean,       // steam_login_reset_at is not null
      activeSession: Schema.Boolean,                // есть сессия под isActive
    })
    ```
    RPC (комментарий над `AdminRpcs` дополнить так же, как для прежних):
    - `admin.users.list` → `Schema.Array(AdminUser)`, новые сверху (`created_at desc`), одним запросом (подзапросы, без N+1).
    - `admin.users.setRole` `{ userId, role }` → `Schema.Literals(["ok", "self", "notFound"])`.
    - `admin.users.setBlocked` `{ userId, blocked: Schema.Boolean }` → `Schema.Literals(["ok", "self", "notFound"])`.
    - `admin.users.resetSteamLogin` `{ userId }` → `Schema.Boolean` (нет пользователя — `false`).
  - `apps/api/src/admin/users.ts`: `listUsers()`, `setRole(actorId, userId, role)`, `setBlocked(actorId, userId, blocked, now: Date)`, `resetSteamLogin(userId, now: Date)`; `actorId` — `CurrentUser.id` из хендлера.
  - `SessionRepo.startSession` возвращает ещё `"Blocked"` (проверка `blocked_at` до `ownsGame`); хендлер → `AccessDenied`.

- [ ] **Step 1: Write the failing tests** (`adminUsers.test.ts`, тестовая БД, `RpcTest` как в `adminGames.test.ts`):
  - `list returns users without Steam secrets`: пользователь с `steam_id`, аккаунтами `steam` и `pocket-id`, профилем (`size_bytes` 1234, `version` 3), двумя закрытыми billable-отрезками по 60 с и одним не-billable → `providers` = `["pocket-id", "steam"]`, `playedSeconds` 120, `profileSizeBytes` 1234, `profileVersion` 3; `JSON.stringify(result)` не содержит `refresh_token`/`access_token` значений из строки `account`.
  - `synthetic email is null`: почта вида, которую `isSyntheticEmail` считает синтетической → `email: null`.
  - `setRole changes role; self and unknown`: `setRole(u-player, "admin")` → `"ok"` и в БД `admin`; `setRole(u-admin (сам), "player")` → `"self"`, роль не изменилась; неизвестный id → `"notFound"`.
  - `setBlocked stops the active session`: у игрока `queued`-сессия → `"ok"`, `blocked_at` выставлен, у сессии `stop_requested_at` не null; повторный вызов не меняет `blocked_at` (`coalesce`); `blocked: false` → `blocked_at` null; себя → `"self"`.
  - `resetSteamLogin marks the user`: → `true`, `steam_login_reset_at` равен переданному `now`; `steam_id` и строки `account` не изменились; неизвестный → `false`.
  - `player gets Forbidden` на всех четырёх методах.
  - В `session.test.ts`: `start for a blocked user fails with AccessDenied` — сессия не создана.
- [ ] **Step 2: Run** `cd apps/api && bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env test/adminUsers.test.ts test/session.test.ts` — FAIL (нет методов/колонок).
- [ ] **Step 3: Implement** схему и миграцию, схемы RPC, `users.ts`, хендлеры, `startSession`. `setBlocked(true)` — одна транзакция: `select … for update` строки `user`, `blocked_at = coalesce(blocked_at, now)`, `stop_requested_at = coalesce(…, now)` для всех сессий пользователя под `isActive`. `steam_login_reset_at` пишется значением `now` из `DateTime.nowAsDate` (миллисекунды — оркестратор сравнивает точное значение, Task 3).
- [ ] **Step 4: Run** те же тесты — PASS; затем весь `apps/api` и `bun run check --force` в корне — чисто.
- [ ] **Step 5: Commit** `feat(api): админка — пользователи: список, роль, блокировка, сброс входа Steam`.

### Task 2: Протокол и агент — стирание входа Steam при старте

**Files:**
- Modify: `packages/rpc/src/agent.ts`
- Modify: `apps/agent/src/steam/loginSeed.ts`, `apps/agent/src/steam/seedContainer.ts` (и, если нужно, `vdf.ts`)
- Modify: `apps/agent/src/SessionSupervisor.ts`, `apps/agent/src/Installer.ts`, `apps/agent/src/profile/HomeProfile.ts`
- Test: `apps/agent/test/loginSeed.test.ts`, `seedContainer.test.ts`, `supervisor.test.ts`, `installer.test.ts`

**Interfaces:**
- Produces (протокол, комментарии у `AgentCommand`/`ProfileCommit` дополнить):
  - `StartSession` и `InstallGame`: `steamLoginResetAt: Schema.optional(Schema.String)` — ISO-момент сброса входа админом; есть — агент стирает вход Steam из дома после восстановления профиля и **до** посева `steamLogin`.
  - `ProfileCommit`: `steamLoginResetAt: Schema.optional(Schema.String)` — эхо значения из команды, если стирание в этом запуске выполнено.
  - `loginSeed.ts`: `clearLogin(current: Partial<Record<keyof typeof LOGIN_FILES, string>>): Partial<Record<keyof typeof LOGIN_FILES, string>>` — чистая; возвращает только файлы, которые есть и разбираются, с вычищенным входом: `local.vdf` — пустой `MachineUserConfigStore/Software/Valve/Steam/ConnectCache`; `loginusers.vdf` — пустой блок `users`; `config.vdf` — пустой `InstallConfigStore/Software/Valve/Steam/Accounts`; `registry.vdf` — `AutoLoginUser` = `""`, `RememberPassword` = `"0"`. Остальное содержимое файлов — как было.
  - `seedContainer.ts`: `clearSteamLogin(options: { readonly container: string }): Effect.Effect<void, SeedError, DockerClient>` — читает файлы тем же способом, что `seedSteamLogin` (общее чтение вынести в функцию модуля), нечитаемый — `logWarning` с ключом файла и пропуск; пишет одним `putArchive` только изменённые файлы с теми же правами/владельцем; нет ни одного файла — `putArchive` не вызывается.
- Consumes: ничего из других задач.

- [ ] **Step 1: Write the failing tests:**
  - `loginSeed.test.ts` › `clearLogin removes a seeded login`: `applyLoginSeed({}, seed, now)` → `clearLogin(те же файлы)`: в `localVdf` нет `connectCacheKey(accountName)`, в `loginUsers` нет `seed.steamId`, в `config` нет `accountName`, `registry` содержит `"AutoLoginUser"\t\t""` и `"RememberPassword"\t\t"0"`; ни один результат не содержит `accountName`. `clearLogin keeps unrelated keys`: посторонний ключ в `config.vdf` (например, `…/Steam/CompatToolMapping`) остаётся. `clearLogin skips missing and unreadable`: `{}` → `{}`, нечитаемый `localVdf` в результат не попадает.
  - `seedContainer.test.ts` › `clearSteamLogin rewrites only present files` (фейковый Docker из `fakes.ts`): в контейнере есть `local.vdf` и `registry.vdf` → один `putArchive` с двумя файлами, режим 0600, uid/gid 1000; пустой дом → `putArchive` не вызывался.
  - `supervisor.test.ts` › `StartSession with steamLoginResetAt clears login before seeding and echoes it`: порядок вызовов в фейке — восстановление профиля → стирание → посев → `start`; коммит профиля после сессии содержит `steamLoginResetAt` из команды; без поля — стирания нет и в коммите поля нет.
  - `installer.test.ts` › то же для `InstallGame`.
- [ ] **Step 2: Run** `cd apps/agent && bun test test/loginSeed.test.ts test/seedContainer.test.ts test/supervisor.test.ts test/installer.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Сбой стирания — тот же `Abort` с `failReasons.profileRestore` / `installReasons` профиля, что у сбоя посева. Момент сброса хранить в состоянии сессии/задачи рядом с `seeded` и передавать в коммит через опции `HomeProfile` (как `steamLoginSeeded`). В логах — только факт стирания (`steamLoginCleared: true`), не содержимое.
- [ ] **Step 4: Run** весь `apps/agent` (`bun test`) и `bun run check --force` — PASS/чисто.
- [ ] **Step 5: Commit** `feat(agent): сброс входа Steam — стирание входа из дома перед стартом`.

### Task 3: Оркестратор — блокировка перед размещением, сброс входа в командах и коммитах

**Files:**
- Modify: `apps/orchestrator/src/Scheduler.ts`, `InstallDispatcher.ts`, `SteamLoginSeeds.ts`, `SessionRepo.ts`, `http.ts`
- Test: `apps/orchestrator/test/steamLoginSeeds.test.ts`, тест планировщика (там, где сейчас проверяется `placeOne`/`tick`), `install.test.ts`, `profile.test.ts`

**Interfaces:**
- Consumes: Task 1 — `user.blockedAt`, `user.steamLoginResetAt`, `accessDeniedReason`; Task 2 — поля `steamLoginResetAt` в `StartSession`/`InstallGame`/`ProfileCommit`.
- Produces:
  - `SteamLoginSeedsShape.clearOlderThan(userId: string, at: Date): Effect.Effect<void>` — убрать вход, положенный раньше `at` (запись хранит момент `put`).
  - `SessionRepo.steamLoginResetAt(userId: string): Effect.Effect<Date | null, never, Db>`.
  - `SessionRepo.clearSteamLoginReset(userId: string, upTo: Date): Effect.Effect<boolean, never, Db>` — `steam_login_reset_at = null where id = userId and steam_login_reset_at <= upTo`; снято — `true`.

- [ ] **Step 1: Write the failing tests:**
  - `steamLoginSeeds.test.ts` › `clearOlderThan drops only earlier seeds`: `put` в t=1000 → `clearOlderThan(at=2000)` → `get` = `null`; `put` в t=3000 → `clearOlderThan(at=2000)` → `get` возвращает вход (`TestClock`).
  - Планировщик › `queued session of a blocked user fails with Доступ закрыт`: пользователь с `blocked_at`, сессия `queued` установленной игры, свободный воркер → после `tick` сессия `failed`, `fail_reason` = `accessDeniedReason`, `StartSession` не отправлен; то же для неустановленной игры — задача установки не создана.
  - Планировщик › `StartSession carries the reset and drops older seed`: у пользователя `steam_login_reset_at` = T, посев положен до T → команда `steamLogin: null`, `steamLoginResetAt: T.toISOString()`; посев после T → команда несёт и посев, и `steamLoginResetAt`; без пометки — поля `steamLoginResetAt` в команде нет.
  - `install.test.ts` › то же для `InstallGame`.
  - `profile.test.ts` › `accepted commit with the echo clears the reset`: пометка T, принятый коммит с `steamLoginResetAt: T` → колонка `null`; пометка T2 > T, коммит с эхом T → колонка остаётся T2; отклонённый коммит с эхом T → остаётся T.
- [ ] **Step 2: Run** `cd apps/orchestrator && bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env` (нужные файлы) — FAIL.
- [ ] **Step 3: Implement.**
  - Блокировка: `lockOldestQueued` дополнительно выбирает `userBlocked` (`exists (select 1 from "user" where id = sessions.user_id and blocked_at is not null)`); в обеих ветках `placeOne` заблокированная сессия получает `SessionRepo.transition(…, { _tag: "Failed", reason: accessDeniedReason })` вместо установки/размещения, итог `Retry`.
  - Сброс: в `Scheduler.tick` и в выдаче `InstallGame` (`InstallDispatcher`) — `resetAt = steamLoginResetAt(userId)`; не `null` → `clearOlderThan(userId, resetAt)` перед `seeds.get`, в команду `steamLoginResetAt: resetAt.toISOString()`; `null` — поле не добавлять.
  - `applyProfileCommit`: принятый коммит с `steamLoginResetAt` → `clearSteamLoginReset(commit.userId, new Date(commit.steamLoginResetAt))`; в лог — флаг `steamLoginResetCleared`.
- [ ] **Step 4: Run** весь `apps/orchestrator` и `bun run check --force` — PASS/чисто.
- [ ] **Step 5: Commit** `feat(orchestrator): блокировка перед размещением и сброс входа Steam в командах агенту`.

### Task 4: Веб — вкладка «Пользователи», «Доступ закрыт» при запуске, README

**Files:**
- Create: `apps/web/src/components/admin/UsersTab.tsx`
- Modify: `apps/web/src/routes/admin.tsx` (`ADMIN_TABS`), `apps/web/src/rpc.ts`, `apps/web/src/lib/usePlaySession.ts` (и другие места вызова `startSessionAtom`, если обрабатывают ошибки сами — найти grep'ом)
- Modify: `deploy/README.md` (раздел «Админка»: убрать «Вкладка „Пользователи“ — в следующей части», добавить абзац про пользователей)
- Test: `apps/web/test/adminUsers.test.tsx` (по образцу `adminGames.test.tsx`), тест запуска игры (`myGamesPage.test.tsx` или где проверяется тост `GameNotOwned`)

**Interfaces:**
- Consumes: Task 1 — `AdminUser`, `admin.users.*`, `AccessDenied`.
- Produces: `adminUsersAtom`, `adminSetRoleAtom`/`adminSetRoleArgs(userId, role)`, `adminSetBlockedAtom`/`adminSetBlockedArgs(userId, blocked)`, `adminResetSteamLoginAtom`/`adminResetSteamLoginArgs(userId)` в `rpc.ts` (ключи `adminKeys`, как у игр).

Вид — таблица в `Card` «Пользователи» с полем поиска по имени/почте (на клиенте) и счётчиком в заголовке; опрос `usePolling` как у других вкладок. Колонки: «Пользователь» (имя, под ним почта или «—»; бейдж «Админ»; бейдж «Заблокирован» с датой; бейдж «в игре» при `activeSession`), «Вход» (Google, Яндекс, Pocket ID, Steam, Telegram; нет аккаунтов — «Почта»), «Steam» (SteamID или «не привязан»; при `steamLoginResetPending` — «вход сброшен»), «Регистрация», «Последняя сессия», «Наиграно» (`formatTime`/`plural` из существующих хелперов), «Профиль» («1,2 МБ · v3» или «—»), меню действий. Своя строка — действия неактивны с подсказкой «Это вы». У пользователя с `pocket-id` в `providers` под ролью — подсказка «Роль задаёт группа в Pocket ID при входе». Подтверждение (`AlertDialog`) для блокировки («Заблокировать <имя>?» / «Текущая игра остановится, профиль сохранится. Новые игры запустить не получится, пока вы не разблокируете.») и для сброса («Сбросить вход Steam у <имя>? При следующем запуске Steam попросит войти заново. Сохранения останутся.»). Тосты по ответу: `"self"` — «Нельзя изменить себя», `"notFound"` — «Пользователь не найден», ошибка — «Не удалось …».

- [ ] **Step 1: Write the failing tests** (`adminUsers.test.tsx`): строки и колонки по фикстуре из двух пользователей (один заблокирован, с Pocket ID, `steamLoginResetPending`), поиск фильтрует по почте, у своей строки кнопки `disabled`, «Заблокировать» → диалог → мутация с `{ userId, blocked: true }`; «Сбросить вход Steam» → диалог → мутация; пустой список — «Пользователей нет». В тесте запуска: ошибка `AccessDenied` → тост «Доступ закрыт».
- [ ] **Step 2: Run** `cd apps/web && bun test test/adminUsers.test.tsx` — FAIL.
- [ ] **Step 3: Implement** вкладку, атомы, `ADMIN_TABS` (`["users", "Пользователи"]` перед `settings`, обновить комментарий над списком), обработку `AccessDenied`, README.
- [ ] **Step 4: Run** весь `apps/web` (`bun test`), `bun run check --force`, `bun run lint` — PASS/чисто.
- [ ] **Step 5: Commit** `feat(web): админка — вкладка «Пользователи»`.
