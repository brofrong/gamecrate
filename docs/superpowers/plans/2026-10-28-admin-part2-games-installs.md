# Админка, часть 2: игры и установки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вкладки «Игры» (игры общей библиотеки с размером, датой установки, последним запуском,
числом запусков и удалением; строка служебных пакетов) и «Установки» (очередь и идущие с
прогрессом и отменой, последние завершённые и упавшие) в `/admin`.

**Architecture:** Админ в api только помечает намерение в БД (`gamestore_apps.deleting_at`,
`install_jobs.cancel_requested_at`); оркестратор на своём тике превращает пометки в команды
агенту (`DeleteGame`, `CancelInstall`) и применяет итоги (`GameDeleted`/`GameDeleteFailed`,
`InstallFailed`). Агент с ролью `gamestore` удаляет файлы игры из библиотеки через `.trash` на той
же ФС и присылает список приложений библиотеки в снимке `WorkerStats`.

**Tech Stack:** Bun, Effect 4 (`effect/rpc`, `effect/reactivity`), drizzle-orm 1.0 rc + Postgres,
React 19 + TanStack Router + Tailwind, `bun test` (+ Testing Library в web).

**Spec:** `docs/superpowers/specs/2026-10-28-admin-orchestration-design.md` (цели 3–4, решения
«Удаление игры», «Служебные», «Последний запуск / запусков», «Отмена установки админом»). Часть 1 —
`docs/superpowers/plans/2026-10-28-admin-part1-workers-sessions.md` (в `main` 6bc6de6).

## Global Constraints

- Тексты интерфейса — по-русски: вкладки «Игры», «Установки»; кнопки «Удалить», «Отменить»;
  диалог «Удалить <название>?» с размером; «Служебные: …» / «нужны играм, удалить нельзя»;
  причина отмены — `"Установка отменена администратором"`.
- Удалить игру нельзя, пока есть активная (не `ended`/`failed`) сессия этой игры или активная
  (`queued`/`running`) задача её установки — проверка в api, кнопка неактивна с подсказкой.
- Пока игра удаляется, новые сессии этой игры не стартуют и её установка не начинается; после
  удаления ждущая сессия ставит игру заново обычной установкой.
- Удаляются только игры из `gamestore_apps`; служебные пакеты (есть в библиотеке, нет в
  `gamestore_apps`) не удаляются никогда.
- Отмена установки админом: `queued` — сразу `failed`; `running` — `CancelInstall` агенту, задача
  `failed` с причиной `"Установка отменена администратором"` по его итогу; ждущие сессии
  завершаются с этой причиной (не возвращаются в очередь). Если агент уже переносит игру
  (`finishing`) и присылает `InstallFinished` — игра считается установленной.
- Все новые `admin.*` — в `AdminRpcs` (игрок — `Forbidden`); в ответах нет секретов Steam.
- Агент — без root; файлы, которые uid 1000 удалить не может, удаляет помощник от root (как уборка
  слоёв, `Helper.ts`).
- Тесты: БД-тесты из worktree — `bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env`
  (файл не открывать и не выводить); `bun run check`, `bun run lint` в корне.
- Коммиты: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; ветка `feat/admin-games`
  в worktree, `main` — общий чекаут.

## Review Focus

1. Удаление игры, пока сессия этой игры стоит в очереди — сессия ждёт, после удаления уходит в
   установку (Task 2).
2. Отмена админом, когда агент уже переносит игру — пришёл `InstallFinished`, игра установлена,
   ошибки нет (Task 2).
3. Агент перезапустился посреди удаления — остатки `.trash` убираются при старте, оркестратор
   повторяет `DeleteGame` после переподключения (Task 1, Task 2).
4. Повторное удаление: манифеста уже нет → `GameDeleted`; повторный `admin.games.delete` →
   `"started"` без новой пометки (Task 1, Task 3).
5. Служебный пакет (Proton 1493710) через `admin.games.delete` → `"notFound"` (Task 3).

---

### Task 1: Протокол; удаление игры и список библиотеки в агенте

**Files:**
- Modify: `packages/rpc/src/agent.ts`, `apps/agent/src/Installer.ts`,
  `apps/agent/src/OrchestratorLink.ts`, `apps/agent/src/WorkerMonitor.ts`
- Create: `apps/agent/src/GameRemoval.ts`
- Test: `apps/agent/test/gameRemoval.test.ts`, `apps/agent/test/installer.test.ts`,
  `apps/agent/test/workerMonitor.test.ts`, `packages/rpc/test/agent.test.ts`

