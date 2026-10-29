# Мелочи и доработки входа Steam по QR — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть накопившиеся мелочи: полоска экрана загрузки по серверному времени, утечка
`matchMedia` в тестах сайта, комментарии-исключения под линтер Bun; и пять доработок входа Steam по
QR (стирание именно того посева, срок у брошенной попытки, предупреждение агента о непринятом посеве
в сессии, уникальность аккаунта Steam, пропавшая попытка = отменённая), плюс «Играть снова» после
QR с понятными ошибками.

**Architecture:** Без новых механизмов — правки на месте. Посев получает «метку» `putAt` (момент
записи, уже есть в `steam_login_seeds.put_at`): оркестратор кладёт её в `StartSession`/`InstallGame`,
агент возвращает в `ProfileCommit`, оркестратор удаляет посев только с этой меткой (как
`steamLoginResetAt` → `clearSteamLoginReset`).

**Tech Stack:** Bun 1.4 (`bun test`, `bun check`, `bun lint`, `bun fmt`), Effect 4, drizzle-orm 1.0 rc
+ Postgres, React 19.

**Согласовано с владельцем в чате 2026-10-29** («Делай»), пункт 3 части QR — только предупреждение
в логе, поведение сессии не меняется.

## Global Constraints

- Тексты — по-русски; новых строк для игрока нет, кроме перечисленных ниже.
- Токен и имя аккаунта Steam не попадают в логи, ошибки, API и браузер (`SteamLoginSeed` — только
  внутри команды агенту). Не включать DEBUG на `cg-orchestrator`.
- Не открывать и не выводить `.env`, `.env.*`. БД-тесты из worktree —
  `bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env` (временная база
  `cg_test_<random>`).
- Проверки: в корне `bun run check --force`, `bun run lint`, `bun run fmt --check` (форматер —
  встроенный `bun fmt`, не Biome/Prettier); тесты затронутых пакетов целиком.
- Совместимость агента и оркестратора: новые поля протокола — необязательные
  (`Schema.optional`/`NullOr` с дефолтом), старый агент без поля работает как раньше.
- Миграции: `cd packages/db && bunx drizzle-kit generate --name <имя>`. На проде дублей
  `account(provider_id, account_id)` нет (проверено 2026-10-29: 0 строк).
- Коммиты: трейлер `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; ветка
  `fix/small-tails` в worktree.

## Review Focus

1. Игрок пересканировал QR, пока шла сессия со старым посевом: конец сессии не стирает новый
   посев (Task 3).
2. Старый агент без поля `steamLoginPutAt` в `ProfileCommit`: посев стирается, как раньше (Task 3).
3. Миграция уникального индекса не падает на данных и не мешает better-auth отвязывать/привязывать
   другие провайдеры (Task 4).
4. Полоска после перезагрузки страницы продолжает с того же места, что и до неё (Task 1).

---

### Task 1: Сайт — полоска по серверному времени, `matchMedia` в тестах, комментарии линтера, «Играть снова»

**Files:**
- Modify: `apps/web/src/lib/loadingSteps.ts` (`loadingProgress`, `plan`), `apps/web/src/components/LoadingScreen.tsx`, `apps/web/src/components/Player.tsx` (убрать `useMsSince`, если больше не нужен)
- Modify: `apps/web/test/setup.ts`
- Modify: `apps/web/src/components/SteamQrLogin.tsx` (`biome-ignore`), `apps/web/src/components/app/MyGamesPage.tsx`, `apps/web/src/components/login/LoginPanel.tsx`, `apps/web/src/components/SteamQrLogin.tsx` (`react-hooks/exhaustive-deps`), `apps/web/src/components/app/game/AboutPanel.tsx` (`dangerouslySetInnerHTML` без исключения — добавить)
- Modify: `apps/web/src/routes/session.$id.tsx` (`playAgain`)
- Test: `apps/web/test/loadingSteps.test.ts` (или где тесты `loadingProgress`), `apps/web/test/session.test.tsx`

**Interfaces:**
- Produces:
  - `loadingProgress(view, msInStage, nowServerMs?)` — если у текущего этапа есть отметка в
    `view.timing` (та же, что у таймера этапа), доля этапа считается от `nowServerMs − startedAt`
    и по норме этапа `stageNormMs(...)`; без отметки — как сейчас (`msInStage`, `STAGE_MS`).
    Скачивание — по-прежнему по проценту.
  - `test/setup.ts`: `afterEach` возвращает исходный `window.matchMedia` (запомнить при загрузке
    preload). Локальные «вернуть как было» в `filterBar.test.tsx`/`myGamesPage.test.tsx` и их
    комментарии про утечку — убрать.
  - Комментарии-исключения: `// eslint-disable-next-line react/exhaustive-deps` (правило Bun
    называется так, не `react-hooks/...`), для `dangerouslySetInnerHTML` —
    `// eslint-disable-next-line react/no-danger -- <причина по-русски>`. Проверка: `bun lint
    --no-script --rule 'react/exhaustive-deps: error' --rule 'react/no-danger: error'
    --report-unused-disable-directives src` в `apps/web` — без ошибок (найти и прочие места, если
    правило их покажет, — исключение с причиной или правка).
  - `playAgain`: `GameNotOwned` → тост «Эта игра не найдена в вашей библиотеке Steam»,
    `SessionServerUnavailable`/`NoServer` (тег — как в `usePlaySession.ts`) → тот же текст, что
    у «Играть» в библиотеке. Лучше вынести общий разбор ошибок `session.start` из
    `usePlaySession.ts` и звать его в обоих местах.

