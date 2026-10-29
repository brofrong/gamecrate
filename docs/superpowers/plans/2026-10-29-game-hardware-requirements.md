# Требования игр к железу и классы воркеров — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Игра запускается только на воркере допустимого пользователю класса, чьё железо на слот
покрывает её требования; агент замеряет ресурсы и исход каждой сессии; админ ведёт классы,
требования и видит замеры с предложением требований.

**Architecture:** Общая логика допуска (`allowedClasses`, `fitsRequirements`, выборка подходящих
воркеров) — в `@cg/db`, её зовут планировщик оркестратора и api (`session.start`, `library.game`).
Агент раз в 10 с снимает показатели контейнера сессии и шлёт накопленное сообщением
`SessionMetrics`; исход игры приходит полем `end` в `GameState`; оркестратор пишет
`session_metrics`. Админка — новые RPC `admin.classes.*`, `admin.workers.setClass`,
`admin.games.requirements*`.

**Tech Stack:** Bun, Effect 4, drizzle-orm 1.0 rc + Postgres, React 19, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-29-game-hardware-requirements-design.md`

## Global Constraints

- Тексты — по-русски. Игроку: `"Сейчас нет подходящего сервера"`. В админке: `"Без класса — сессий не берёт"`,
  `"нет данных, запускается только на самом сильном классе"`,
  `"На <GPU> игра падает в N% сессий — поднять минимум VRAM выше <X> GB?"`.
- Миграция создаёт класс `"Стандарт"` с `rank = 1` и назначает его всем существующим воркерам.
- Железо на слот = поле `workers.hardware` / `workers.slots`; VRAM — `gpus[0].memoryBytes`.
- Воркер «на связи» для пометки «недоступна» — подключён или `last_seen_at`/`stats_at` не старше
  10 минут (`WORKER_RECENT_MS = 10 * 60 * 1000`).
- Планировщик перебирает не больше 50 `queued`-сессий за одно размещение (`PLACE_SCAN = 50`).
- Агент: замер раз в 10 с (`METRICS_SAMPLE = 10 s`), отправка раз в 60 с и при конце игры
  (`METRICS_FLUSH = 60 s`).
- Админка: сессии в статистике — с игрой ≥ 300 с; предложение — при ≥ 3 таких сессиях,
  p95 × 1,2, VRAM вверх до 0,5 GiB, RAM вверх до 1 GiB, потоки вверх до целого; подсказка о
  падениях — ≥ 3 сессий на модели GPU и доля `crash` ≥ 0,3.
- `game_end` ∈ `quit | crash | error | stopped | unknown`.
- Тесты: БД-тесты из worktree — `bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env`
  (файл не открывать и не выводить); `bun run check --force`, `bun run lint` в корне.
- Ветка `feat/hw-requirements` в отдельном worktree (основной checkout делят другие сессии).
  Коммиты заканчиваются `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- brofrong не перезагружать и конфиг хоста не менять; в Task 1 — только чтение и временные
  контейнеры.

## Review Focus

1. **Существующие тесты оркестратора без класса у воркера.** `connectWorker` в тестах вставляет
   воркер без `class_id` — после Task 4 он не берёт сессии, и десятки тестов `runner.test.ts`
   упадут не по делу. Вспомогательная функция обязана назначать класс по умолчанию (Task 4, шаг 1).
2. **Воркер подключился заново после миграции.** Upsert в `AgentHub` не должен затирать
   `class_id` (Task 2, тест `hub upsert keeps class_id`).
3. **Старый агент без `hardware`.** Игра с нулевыми требованиями на нём запускается, с ненулевыми —
   нет; `null` не должен падать в делении (Task 3, тест `worker without hardware`).
4. **Отчёты после конца сессии.** `SessionMetrics` может прийти после `Stopped` (отправка в
   финале) — upsert не должен требовать активной сессии и не должен затирать уже записанный
   `game_end` (Task 6, тест `late metrics keep game_end`).
5. **Удаление класса, на котором стоит воркер.** FK `on delete restrict` → RPC возвращает
   `"inUse"`, а не 500 (Task 8, тест `delete class with workers`).

---

### Task 1: Ручная проверка на brofrong — источник VRAM и `LaunchOptions`

Без кода в репозитории; итог — две записи в разделе «Итоги Task 1» в конце этого файла, от них
зависят Task 6 и Task 7.