**Interfaces:**
- Produces (`@cg/rpc`):
  - `AgentCommand` + `Schema.TaggedStruct("DeleteGame", { appId: Schema.Int })`.
  - `AgentReport` + `TaggedStruct("GameDeleted", { appId: Int })` и
    `TaggedStruct("GameDeleteFailed", { appId: Int, reason: String })`.
  - `WorkerStats` + `library: Schema.optional(Schema.Array(LibraryApp))`,
    `LibraryApp = { appId: int; name: string; sizeBytes: number }` (экспортировать).
- Produces (`apps/agent/src/GameRemoval.ts`):
  - `TRASH_DIR = ".trash"` — `<LIBRARY_DIR>/.trash` (вне `steamapps`, сессии его не видят).
  - `scanLibrary(steamapps: string): Array<LibraryApp>` — каждый `appmanifest_<id>.acf`
    (`parseAppManifest` из `./steam/vdf`): `appId` из `appid`, `name`, `sizeBytes` из `SizeOnDisk`
    (нет/не число — 0); битые манифесты пропускаются.
  - `planRemoval(steamapps: string, appId: number): { manifest: string; dirs: Array<string> } |
    undefined` — `undefined`, если манифеста нет; `dirs` — существующие `common/<installdir>`
    (только при `isInstallDir(installdir)`) и `shadercache/<appId>`.
  - `moveToTrash(plan, libraryDir, stamp: string): Array<string>` — `rename` манифеста **первым**
    (Steam перестаёт считать игру установленной), затем каталогов в
    `<LIBRARY_DIR>/.trash/<appId>-<stamp>[-<n>]`; возвращает пути в корзине.
- `Installer.deleteGame(appId: number): Effect<void>` — фоном: роль без `gamestore` →
  `GameDeleteFailed` «Нет роли gamestore»; идёт установка с тем же `appId` → `GameDeleteFailed`
  «Игра сейчас устанавливается»; иначе `planRemoval` → нет плана → `GameDeleted`; есть →
  `moveToTrash`, затем очистка корзины: `fs.rm(recursive)` от uid 1000, при ошибке доступа —
  помощник от root `rm -rf` (вид `delete-game`, bind корзины) → `GameDeleted`; любая иная ошибка →
  `GameDeleteFailed` с текстом. При старте Installer (рядом с уборкой установок) корзина
  очищается тем же способом.
- `OrchestratorLink` маршрутизирует `DeleteGame` в `installer.deleteGame`.
- `WorkerMonitor` кладёт `library: scanLibrary(<LIBRARY_DIR>/steamapps)` в снимок только при роли
  `gamestore` (снимок валидируется `Schema.is`, как сейчас).

- [ ] **Step 1: Write the failing tests** (`gameRemoval.test.ts` на временном каталоге):
  - `scanLibrary`: два манифеста (`appid 2379780`, `name Balatro`, `SizeOnDisk 67108864`; `appid
    1493710`, `name Proton Experimental`) + битый файл → два элемента с этими полями.
  - `planRemoval` для `appmanifest_2379780.acf` с `installdir Balatro` и каталогами
    `common/Balatro`, `shadercache/2379780` → `dirs` с обоими; `installdir "../x"` → `dirs` без
    `common`; нет манифеста → `undefined`.
  - `moveToTrash` → в `steamapps` нет манифеста и каталогов, в `.trash` — три пути.
  - `installer.test.ts`: «DeleteGame removes manifest and files, reports GameDeleted»; «DeleteGame
    for a missing manifest reports GameDeleted»; «DeleteGame during the same app's install reports
    GameDeleteFailed»; «startup empties .trash».
  - `workerMonitor.test.ts`: роль `gamestore` → `stats.library` есть; без роли — поля нет.
  - `packages/rpc/test/agent.test.ts`: `DeleteGame`, `GameDeleted`, `GameDeleteFailed` и
    `WorkerStats` без `library` декодируются.
- [ ] **Step 2: Run** `cd apps/agent && bun test test/gameRemoval.test.ts test/installer.test.ts test/workerMonitor.test.ts`, `cd packages/rpc && bun test` — FAIL.
- [ ] **Step 3: Implement.** Новые `AgentReport`-теги в оркестраторе — `case` без действия там,
  где TS требует (обработка — Task 2).
- [ ] **Step 4: Run** agent и rpc сьюты, `bun run check`, `bun run lint` — PASS.
- [ ] **Step 5: Commit** `feat(agent): удаление игры из библиотеки и список библиотеки в снимке`.