- [ ] **Step 1: Write the failing tests:** `loadingProgress` с отметкой этапа: прогресс зависит от
  `nowServerMs − startedAt`, а не от `msInStage` (два вызова с разным `msInStage` и одним
  `nowServerMs` дают одно значение); норма этапа из `timing` меняет долю; без отметки — прежнее
  поведение. `playAgain` с `GameNotOwned` и с отсутствием сервера — нужные тосты, без перехода.
- [ ] **Step 2: Run** нужные файлы — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/web` целиком, затем `bun test --randomize` в `apps/web` 15 раз подряд
  — 0 падений (если падает что-то ещё — найти причину и починить; не подавлять). `bun run check
  --force`, `bun run lint`, `bun run fmt --check`.
- [ ] **Step 5: Commit** `fix(web): полоска загрузки по серверному времени, изоляция matchMedia в тестах, исключения линтера Bun, ошибки «Играть снова»`.

### Task 2: api — брошенная попытка входа по QR не висит вечно

**Files:**
- Modify: `apps/api/src/steamLogin/SteamLoginRepo.ts` (`ownRow` читает `createdAt`, `updatedAt`), `apps/api/src/steamLogin/rpc.ts` (`toView`)
- Test: `apps/api/test/steamQrLogin.test.ts`

**Interfaces:**
- Produces: в `toView` (или рядом, чистая функция с `now`):
  - `pending` и `createdAt` старше `PENDING_LIMIT = 60 s` → `{status: "failed", reason: steamLoginReasons.steamError}`;
  - `waiting`/`scanned` и `updatedAt` старше `STALE_LIMIT = 6 min` (таймаут попытки оркестратора 5 мин + запас) → то же.
  - Только отображение: строку api не меняет (её доведёт оркестратор — `failStale` при старте).
    Новый `steamLogin.start` и так отменяет активную строку пользователя.
  - «Сейчас» — `Clock` Effect (тесты двигают `TestClock` или ставят даты строки в прошлое).
- [ ] **Step 1: Write the failing tests:** `pending older than a minute is failed with steamError`, `waiting not updated for 6 minutes is failed`, `fresh pending stays waiting`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `apps/api` целиком + check/lint/fmt.
- [ ] **Step 5: Commit** `fix(api): брошенная попытка входа Steam по QR заканчивается ошибкой`.

### Task 3: Посев стирается только тот, что использован (протокол + оркестратор + агент)

**Files:**
- Modify: `packages/rpc/src/agent.ts` (`SteamLoginSeed` + `putAt`, `ProfileCommit` + `steamLoginPutAt`)
- Modify: `apps/orchestrator/src/SteamLoginSeeds.ts` (`get` возвращает `putAt`; `clear(userId, putAt?)`), `apps/orchestrator/src/http.ts` (`applyProfileCommit`), `apps/orchestrator/src/Scheduler.ts`, `apps/orchestrator/src/InstallDispatcher.ts` (если `putAt` не идёт сам вместе с посевом)
- Modify: `apps/agent/src/SessionSupervisor.ts`, `apps/agent/src/Installer.ts`, `apps/agent/src/profile/HomeProfile.ts` (передать метку посева в `finish`/коммит)
- Test: `apps/orchestrator/test/steamLoginSeeds.test.ts`, `apps/orchestrator/test/profile.test.ts`, `apps/agent/test/supervisor.test.ts`, `apps/agent/test/installer.test.ts`

**Interfaces:**
- Produces:
  - `SteamLoginSeed.putAt: Schema.optional(Schema.String)` (ISO 8601, точность мс — как
    `steamLoginResetAt`; сравнение в SQL через `date_trunc('ms', put_at)`, см.
    `SessionRepo.clearSteamLoginReset`).
  - `ProfileCommit.steamLoginPutAt: Schema.optional(Schema.NullOr(Schema.String))` — метка посева,
    который агент записал в профиль (нет посева — поле не шлётся).
  - `SteamLoginSeeds.clear(userId, putAt?: Date)`: с меткой — удаляет только строку с этим
    `put_at` (до мс); без метки (старый агент) — как сейчас.
  - `applyProfileCommit`: `accepted && steamLoginSeeded` → `clear(userId, putAt)`.
- [ ] **Step 1: Write the failing tests:** оркестратор — `seed put after the session started survives the seeded commit` (посев A → `get` → `put` B → коммит с меткой A → B на месте), `commit without putAt clears as before`; `get` возвращает `putAt`. Агент — `StartSession`/`InstallGame` с посевом → коммит несёт `steamLoginPutAt` = метка из команды.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `apps/orchestrator`, `apps/agent`, `packages/rpc` целиком + check/lint/fmt.
- [ ] **Step 5: Commit** `fix: конец сессии стирает только тот посев входа Steam, что в неё попал`.

### Task 4: Оркестратор — уникальный аккаунт Steam, пропавшая попытка = отменённая

**Files:**
- Modify: `packages/db/src/schema/auth.ts` (`account`: `uniqueIndex("account_provider_account_idx").on(providerId, accountId)`) + миграция `bunx drizzle-kit generate --name account_provider_unique`
- Modify: `apps/orchestrator/src/SteamLoginRepo.ts` (`linkSteam`, `isCancelled`)
- Test: `apps/orchestrator/test/steamLogin.test.ts`

**Interfaces:**
- Produces:
  - `linkSteam`: «уже занят» — если `user.steam_id = X` у другого пользователя **или** есть строка
    `account(provider_id='steam', account_id=X)` другого пользователя → `steamTaken`. Свой
    `steam_id = X`, но своей строки `account` нет → дописать строку и вернуть `linked`.
  - `isCancelled`: строки нет → `true` (попытка останавливается, ничего не привязывает и не сеет).
- [ ] **Step 1: Write the failing tests:** `Steam account row of another user fails with steamTaken` (у другого только строка `account`, `steam_id` null), `own steam_id without an account row gets the row`, `deleted attempt stops the Steam login` (удалить строку посреди ожидания → попытка закончилась, `linkSteam`/`seeds.put` не вызывались).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `apps/orchestrator`, `apps/api` (better-auth привязки/отвязки) целиком + check/lint/fmt.
- [ ] **Step 5: Commit** `fix(orchestrator): аккаунт Steam привязан не больше чем к одному пользователю; пропавшая попытка входа останавливается`.

### Task 5: Агент — предупреждение, если Steam не принял посев в сессии

**Files:**
- Modify: `apps/agent/src/SessionSupervisor.ts`; по возможности вынести общий разбор `connection_log` из `apps/agent/src/Installer.ts` (`CONNECTION_LOG`, `STEAM_LOGON_OK`, `STEAM_LOGON_ATTEMPT`, чтение с смещения) в общий модуль
- Test: `apps/agent/test/supervisor.test.ts`

**Interfaces:**
- Produces: в сессии с посевом агент в фоне (не задерживая старт и стрим) ждёт в
  `connection_log` строку попытки входа, затем `'OK'` за `steamLoginTimeoutSeconds` (уже есть в
  настройках установщика; в `StartSession` — если поля нет, взять тот же дефолт 90 с). Нет `'OK'` →
  `Effect.logWarning("Seeded Steam login was not accepted", { sessionId, appId })` — то же
  сообщение, что у установщика (по нему ищут в логах). Без имени аккаунта и токена. Поведение
  сессии не меняется; наблюдение кончается с сессией.
- [ ] **Step 1: Write the failing tests:** `seeded session warns when Steam does not accept the login` и `seeded session does not warn after OK` (фейковый `connection_log`, как в тестах установщика).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `apps/agent` целиком + check/lint/fmt.
- [ ] **Step 5: Commit** `feat(agent): предупреждение в логе, если Steam не принял посеянный вход в сессии`.