- [ ] **Step 1: VRAM по процессу из контейнера агента.** На brofrong, пока жив `bbport-spike`:
  `docker exec cg-agent nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader` и
  `curl --unix-socket /var/run/docker.sock http://localhost/containers/bbport-spike/top`. Есть
  совпадающий host PID — источник `process` работает. Пустой список или PID не совпадают —
  только `gpu_total`.
- [ ] **Step 2: `LaunchOptions` у Steam-игры.** Во временном контейнере `cg-session` с профилем
  тестового аккаунта: до старта Steam прописать в
  `~/.local/share/Steam/userdata/<id>/config/localconfig.vdf` ключ
  `UserLocalConfigStore/Software/Valve/Steam/apps/<appId>/LaunchOptions` =
  `"/usr/local/bin/cg-game-exit %command%"` (обёртка — заглушка `echo "$@" >/tmp/x; exec "$@"`),
  запустить `steam -applaunch <appId>`, проверить `/tmp/x`. Записать: держится ли ключ и
  запускается ли через него игра (нативная и Proton).
- [ ] **Step 3: Записать итоги** в конец файла, удалить временный контейнер, закоммитить план.

```bash
git add docs/superpowers/plans/2026-10-29-game-hardware-requirements.md
git commit -m "docs(plan): итоги проверки источника VRAM и LaunchOptions"
```

---

### Task 2: Схема БД и миграция

**Files:**
- Modify: `packages/db/src/schema/sessions.ts` (таблицы `workerClasses`, `sessionMetrics`, поле `workers.classId`)
- Modify: `packages/db/src/schema/gamestore.ts` (таблица `gameRequirements`)
- Create: `packages/db/migrations/<timestamp>_hw_requirements/` (`bunx drizzle-kit generate --name hw_requirements` в `packages/db`, затем дописать в SQL вставку класса)
- Test: `packages/db/test/schema.test.ts`, `apps/orchestrator/test/agentHub.test.ts`

**Interfaces:**
- Produces:
  - `workerClasses`: `id: uuid pk default gen_random_uuid()`, `name: text unique not null`, `rank: integer unique not null`, `createdAt`.
  - `workers.classId: uuid null references workerClasses.id on delete restrict`.
  - `gameRequirements`: `appId integer pk references games.appId`, `minVramBytes bigint(number)`, `minRamBytes bigint(number)`, `minCpuThreads integer`, `updatedBy text references user.id on delete set null`, `updatedAt`.
  - `sessionMetrics`: поля из спеки §1.3; `sessionId text pk references sessions.id on delete cascade`; `gameEnd text null` с типом `GameEnd`.
  - `export const gameEnds = ["quit","crash","error","stopped","unknown"] as const; export type GameEnd`.

- [ ] **Step 1: Тесты.** В `schema.test.ts`: `"migration seeds class Стандарт rank 1"` — после
  миграций в `worker_classes` ровно одна строка `{ name: "Стандарт", rank: 1 }`. Миграция назначает
  класс существующим воркерам SQL-ом `update workers set class_id = (select id from worker_classes where rank = 1)`;
  проверить его отдельно: вставить воркер, выполнить этот же `update`, `class_id` не `null`. В
  `agentHub.test.ts`: `"hub upsert keeps class_id"` — воркер с `class_id`, повторный `connect` того
  же `workerId` → `class_id` прежний.
- [ ] **Step 2:** `bun test packages/db/test/schema.test.ts apps/orchestrator/test/agentHub.test.ts` — FAIL (нет таблицы).
- [ ] **Step 3: Схема + миграция.** Сгенерировать, в конец SQL дописать
  `insert into worker_classes (name, rank) values ('Стандарт', 1);` и `update workers set class_id = …`.
- [ ] **Step 4:** те же тесты — PASS; `bun run check --force`.
- [ ] **Step 5: Commit** `feat(db): классы воркеров, требования игр, замеры сессий`.

---

### Task 3: Допуск — `allowedClasses`, `fitsRequirements`, `eligibleWorkers`

**Files:**
- Create: `packages/db/src/placement.ts` (экспорт из `packages/db/src/index.ts`)
- Test: `packages/db/test/placement.test.ts`