### Task 2: Оркестратор — отмена админом, удаление игры, очередь при удалении

**Files:**
- Modify: `packages/db/src/schema/gamestore.ts`, миграция
  `cd packages/db && bunx drizzle-kit generate --name admin_games_installs`
- Modify: `apps/orchestrator/src/InstallRepo.ts`, `apps/orchestrator/src/InstallDispatcher.ts`,
  `apps/orchestrator/src/Scheduler.ts`, `apps/orchestrator/src/main.ts`
- Create: `apps/orchestrator/src/GameRepo.ts`, `apps/orchestrator/src/GameDeleter.ts`
- Test: `apps/orchestrator/test/install.test.ts`, `apps/orchestrator/test/runner.test.ts`,
  `apps/orchestrator/test/gameDeleter.test.ts`

**Interfaces:**
- Consumes: Task 1 (`DeleteGame`, `GameDeleted`, `GameDeleteFailed`).
- Produces — колонки: `install_jobs.cancel_requested_at timestamptz` (`cancelRequestedAt`),
  `gamestore_apps.deleting_at timestamptz` (`deletingAt`).
- `installErrors.cancelledByAdmin = "Установка отменена администратором"`.
- `InstallRepo.fail`: у заблокированной задачи `cancelRequestedAt !== null` → `error =
  cancelledByAdmin`, ждущим — `InstallFailed` с этой причиной, `requeueWaiters` игнорируется.
  `claimNext` не выдаёт задачи с `cancelRequestedAt`. Новый
  `InstallRepo.cancelRequestedJobs(): Effect<Array<{ id; state: "queued" | "running"; workerId:
  string | null }>>` — активные с пометкой.
- `InstallDispatcher.tick` до выдачи: `queued` с пометкой → `fail(id, cancelledByAdmin)`;
  `running` → `CancelInstall` (через `cancels`, повтор при недоставке, как у брошенных).
- `Scheduler`: `appInstalled` = есть строка `gamestore_apps` **и** `deleting_at is null`
  (`uninstalled` по-прежнему «строки нет» — удаляемая игра не ставится и не запускается, сессия
  ждёт). В `placeOne` после выбора сессии установленной игры — `select … from gamestore_apps where
  app_id = … for share` и проверка `deletingAt === null`; иначе сессию не ставить (гонка с
  пометкой api, которая держит `FOR UPDATE`).
- `GameRepo`: `deletingApps(): Effect<Array<number>>`; `markDeleted(appId): Effect<boolean>`
  (удаляет строку `gamestore_apps`, только если `deleting_at is not null`);
  `clearDeleting(appId): Effect<void>`.
- `GameDeleter` (Context.Service + `layer`, подписка на хаб, тик `DISPATCH_INTERVAL`): для каждой
  удаляемой игры, если команда ещё не доставлена текущему соединению, — `DeleteGame` первому по id
  подключённому агенту с ролью `gamestore`; `Connected` этого агента сбрасывает «доставлено»
  (повтор после переподключения). `GameDeleted` → `markDeleted` + лог; `GameDeleteFailed` →
  `clearDeleting` + `logError` с причиной. Подключить в `main.ts` рядом с `InstallDispatcher`.

- [ ] **Step 1: Write the failing tests:**
  - `install.test.ts`: «admin cancel of a queued job fails it with the admin reason and fails
    waiters»; «admin cancel of a running job sends CancelInstall, agent's InstallFailed → failed
    with the admin reason, waiters failed (not requeued)»; «admin cancel then InstallFinished →
    done, game installed»; «claimNext skips a cancel-requested job».
  - `runner.test.ts` (scheduler): «queued session of a deleting game is neither placed nor sent to
    install; after the row is deleted it starts an install».
  - `gameDeleter.test.ts` (фейковый хаб как в `runner.test.ts`): «deleting app → DeleteGame to the
    gamestore agent once per connection, resent after reconnect»; «GameDeleted removes the
    gamestore_apps row»; «GameDeleteFailed clears deleting_at».