**Interfaces:**
- Consumes: таблицы Task 2.
- Produces:
  - `type Requirements = { minVramBytes: number; minRamBytes: number; minCpuThreads: number }`
  - `fitsRequirements(hardware: WorkerHardware | null, slots: number, req: Requirements): boolean` — чистая; нулевые требования проходят всегда (и при `hardware = null`); иначе `null` → `false`; `slots < 1` считать как 1.
  - `allowedClasses(userId: string): Effect<ReadonlyArray<{ id: string; name: string; rank: number }>, never, Db>` — сейчас все классы по `rank desc`; комментарий: место тарифов (спека §2.4).
  - `eligibleWorkers(userId: string, appId: number, opts: { workerIds: ReadonlyArray<string> }): Effect<ReadonlyArray<{ id: string; rank: number; slots: number }>, never, Db>` — из `opts.workerIds`: не `draining`, `class_id` в `allowedClasses`, железо подходит (есть строка `game_requirements` → `fitsRequirements`; нет → только класс с наибольшим `rank` среди допустимых классов, у которых есть хоть один воркер не на обслуживании). Порядок: `rank desc, id asc`. Свободные слоты не проверяет.

- [ ] **Step 1: Тесты** (`placement.test.ts`):
  - `fitsRequirements`: `"8 GiB VRAM card with 2 slots fails 6 GiB requirement"`, `"zero requirements pass worker without hardware"`, `"worker without hardware fails non-zero requirement"`, RAM и потоки — по одному случаю на границе (`≥` проходит).
  - `eligibleWorkers`: `"worker without class is excluded"`, `"draining excluded"`, `"order by rank desc then id"`, `"game without requirements only on strongest class with workers"` (классы rank 1 и 2, у rank 2 воркер на обслуживании → годится класс 1), `"too small worker excluded by requirements"`.
- [ ] **Step 2:** `bun test packages/db/test/placement.test.ts` — FAIL.
- [ ] **Step 3: Реализация** в `placement.ts`.
- [ ] **Step 4:** PASS; `bun run check --force`.
- [ ] **Step 5: Commit** `feat(db): допуск игры на воркер по классу и железу`.

---

### Task 4: Планировщик — подходящие воркеры, порядок, очередь без затора

**Files:**
- Modify: `apps/orchestrator/src/Scheduler.ts` (`placeOne`, `lockOldestQueued`)
- Create: `apps/orchestrator/test/support.ts` (вынести из `runner.test.ts`: `makeFakeHub`, `run`, `connectWorker`, `seedUsers`, `insertSession`, `like`, `at`)
- Create: `apps/orchestrator/test/scheduler.test.ts`
- Modify: `apps/orchestrator/test/runner.test.ts`, `apps/orchestrator/test/install.test.ts` (импорт из `support.ts`)

**Interfaces:**
- Consumes: `eligibleWorkers` (Task 3).
- Produces: `PLACE_SCAN = 50` (экспорт из `Scheduler.ts`); `connectWorker(fake, workerId, slots, opts?: { classRank?: number | null; hardware?: WorkerHardware })` в `support.ts` — по умолчанию класс `"Стандарт"` (`rank 1`), `classRank: null` — без класса.

- [ ] **Step 1: Вынести помощники** в `support.ts`; `connectWorker` назначает класс по умолчанию.
  `bun test apps/orchestrator/test` — всё PASS, как до правки.
- [ ] **Step 2: Тесты** (`scheduler.test.ts`):
  - `"worker without class gets no session"`
  - `"session goes to strongest allowed class first"` — классы rank 1 и 2, по свободному воркеру, сессия игры с требованиями → воркер rank 2.
  - `"requirements above worker per-slot hardware keep session queued"` — воркер 4 GiB, `SLOTS=1`, требование 6 GiB → `queued`, StartSession не отправлен.
  - `"game without requirements waits for strongest class"` — воркер rank 2 занят, rank 1 свободен → `queued`.
  - `"old unplaceable session does not block a newer one"` — старая сессия тяжёлой игры, новая лёгкой; свободен только слабый воркер → размещена новая, старая `queued`.
- [ ] **Step 3:** `bun test apps/orchestrator/test/scheduler.test.ts` — FAIL.
- [ ] **Step 4: Реализация.** Ветка размещения: выбрать до `PLACE_SCAN` `queued`-сессий установленной
  игры (`created_at asc`, `FOR UPDATE SKIP LOCKED`), по каждой — `eligibleWorkers(userId, appId, { workerIds: candidates })`,
  первый воркер со свободным слотом. Нашёлся — размещение как сейчас (та же транзакция). Нет — следующая
  сессия. Сессии, которые просмотрели и не разместили, остаются заблокированными только до конца
  транзакции. Ветка установки и `blockedFailure` — без изменений.
- [ ] **Step 5:** `bun test apps/orchestrator/test` — PASS; `bun run check --force`.
- [ ] **Step 6: Commit** `feat(orchestrator): размещение по классам и требованиям к железу`.

---

### Task 5: Сайт — «Сейчас нет подходящего сервера»

**Files:**
- Modify: `packages/db/src/placement.ts` (`gameAvailable`)
- Modify: `packages/rpc/src/library.ts` (`GameView.available`), `packages/rpc/src/session.ts` (ошибка `NoServer`)
- Modify: `apps/api/src/library/GameService.ts` (`gameView`), `apps/api/src/session/SessionRepo.ts` (`startSession`), `apps/api/src/session/rpc.ts`
- Modify: `apps/web/src/lib/cardAction.ts`, `apps/web/src/components/app/game/GameHero.tsx`
- Test: `packages/db/test/placement.test.ts`, `apps/api/test/game.test.ts`, `apps/api/test/session.test.ts`, `apps/web/test/cardAction.test.ts`, `apps/web/test/gamePage.test.tsx`

**Interfaces:**
- Consumes: `eligibleWorkers` (Task 3).
- Produces:
  - `gameAvailable(userId: string, appId: number, now: Date): Effect<boolean, never, Db>` — `eligibleWorkers` по воркерам с `last_seen_at` или `stats_at` не старше `WORKER_RECENT_MS` (константа в `placement.ts`). Подключённость api не знает — хватает этих полей (хаб пишет `last_seen_at`, монитор — `stats_at` раз в ~5 с).
  - `GameView.available: Schema.Boolean`.
  - `class NoServer extends Schema.TaggedError<NoServer>()("NoServer", {})`; `noServerReason = "Сейчас нет подходящего сервера"`; `session.start` error — `Union([GameNotOwned, AccessDenied, NoServer])`; `startSession` возвращает ещё `"NoServer"` (проверка после `ownsGame`, до вставки; уже активная сессия возвращается как раньше, без проверки).
  - `CardAction` получает вариант `{ kind: "unavailable" }`; `cardAction(game: { appId: number; available: boolean }, play)` — `resume` и `blocked` важнее, затем `available === false` → `unavailable`.

Флаг в `LibraryEntry` не нужен: у плиток нет кнопки запуска (запуск только со страницы игры),
плитка остаётся в каталоге как есть.

- [ ] **Step 1: Тесты.**
  - `placement.test.ts`: `"worker seen 11 minutes ago does not make game available"`, `"stats_at 1 minute ago does"`.
  - `game.test.ts`: `"game view says unavailable without a fitting worker"`.
  - `session.test.ts`: `"session.start fails with NoServer and inserts nothing"`; `"active session is returned even if game became unavailable"`.
  - `cardAction.test.ts`: `"unavailable game gives unavailable"`, `"resume wins over unavailable"`.
  - `gamePage.test.tsx`: кнопка `Играть` с `disabled` и текст `Сейчас нет подходящего сервера`.
- [ ] **Step 2:** запустить эти тесты — FAIL.
- [ ] **Step 3: Реализация.** В `GameHero` вариант `unavailable` — та же кнопка `disabled`, под ней подпись.
- [ ] **Step 4:** тесты — PASS; `bun run check --force`; `bun run lint`.
- [ ] **Step 5: Commit** `feat: игра недоступна без подходящего воркера`.

---

### Task 6: Замеры ресурсов — агент и оркестратор

**Files:**
- Modify: `apps/agent/src/DockerClient.ts` (`stats`, `top`), `apps/agent/test/fakes.ts`
- Modify: `apps/agent/src/hostProbe.ts` (`NVIDIA_SMI_APPS_ARGS`, `parseComputeApps`)
- Create: `apps/agent/src/SessionMetrics.ts`
- Modify: `apps/agent/src/SessionSupervisor.ts` (сэмплер на время `watchGame`)
- Modify: `packages/rpc/src/agent.ts` (`AgentReport` `SessionMetrics`)
- Create: `apps/orchestrator/src/MetricsRepo.ts`; Modify: `apps/orchestrator/src/SessionRunner.ts`
- Test: `apps/agent/test/sessionMetrics.test.ts`, `apps/agent/test/hostProbe.test.ts`, `apps/agent/test/supervisor.test.ts`, `apps/orchestrator/test/metrics.test.ts`