- [ ] **Step 2: Run** `cd apps/orchestrator && bun test --env-file=…` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** orchestrator и `packages/db` сьюты (`--env-file=…`), `bun run check`, `bun run lint` — PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): отмена установки админом и удаление игр`.

### Task 3: api — `admin.games.*` и `admin.installs.*`

**Files:**
- Modify: `packages/rpc/src/admin.ts`, `apps/api/src/admin/rpc.ts`
- Create: `apps/api/src/admin/games.ts`, `apps/api/src/admin/installs.ts`
- Test: `apps/api/test/adminGames.test.ts`

**Interfaces:**
- Consumes: Task 1 (`LibraryApp`, `WorkerStats.library`), Task 2 (колонки).
- Produces (`@cg/rpc`):
  - `AdminGame = { appId: int; name: string; sizeBytes: number; installedAt: string;
    lastLaunchAt: string | null; launches: int; activeSessions: int; installing: boolean;
    deleting: boolean }`; `AdminGames = { games: Array<AdminGame> /* по размеру убыв. */;
    service: { count: int; sizeBytes: number; names: Array<string> } | null /* нет снимка
    библиотеки — null */ }`.
  - `AdminInstall = { id; appId: int; gameName: string; userName: string; workerId: string | null;
    state: "queued" | "running" | "done" | "failed"; stage: InstallStage | null;
    bytesDownloaded: number | null; bytesTotal: number | null; error: string | null;
    cancelRequested: boolean; waitingSessions: int; createdAt: string; updatedAt: string }`;
    `AdminInstalls = { active: Array<AdminInstall> /* старые сверху */; recent:
    Array<AdminInstall> /* done/failed за 7 дней по updatedAt, новые сверху, ≤ 50 */ }`.
  - RPC: `admin.games.list` → `AdminGames`; `admin.games.delete` `{ appId }` →
    `Schema.Literals(["started", "inUse", "notFound"])`; `admin.installs.list` → `AdminInstalls`;
    `admin.installs.cancel` `{ jobId }` → `boolean` (активная — `coalesce(cancel_requested_at,
    now)` и `true`; иначе `false`).
- `launches`/`lastLaunchAt` — по `sessions` этой игры с `worker_id is not null` (дошли до
  размещения); `activeSessions` — не `ended`/`failed` (`isActive` из `SessionRepo`); `installing`
  — есть активная задача. `service` — `stats.library` воркера с ролью `gamestore` (первый по id)
  минус appId из `gamestore_apps`.
- `deleteGame(appId)` одной транзакцией: строка `gamestore_apps` `FOR UPDATE` (нет → `notFound`);
  активная сессия или задача этой игры → `inUse`; иначе `deleting_at = coalesce(deleting_at,
  now)` → `started`.

- [ ] **Step 1: Write the failing tests** (`adminGames.test.ts`, харнесс как в `adminWorkers.test.ts`):
  - `games.list`: две игры (`Balatro` 64 МБ, `Peglin` 317 МБ) + сессии: 3 размещённых у Peglin
    (последняя — `lastLaunchAt`), одна `queued` без воркера (не считается в `launches`, считается в
    `activeSessions`); `stats.library` воркера `gamestore` с Proton 1493710 (1,5 ГБ) → `service =
    { count: 1, names: ["Proton Experimental"], sizeBytes }`; игры по размеру убыв.
  - `games.delete`: свободная игра → `started`, `deleting_at` выставлен, повтор → `started` и время
    не меняется; с активной сессией → `inUse`; с активной задачей → `inUse`; `1493710` (нет в
    `gamestore_apps`) → `notFound`.
  - `installs.list`: `running` с байтами и `waitingSessions: 2`, `queued`, `done` 2 дня назад,
    `failed` 10 дней назад (не в `recent`).
  - `installs.cancel`: активная → `true` и пометка один раз; `done` → `false`; неизвестный id →
    `false`.
  - Игрок получает `Forbidden` на всех четырёх методах.
- [ ] **Step 2: Run** `cd apps/api && bun test --env-file=… test/adminGames.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** весь `apps/api` (`--env-file=…`), `bun run check`, `bun run lint` — PASS.
- [ ] **Step 5: Commit** `feat(api): admin.games и admin.installs`.

### Task 4: Веб — вкладка «Игры»

**Files:**
- Modify: `apps/web/src/routes/admin.tsx` (вкладки по порядку: Воркеры, Сессии, Игры, Установки,
  Настройки), `apps/web/src/rpc.ts`
- Create: `apps/web/src/components/admin/GamesTab.tsx`
- Test: `apps/web/test/adminGames.test.tsx`

**Interfaces:**
- Consumes: Task 3; из части 1 — `Polled`, `usePolling`, `formatBytes`, `formatShortDate`,
  `formatAgo`.