**Interfaces:**
- Consumes: «Итоги Task 1» (есть ли источник `process`).
- Produces:
  - `DockerClientShape.stats(name): Effect<{ memoryBytes: number; cpuNanos: number; systemNanos: number; onlineCpus: number }, DockerError>` — `GET /containers/{name}/stats?stream=false`, память = `usage − inactive_file`.
  - `DockerClientShape.top(name): Effect<ReadonlyArray<number>, DockerError>` — host PID из `/containers/{name}/top`.
  - `class MetricsAccumulator` в `SessionMetrics.ts`: `add(sample: { vramBytes: number | null; ramBytes: number | null; cpuCores: number | null; gpuUtil: number | null }, seconds: number): void`, `snapshot(): SessionMetricsReport` (максимумы VRAM/RAM, p95 CPU и GPU — по ближайшему рангу, `gameSeconds`, `vramSource`). VRAM `gpu_total` = занято на карте − значение до старта игры (снимается при `Game started`), не меньше 0.
  - `AgentReport` `SessionMetrics`: `{ sessionId, gameSeconds, peakVramBytes: NullOr(Number), peakRamBytes: NullOr(Number), cpuCoresP95: NullOr(Number), gpuUtilP95: NullOr(Number), vramSource: Literals(["process","gpu_total"]) }`.
  - `MetricsRepo.upsertMetrics(workerId, report, now)` — вставка строки (`app_id` из `sessions`, `gpu_name` из `workers.hardware.gpus[0].name`, `worker_class_id`/`slots` из `workers`) или обновление ресурсных полей; `game_end` не трогает; сессии другого воркера — игнор.

- [ ] **Step 1: Тесты.**
  - `sessionMetrics.test.ts`: `"keeps maxima and p95"` (20 замеров CPU 1..20 → p95 = 19), `"null samples are skipped"`, `"gpu_total subtracts baseline and never goes negative"`.
  - `hostProbe.test.ts`: разбор вывода `--query-compute-apps` (в т.ч. пустой и `[N/A]`).
  - `supervisor.test.ts`: `"game run sends SessionMetrics every 60 s and on exit"` (фейковые часы, фейковые `stats`/`top`/`nvidia-smi`).
  - `metrics.test.ts`: `"first report inserts row with gpu and class"`, `"late metrics keep game_end"`, `"report from another worker is ignored"`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Реализация.** Сэмплер — отдельный fiber рядом с `watchGame`, раз в `METRICS_SAMPLE`;
  сбой одного замера — `null` в этом поле и `logWarning`, сессию не валит. Последний `snapshot` отправляется
  в финале `watchGame` (игра закрылась) и в `finish` (остановка).
- [ ] **Step 4:** `bun test apps/agent/test apps/orchestrator/test` — PASS; `bun run check --force`.
- [ ] **Step 5: Commit** `feat: замеры ресурсов игры по сессии`.

---

### Task 7: Чем закончилась игра

**Files:**
- Create: `images/session/cg-game-exit` (+ строка `COPY` в `images/session/Dockerfile`)
- Modify: `apps/agent/src/steam/seedContainer.ts` (если Task 1 подтвердил `LaunchOptions`: `setLaunchOptions`, `clearLaunchOptions`), `apps/agent/src/SessionSupervisor.ts`
- Modify: `packages/rpc/src/agent.ts` (`GameState.end: optional(GameEnd)`)
- Modify: `apps/orchestrator/src/MetricsRepo.ts` (`setGameEnd`), `apps/orchestrator/src/SessionRunner.ts`
- Test: `apps/agent/test/cgGameExit.test.ts`, `apps/agent/test/seedContainer.test.ts`, `apps/agent/test/supervisor.test.ts`, `apps/orchestrator/test/metrics.test.ts`