- Produces: атомы `adminGamesAtom`, `adminDeleteGameAtom`, `adminInstallsAtom`,
  `adminCancelInstallAtom` (ключ реактивности `admin`, как в части 1); `GamesTab()` — по макету:
  заголовок «Игры на хранилище» и «N ГБ · M шт.» (сумма игр + служебных); колонки Игра, Размер,
  Поставлена, Последний запуск («играют сейчас» при `activeSessions > 0`, иначе дата или «—»),
  Запусков, кнопка «Удалить». Кнопка неактивна с подсказкой (`Tooltip`): `activeSessions > 0` —
  «Сейчас играют», `installing` — «Ставится», `deleting` — вместо кнопки «Удаляется…». Диалог
  «Удалить <название>?» — «<размер> освободится на хранилище. Запуск игры потом поставит её
  заново.», кнопки «Отмена» / «Удалить»; ответ `inUse` — toast «Игру сейчас используют»,
  `notFound` — «Игры уже нет». Строка «Служебные: <names через запятую>» с размером и «нужны играм,
  удалить нельзя»; `service: null` — строки нет.

- [ ] **Step 1: Write the failing test** `adminGames.test.tsx` (атомы подменяются как в
  `adminSessions.test.tsx`): видны «Balatro», «317 МБ», «играют сейчас», у игры с сессией кнопка
  «Удалить» неактивна, у удаляемой — «Удаляется…»; клик «Удалить» → диалог с «Удалить Peglin?» и
  размером → подтверждение вызывает мутацию с `{ appId: 1296610 }`; строка «Служебные: Proton
  Experimental».
- [ ] **Step 2: Run** `cd apps/web && bun test test/adminGames.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** весь `apps/web`, `bun run check`, `bun run lint` — PASS.
- [ ] **Step 5: Commit** `feat(web): админка — вкладка «Игры»`.

### Task 5: Веб — вкладка «Установки»

**Files:**
- Create: `apps/web/src/components/admin/InstallsTab.tsx`
- Modify: `apps/web/src/routes/admin.tsx`
- Test: `apps/web/test/adminInstalls.test.tsx`

**Interfaces:**
- Consumes: Task 3, Task 4 (атомы).
- Produces: `InstallsTab()` — «Сейчас» (`active`): Игра, Чей Steam (`userName`), Воркер, Этап
  (подписи этапов установки с экрана загрузки, `queued` — «В очереди»), Прогресс («45 % · 1,2 из
  2,0 ГБ», без байтов — «—»), Ждут (число сессий), кнопка «Отменить» (диалог «Отменить установку
  <название>?» — «Игроки, которые её ждут, увидят «Установка отменена администратором».»);
  `cancelRequested` — бейдж «Отменяется…» вместо кнопки; пусто — «Сейчас ничего не ставится».
  «За 7 дней» (`recent`): Игра, Чей Steam, Итог («Готово» / причина красным бейджем), Когда.

- [ ] **Step 1: Write the failing test** `adminInstalls.test.tsx`: строка `running` с «45 %» и
  «Ждут 2», `queued` — «В очереди»; клик «Отменить» → диалог → мутация с `{ jobId }`;
  `cancelRequested` → «Отменяется…»; в `recent` причина «Установка отменена администратором»;
  пустой `active` → «Сейчас ничего не ставится».
- [ ] **Step 2: Run** `cd apps/web && bun test test/adminInstalls.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** весь `apps/web`, `bun run check`, `bun run lint` — PASS.
- [ ] **Step 5: Commit** `feat(web): админка — вкладка «Установки»`.

### Task 6: Деплой и проверка на проде (контроллер)

- [ ] **Step 1:** README: раздел «Админка» — вкладки «Игры» и «Установки», что делает удаление и
  отмена; коммит `docs(deploy): админка — игры и установки`.
- [ ] **Step 2:** Мерж в `main` (ветка/статус общего чекаута), деплой из чистого worktree на
  `main` при отсутствии `cg.session`/`cg.install`.
- [ ] **Step 3: Проверка:** в БД `workers.stats->'library'` содержит 12 приложений brofrong;
  удаление Katana ZERO (460950, тестовая игра) через пометку `deleting_at` (как делает api) —
  каталог и манифест исчезли из `/raid/cloud-gaming/library/steamapps`, `.trash` пуст, строки
  `gamestore_apps` нет; отмена: поставить в очередь установку (сессия владельца на
  неустановленной игре не нужна — достаточно пометить `cancel_requested_at` у `queued`-задачи,
  если такая появится; иначе проверить тестами) — отметить в отчёте, что проверено вживую.