**Interfaces:**
- Consumes: `MetricsRepo` (Task 6), `gameEnds` (Task 2).
- Produces:
  - `cg-game-exit <cmd…>`: запускает команду, пишет в `/tmp/cg-game-exit` (путь — `CG_GAME_EXIT_FILE`, для тестов) одну строку `code <n>` или `signal <n>`, выходит с тем же статусом.
  - `parseGameExit(text: string): "quit" | "crash" | "error" | "unknown"` в `SessionSupervisor.ts`: `code 0` → `quit`, `code n≠0` → `error`, но `128+n` → `crash` (bash так отдаёт смерть от сигнала), `signal n` → `crash`, иначе `unknown`.
  - `MetricsRepo.setGameEnd(sessionId, end)` — пишет, только если `game_end is null`.
  - В `SessionRunner`: `GameState{running:false, end}` → `setGameEnd(end ?? "unknown")`; `Stopped` / `Failed` → `setGameEnd("crash")` при причине `failReasons.containerGone` агента, иначе `setGameEnd("stopped")`.

- [ ] **Step 1: Тесты.**
  - `cgGameExit.test.ts`: `exit 0` → `code 0`, `exit 3` → `code 3`, `kill -SEGV $$` → `signal 11` (или `code 139`), статус выхода сохранён.
  - `supervisor.test.ts`: `parseGameExit` на все ветки; GameState после выхода несёт `end`.
  - `seedContainer.test.ts` (если `LaunchOptions` подтверждены): ключ пишется в `localconfig.vdf` контейнера и убирается перед сохранением профиля; существующие опции игрока сохраняются (обёртка ставится в начало, при снятии — исходная строка).
  - `metrics.test.ts`: `"stop after quit keeps quit"`, `"containerGone gives crash"`, `"stop before exit gives stopped"`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Реализация.** Если Task 1 показал, что `LaunchOptions` не держится, — без
  `setLaunchOptions`: для Steam-игр `end` = `unknown` (обёртку будут звать свои сборки, следующая спека).
- [ ] **Step 4:** PASS; `bun run check --force`.
- [ ] **Step 5: Commit** `feat: исход игры в замерах сессии`.

---

### Task 8: Админка — классы воркеров

**Files:**
- Create: `apps/api/src/admin/classes.ts`; Modify: `apps/api/src/admin/rpc.ts`, `apps/api/src/admin/workers.ts`
- Modify: `packages/rpc/src/admin.ts`
- Create: `apps/web/src/components/admin/ClassesCard.tsx`; Modify: `apps/web/src/components/admin/WorkerCard.tsx` и вкладку воркеров в `apps/web/src/routes/admin.tsx`
- Test: `apps/api/test/adminClasses.test.ts`, `apps/web/test/workerCard.test.tsx`, `apps/web/test/adminClasses.test.tsx`

**Interfaces:**
- Produces:
  - `AdminWorkerClass = Struct({ id, name, rank: Int, workers: Int })`; `AdminWorker.classId: NullOr(String)`.
  - RPC: `admin.classes.list` → `Array(AdminWorkerClass)` (по `rank desc`); `admin.classes.create({ name })` → новый класс самым слабым (`rank = min − 1`, пустой список → 1), `"duplicate"` при занятом имени; `admin.classes.rename({ id, name })` → `"ok" | "duplicate" | "notFound"`; `admin.classes.move({ id, direction: "up" | "down" })` → обмен `rank` с соседом в одной транзакции (`"ok" | "edge" | "notFound"`); `admin.classes.delete({ id })` → `"ok" | "inUse" | "notFound"`; `admin.workers.setClass({ workerId, classId: NullOr(String) })` → `Boolean`.

- [ ] **Step 1: Тесты.** `adminClasses.test.ts`: create/rename/duplicate, `move` меняет порядок и `"edge"` у крайнего, `"delete class with workers"` → `"inUse"`, `setClass` и `null`. `workerCard.test.tsx`: выбор класса, пометка `Без класса — сессий не берёт`. `adminClasses.test.tsx`: список по силе, кнопки вверх/вниз/удалить.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Реализация.** Обмен `rank` при уникальном индексе — через временное значение
  (`rank = -2147483648`) в той же транзакции.
- [ ] **Step 4:** PASS; `bun run check --force`; `bun run lint`.
- [ ] **Step 5: Commit** `feat(admin): классы воркеров`.

---

### Task 9: Админка — требования и замеры игры

**Files:**
- Create: `apps/api/src/admin/requirements.ts`; Modify: `apps/api/src/admin/rpc.ts`
- Modify: `packages/rpc/src/admin.ts`
- Create: `apps/web/src/components/admin/GameRequirementsPanel.tsx`, `apps/web/src/lib/requirementsSuggest.ts`; Modify: `apps/web/src/components/admin/GamesTab.tsx` (строка игры раскрывается в панель)
- Test: `apps/api/test/adminRequirements.test.ts`, `apps/web/test/requirementsSuggest.test.ts`, `apps/web/test/adminGames.test.tsx`

**Interfaces:**
- Produces:
  - `AdminGameMetricsRow = Struct({ gpuName, className: NullOr(String), sessions: Int, vramP95: NullOr(Number), ramP95: NullOr(Number), cpuP95: NullOr(Number), gpuUtilP95: NullOr(Number), crashShare: Number, otherShare: Number, vramSources: Array(Literals(["process","gpu_total"])), perSlotVramBytes: NullOr(Number) })`.
  - `AdminGameRequirements = Struct({ requirements: NullOr(Requirements), rows: Array(AdminGameMetricsRow), overall: Struct({ sessions: Int, vramP95, ramP95, cpuP95 }) })`.
  - RPC `admin.games.requirements({ appId })` → `AdminGameRequirements` (только сессии с `game_seconds ≥ 300`, p95 — `percentile_cont(0.95)` в SQL, группировка по `gpu_name`); `admin.games.setRequirements({ appId, requirements: NullOr(Requirements) })` → `Boolean` (`null` — удалить строку; `updated_by` — текущий админ).
  - `suggestRequirements(overall): Requirements | null` в `requirementsSuggest.ts` (≥ 3 сессий, × 1,2, округления из Global Constraints); `crashHints(rows): ReadonlyArray<{ gpuName: string; share: number; suggestVramBytes: number }>` — `perSlotVramBytes + 0,5 GiB`.

- [ ] **Step 1: Тесты.** `adminRequirements.test.ts`: короткие сессии (< 300 с) не учитываются, группировка по GPU, доли `crash`, set/clear требований. `requirementsSuggest.test.ts`: `"2 sessions give no suggestion"`, `"vram 3.3 GiB p95 suggests 4.0 GiB"` (3,3 × 1,2 = 3,96 → 4,0), `"ram rounds up to whole GiB"`, `"cpu 2.1 cores suggests 3 threads"`, `crashHints` на пороге 0,3 и 3 сессиях. `adminGames.test.tsx`: панель показывает `нет данных, запускается только на самом сильном классе`, «Принять» заполняет поля, строку подсказки о падениях.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Реализация.** Поля в GB с одной цифрой после запятой; сохранение переводит в байты (`GiB`).
- [ ] **Step 4:** PASS; `bun run check --force`; `bun run lint`; `bun run test` в корне.
- [ ] **Step 5: Commit** `feat(admin): требования игры и замеры по GPU`.

---

## Итоги Task 1

Проверено 2026-10-29 на brofrong (во время настоящей сессии игрока, The Witness через Proton).

- **Источник VRAM `process` работает.** `nvidia-smi` в контейнере `cg-agent` отдаёт host PID (те же,
  что на хосте), и они совпадают с PID из `docker top` контейнера сессии (`witness64_d3d11` —
  1885732 в обоих). Но `--query-compute-apps` показывает только процессы `C`/`C+G`; чисто
  графические (`G`: Xwayland, labwc, часть игр) видны только в `nvidia-smi -q -x -d PIDS`.
  **Поправка к Task 6:** VRAM сессии = сумма `used_memory` всех процессов (`C`, `G`, `C+G`) из
  XML `nvidia-smi -q -x -d PIDS`, чьи PID есть в `docker top` контейнера (сюда входит и
  кодировщик Selkies — это след сессии целиком, для допуска так и нужно). `gpu_total` — запасной
  путь, если ни один PID не совпал. Разбор — `parseGpuProcesses(xml)` в `hostProbe.ts` вместо
  `parseComputeApps`.
- **`LaunchOptions` вживую не проверены:** проверка требует второго контейнера Steam на той же
  карте, а на ней в это время играл игрок. Делаем по плану (запись в `localconfig.vdf` до старта
  Steam, снятие перед сохранением профиля) с запасным `unknown`; живую проверку — на брофронге
  после деплоя ветки, до мержа.
