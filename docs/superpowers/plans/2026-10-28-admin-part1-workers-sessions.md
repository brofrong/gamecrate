# Админка, часть 1: воркеры и сессии — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вкладки в `/admin`: «Воркеры» (железо, загрузка, диски, версии, слоты с сессиями,
«Остановить», «На обслуживание»), «Сессии» (живые + история + сбои), «Настройки»; блок «Последние
сбои» на «Воркерах».

**Architecture:** Агент собирает железо/версии при подключении (`AgentConnect.hardware/versions`)
и загрузку раз в 5 с (отчёт `WorkerStats`); оркестратор пишет последний снимок в `workers`
(jsonb), флаг `workers.draining` исключает воркер из раздачи сессий и установок. api читает БД
и отдаёт `admin.*`; страница опрашивает их раз в 5 с, пока вкладка видима.

**Tech Stack:** Bun, Effect 4 (`effect/rpc`, `effect/reactivity`), drizzle-orm 1.0 rc + Postgres,
React 19 + TanStack Router + Tailwind, `bun test` (+ Testing Library в web).

**Spec:** `docs/superpowers/specs/2026-10-28-admin-orchestration-design.md` (части «Цели» 1, 2, 6,
блок «Последние сбои», решения про метрики/GPU/диски/версии/онлайн/обслуживание/остановку).

## Global Constraints

- Тексты интерфейса — по-русски, как в макете: «Воркеры», «Сессии», «Настройки», «На
  обслуживание», «Вернуть в работу», «Остановить», «Последние сбои», «нет данных», «онлайн»,
  «офлайн».
- Ни один секрет не уходит в браузер: в ответах `admin.*` нет refresh-токенов и `accountName`
  Steam, `AGENT_TOKEN`, ключей RustFS, `PROFILE_KEY`.
- Все новые `admin.*` — в `AdminRpcs` (за `AdminMiddleware`): игрок получает `Forbidden`.
- Агент — без root и `privileged`; GPU агенту только с возможностью `utility`.
- «Остановить» из админки — тот же `sessions.stop_requested_at`, что у игрока.
- Обслуживание не трогает идущие сессии и установки; флаг переживает перезапуски.
- Загрузка — только «сейчас», без истории.
- Онлайн = снимок загрузки свежее `WORKER_ONLINE_MS = 20_000` мс (снимок приходит только по живому
  соединению агента раз в `STATS_INTERVAL = 5 s`).
- Тесты: `bun run test` в пакете (БД-тесты — `--env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env`
  при запуске из worktree; `.env` не читать и не выводить), типы — `bun run check` в корне.
- Коммиты: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; работа — в worktree на
  ветке `feat/admin-workers`, `main` — общий чекаут (см. память).

## Review Focus

1. Агент без GPU или с упавшим `nvidia-smi` — снимок без GPU (`gpus: []`), агент не падает,
   карточка пишет «нет данных» в строке GPU (Task 1, Task 5).
2. Старый агент без `hardware`/`versions`/`WorkerStats` (или воркер, ни разу не приславший
   снимок) — api отдаёт `null`, карточка показывает «нет данных», не падает (Task 3, Task 5).
3. Воркер офлайн (снимок старше 20 с) — «офлайн · сигнал N назад», полосы загрузки не показываются
   как текущие (Task 4, Task 5).
4. Обслуживание при сессии в очереди — сессия остаётся `queued` («Ждём свободный сервер»), после
   «Вернуть в работу» запускается на этом воркере (Task 3).
5. «Остановить» уже завершённой сессии или двойной клик — без ошибки, ничего не меняется
   (Task 4).

---

### Task 1: Протокол и сбор данных хоста в агенте (чистые функции)

**Files:**
- Modify: `packages/rpc/src/agent.ts` (новые схемы, поля `AgentConnect`, отчёт `WorkerStats`)
- Create: `apps/agent/src/hostProbe.ts`
- Test: `apps/agent/test/hostProbe.test.ts`, `packages/rpc/test/agent.test.ts`

**Interfaces:**
- Produces (`@cg/rpc`, все числа байтов — `Schema.Number` ≥ 0):
  - `WorkerHardware = { cpuModel: string; cpuCores: int; cpuThreads: int; memoryBytes: number;
    gpus: Array<{ name: string; memoryBytes: number }>; disks: Array<{ name: string;
    kind: "nvme" | "ssd" | "hdd" | "raid"; sizeBytes: number; raidLevel: string | null;
    members: Array<string> }> }`
  - `WorkerVersions = { agentCommit: string; sessionImage: string; driver: string | null;
    steamClientBuiltAt: string | null /* ISO */ }`
  - `WorkerStats = { cpuPercent: number; memory: { totalBytes: number; usedBytes: number;
    cacheBytes: number }; gpus: Array<{ utilPercent: number | null; encoderPercent: number | null;
    temperatureC: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null }>;
    filesystems: Array<{ purposes: Array<"scratch" | "steamClient" | "library">;
    totalBytes: number; usedBytes: number; freeBytes: number }>; uptimeSeconds: number }`
  - `AgentConnect` + `hardware: Schema.optional(WorkerHardware)`, `versions:
    Schema.optional(WorkerVersions)` (старый агент совместим).
  - `AgentReport` + `Schema.TaggedStruct("WorkerStats", { stats: WorkerStats })`.
- Produces (`apps/agent/src/hostProbe.ts`, чистые):
  - `parseCpuTimes(procStat: string): { idle: number; total: number }` — строка `cpu ` (idle =
    idle + iowait).
  - `cpuPercent(prev, next): number` — `100 * (1 - Δidle/Δtotal)`, округление до целого, `Δtotal
    = 0` → 0.
  - `parseMeminfo(text: string): WorkerStats["memory"]` — как `free`: cache = Buffers + Cached +
    SReclaimable, used = MemTotal − MemFree − cache (кБ × 1024).
  - `parseCpuInfo(text: string): { model: string; cores: number; threads: number }` — threads =
    число `processor`, cores = `cpu cores` первой записи (нет поля — threads).
  - `parseNvidiaSmi(csv: string): Array<{ name: string; memoryTotalBytes: number | null;
    memoryUsedBytes: number | null; utilPercent: number | null; encoderPercent: number | null;
    temperatureC: number | null; driver: string | null }>` — вывод
    `nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,utilization.encoder,temperature.gpu,driver_version --format=csv,noheader,nounits`
    (`NVIDIA_SMI_ARGS` экспортировать); память в МиБ; `[N/A]`/пусто → `null`.
  - `classifyBlockDevice(name, { rotational, sizeSectors, mdLevel, slaves }):
    WorkerHardware["disks"][number] | undefined` — `loop*`, `ram*`, `zram*`, `dm-*`, `sr*` и
    размер 0 → `undefined`; `nvme*` → nvme, `md*` → raid (уровень из `md/level`, члены из
    `slaves/`), rotational 1 → hdd, иначе ssd; размер = секторы × 512.

- [ ] **Step 1: Write the failing tests** — `hostProbe.test.ts`:
  - `parseMeminfo` на фрагменте с brofrong (`MemTotal: 32795732 kB`, `MemFree: 2586332 kB`,
    `Buffers: 512984 kB`, `Cached: 20599344 kB`, `SReclaimable: 1000000 kB`) →
    `totalBytes = 32795732*1024`, `cacheBytes = (512984+20599344+1000000)*1024`,
    `usedBytes = total − free − cache`.
  - `parseCpuInfo` на двух записях `processor` с `model name : AMD Ryzen 5 2600X Six-Core
    Processor`, `cpu cores : 6` → `{ model: "AMD Ryzen 5 2600X Six-Core Processor", cores: 6,
    threads: 2 }`.
  - `cpuPercent` между `cpu  100 0 100 800 0 0 0 0 0 0` и `cpu  150 0 150 900 0 0 0 0 0 0` → 50;
    одинаковые снимки → 0.
  - `parseNvidiaSmi("NVIDIA GeForce GTX 1650 SUPER, 4096, 4, 0, 0, 40, 550.163.01\n")` →
    `[{ name: "NVIDIA GeForce GTX 1650 SUPER", memoryTotalBytes: 4096*2**20, memoryUsedBytes:
    4*2**20, utilPercent: 0, encoderPercent: 0, temperatureC: 40, driver: "550.163.01" }]`;
    `"…, [N/A], …"` → соответствующее поле `null`; пустая строка → `[]`.
  - `classifyBlockDevice`: `nvme0n1` (rot 0, 488397168 сект.) → nvme; `md127` (level `raid5`,
    slaves `sda,sdb,sdd`) → `{ kind: "raid", raidLevel: "raid5", members: ["sda","sdb","sdd"] }`;
    `sda` rot 1 → hdd; `loop0` → `undefined`.
  - `packages/rpc/test/agent.test.ts`: `AgentConnect` без `hardware`/`versions` декодируется;
    `AgentReport` `{ _tag: "WorkerStats", stats }` декодируется.
- [ ] **Step 2: Run** `cd apps/agent && bun test test/hostProbe.test.ts` и `cd packages/rpc && bun test` — FAIL (нет модуля/схем).
- [ ] **Step 3: Implement** схемы в `packages/rpc/src/agent.ts` и функции в `apps/agent/src/hostProbe.ts`.
- [ ] **Step 4: Run** те же тесты + `bun run check` в корне — PASS (если `switch` по
  `AgentReport` в оркестраторе требует исчерпывающести — добавить `case "WorkerStats":` без
  действия там, где TS ругается; хранение — Task 3).
- [ ] **Step 5: Commit** `feat(agent): протокол и разбор данных хоста для админки`.

### Task 2: `WorkerMonitor` в агенте и отправка оркестратору

**Files:**
- Create: `apps/agent/src/WorkerMonitor.ts`
- Modify: `apps/agent/src/config.ts` (`agentCommit`), `apps/agent/src/OrchestratorLink.ts`,
  `apps/agent/src/main.ts`, `apps/agent/test/fakes.ts` (конфиг)
- Test: `apps/agent/test/workerMonitor.test.ts`, `apps/agent/test/link.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `config.agentCommit: string` из `CG_COMMIT`, по умолчанию `"unknown"`.
  - `HostProbe` — `Context.Reference` (по образцу `FreeSpace` в `DiskSpace.ts`) с реальной
    реализацией по умолчанию: `readText(path): Effect<string | undefined>`, `listDir(path):
    Effect<ReadonlyArray<string>>`, `fsInfo(dir): Effect<{ dev: number; totalBytes: number;
    usedBytes: number; freeBytes: number } | undefined>` (`stat().dev` + `statfs`: total = blocks ×
    bsize, free = bavail × bsize, used = (blocks − bfree) × bsize), `mtime(path): Effect<Date |
    undefined>`, `nvidiaSmi: Effect<string | undefined>` (`Bun.spawn` с `NVIDIA_SMI_ARGS`, таймаут
    5 с; нет бинаря/ошибка → `undefined`). Пути `/proc/...`, `/sys/block/...` — абсолютные.
  - `WorkerMonitor` (Context.Service) : `hardware: Effect<WorkerHardware>`, `versions:
    Effect<WorkerVersions>`, `reports: Queue.Dequeue<AgentReport>` — `Queue.sliding(1)`, фоновый
    цикл раз в `STATS_INTERVAL = Duration.seconds(5)` кладёт `{ _tag: "WorkerStats", stats }`.
    `filesystems` — каталоги `scratchDir`→`scratch`, `steamClientDir`→`steamClient`,
    `libraryDir`→`library`, сгруппированы по `dev` (одна ФС — один элемент с несколькими
    `purposes`); недоступный каталог пропускается. Первый снимок CPU — после двух замеров.
    `WorkerMonitor.layer` — без зависимостей, кроме `AgentConfig`.
  - `AgentConnect` из `OrchestratorLink` несёт `hardware` и `versions`; `monitor.reports` —
    третий источник рядом с `supervisor.reports`/`installer.reports`.

- [ ] **Step 1: Write the failing tests** (`workerMonitor.test.ts`, фейковый `HostProbe` с
  содержимым brofrong из Task 1, `TestClock`):
  - `hardware` → `cpuModel` Ryzen, `cpuThreads: 12`, `memoryBytes`, `gpus: [{ name: "NVIDIA
    GeForce GTX 1650 SUPER", memoryBytes: 4096*2**20 }]`, диски `nvme0n1`, `md127`, `sda`.
  - `versions` → `{ agentCommit: "abc1234", sessionImage: <config>, driver: "550.163.01",
    steamClientBuiltAt: "2026-10-27T23:11:00.000Z" }` (mtime фейка).
  - `nvidiaSmi` → `undefined`: `hardware.gpus = []`, `versions.driver = null`, снимок `gpus = []`.
  - `scratchDir` и `steamClientDir` с одинаковым `dev`, `libraryDir` с другим → два
    `filesystems`: `["scratch","steamClient"]` и `["library"]`.
  - После `TestClock.adjust(STATS_INTERVAL × 3)` в `reports` ровно один (последний) отчёт
    `WorkerStats` (sliding).
  - `link.test.ts`: в payload `agent.connect` есть `hardware` и `versions`; отчёт `WorkerStats`
    уходит через `agent.report`.
- [ ] **Step 2: Run** `cd apps/agent && bun test test/workerMonitor.test.ts test/link.test.ts` — FAIL.
- [ ] **Step 3: Implement** `WorkerMonitor.ts`, правки config/link/main/fakes.
- [ ] **Step 4: Run** `cd apps/agent && bun test` и `bun run check` — PASS.
- [ ] **Step 5: Commit** `feat(agent): снимок железа, версий и загрузки воркера`.

### Task 3: Оркестратор хранит снимок; обслуживание в раздаче

**Files:**
- Modify: `packages/db/src/schema/sessions.ts` (`workers`), новая миграция
  `packages/db/migrations/<ts>_admin_workers` (`cd packages/db && bunx drizzle-kit generate --name admin_workers`)
- Modify: `apps/orchestrator/src/AgentHub.ts`, `apps/orchestrator/src/Scheduler.ts` (`placeOne`),
  `apps/orchestrator/src/InstallRepo.ts` (`claimNext`)
- Test: `apps/orchestrator/test/agentHub.test.ts`, `apps/orchestrator/test/runner.test.ts`,
  `apps/orchestrator/test/install.test.ts`

**Interfaces:**
- Consumes: Task 1 (схемы).
- Produces — колонки `workers`: `roles text[] not null default '{}'`, `draining boolean not null
  default false`, `hardware jsonb` (`WorkerHardware | null`), `versions jsonb`, `stats jsonb`,
  `statsAt timestamptz` (drizzle: `roles`, `draining`, `hardware`, `versions`, `stats`,
  `statsAt`; jsonb типизировать `$type<…>()` типами из `@cg/rpc`).
- `AgentHub.upsertWorker` пишет ещё `roles`, `hardware`, `versions` (нет в payload → `null`).
  `AgentHub.report` для `WorkerStats`: если соединение текущее — `update workers set stats,
  stats_at = now`; в PubSub не публикуется. `draining` хаб не трогает.
- Раздача: в `placeOne` и `claimNext` запрос `known` добавляет `eq(workers.draining, false)`.

- [ ] **Step 1: Write the failing tests:**
  - `agentHub.test.ts` «connect stores roles, hardware and versions; WorkerStats updates stats
    and stats_at without publishing»: строка `workers` содержит `roles: ["worker","gamestore"]`,
    `hardware.cpuModel`, после отчёта — `stats.cpuPercent` и `statsAt` не `null`; подписчик
    хаба `WorkerStats` не получил. Подключение без `hardware` → `hardware: null`.
  - `runner.test.ts` (describe «scheduler») «draining worker gets no new sessions, undrain places
    the queued one»: `connectWorker` + `draining = true` → после `Scheduler.tick` сессия `queued`,
    `fake.sent` пуст; `draining = false` → `starting` на этом воркере.
  - `install.test.ts` «draining gamestore worker gets no install jobs»: задача остаётся `queued`.
- [ ] **Step 2: Run** `cd apps/orchestrator && bun test --env-file=…/.env` — FAIL.
- [ ] **Step 3: Implement** схему, миграцию, хаб, раздачу.
- [ ] **Step 4: Run** `cd apps/orchestrator && bun test --env-file=…/.env`, `cd packages/db && bun test --env-file=…/.env`, `bun run check` — PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): снимок воркера в БД и режим обслуживания`.

### Task 4: `admin.*` в api — воркеры, сессии, остановка, обслуживание

**Files:**
- Modify: `packages/rpc/src/admin.ts`
- Create: `apps/api/src/admin/workers.ts`, `apps/api/src/admin/sessions.ts`
- Modify: `apps/api/src/admin/rpc.ts`
- Test: `apps/api/test/adminWorkers.test.ts` (по образцу `settings.test.ts`: `RpcTest.makeClient(AdminRpcs)`, `DbTest`, фейковый `BetterAuth`)

**Interfaces:**
- Consumes: Task 1 (схемы), Task 3 (колонки).
- Produces (`@cg/rpc`):
  - `AdminSession = { id; userId; userName: string; appId: int; gameName: string;
    workerId: string | null; slot: int | null; state: SessionState; stage: SessionStage | null;
    createdAt: string; endedAt: string | null; lastInputAt: string | null;
    failReason: string | null }` (имя пользователя — `user.name`; почту не отдаём в части 1).
  - `AdminWorker = { id; publicIp; slots: int; roles: AgentRoles; online: boolean;
    lastSeenAt: string | null /* statsAt ?? lastSeenAt */; draining: boolean;
    hardware: WorkerHardware | null; versions: WorkerVersions | null; stats: WorkerStats | null;
    sessions: Array<AdminSession> /* активные на воркере */ }`.
  - RPC: `admin.workers.list` → `Array<AdminWorker>` (по `id`); `admin.workers.setDraining`
    `{ workerId, draining }` → `boolean` (нет воркера — `false`); `admin.sessions.list`
    `{ failedOnly: boolean }` → `{ active: Array<AdminSession>; recent: Array<AdminSession> }`
    (`recent` — завершённые за 7 дней, новые сверху, ≤ 50; `failedOnly` — только `failed`);
    `admin.sessions.stop` `{ sessionId }` → `boolean` (как `requestStop`, без проверки владельца:
    активной — `coalesce(stop_requested_at, now)`, иначе ничего; неверный id/нет — `false`).
  - `WORKER_ONLINE_MS = 20_000`; `online = statsAt !== null && now − statsAt < WORKER_ONLINE_MS`.
  - Запросы: воркеры + активные сессии одним `select` с join `user`/`games` (без N+1).

- [ ] **Step 1: Write the failing tests:**
  - «workers.list returns hardware, stats, online and active sessions»: воркер со `statsAt =
    now − 5 s` → `online: true`, со `statsAt = now − 60 s` → `false`, без снимка → `stats: null,
    online: false`; активная сессия игрока видна в `sessions` своего воркера с `gameName`.
  - «setDraining persists and returns false for unknown worker».
  - «sessions.list: active, recent within 7 days, failedOnly filters» (сессии 2 дня и 10 дней
    назад; `failed` с `failReason`).
  - «sessions.stop sets stop_requested_at once; ended session and unknown id are no-ops»: второй
    вызов не меняет время; `ended` → `stopRequestedAt` остаётся `null`.
  - «player gets Forbidden on every new admin method».
  - «admin responses never contain Steam secrets»: засеять `steam_logins` (как в
    `steamLogin.test.ts`) и проверить, что `JSON.stringify` ответов `workers.list`/`sessions.list`
    не содержит токен и имя аккаунта.
- [ ] **Step 2: Run** `cd apps/api && bun test --env-file=…/.env test/adminWorkers.test.ts` — FAIL.
- [ ] **Step 3: Implement** схемы, `workers.ts` (`listWorkers(now)`, `setDraining`),
  `sessions.ts` (`listSessions(failedOnly, now)`, `adminStop(sessionId)`), хендлеры.
- [ ] **Step 4: Run** весь `apps/api` тест + `bun run check` — PASS.
- [ ] **Step 5: Commit** `feat(api): admin.workers и admin.sessions`.

### Task 5: Вкладки и «Воркеры» в вебе

**Files:**
- Modify: `apps/web/src/routes/admin.tsx` (вкладки: `validateSearch` `{ tab: "workers" |
  "sessions" | "settings" }`, по умолчанию `workers`; «Настройки сессий» — на вкладку
  «Настройки»; карточку `admin.ping` убрать — доступ уже проверяет `adminPingAtom`/роль)
- Modify: `apps/web/src/rpc.ts` (атомы)
- Create: `apps/web/src/lib/adminFormat.ts`, `apps/web/src/lib/usePolling.ts`,
  `apps/web/src/components/admin/WorkerCard.tsx`, `apps/web/src/components/admin/AdminSessionsTable.tsx`,
  `apps/web/src/components/admin/FailuresCard.tsx`
- Test: `apps/web/test/adminFormat.test.ts`, `apps/web/test/workerCard.test.tsx`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - Атомы: `adminWorkersAtom = Api.query("admin.workers.list", undefined)`,
    `adminSessionsAtom = Atom.family((failedOnly: boolean) => Api.query("admin.sessions.list",
    { failedOnly }))`, `adminStopSessionAtom = Api.mutation("admin.sessions.stop")`,
    `adminSetDrainingAtom = Api.mutation("admin.workers.setDraining")`.
  - `usePolling(atom, ms = 5000)` — `useAtomRefresh` по `setInterval`, только при
    `document.visibilityState === "visible"`.
  - `adminFormat.ts`: `formatBytes(n): string` (`"317 МБ"`, `"2,0 ГБ"`, `"7,3 ТБ"`, 1024-основа,
    одна цифра после запятой от ГБ), `formatAgo(ms): string` (`"4 с назад"`, `"12 мин назад"`,
    `"3 ч назад"`, `"2 дн назад"`), `formatDuration(ms): string` (`"12 мин"`, `"1 ч 5 мин"`),
    `diskLabel(disk)` (`"NVMe 233 ГБ"`, `"RAID5 (sda, sdb, sdd) 7,3 ТБ"`, `"HDD 3,6 ТБ"`),
    `purposeLabel(purposes)` (`scratch`+`steamClient` → «scratch и шаблон Steam», `library` →
    «библиотека игр»).
  - `WorkerCard({ worker, now, onStop(sessionId), onDraining(draining) })` — по макету: шапка
    (точка онлайн, `id`, «онлайн · сигнал … назад» / «офлайн · сигнал … назад», IP, роли
    «сессии + установки», кнопка «На обслуживание»/«Вернуть в работу» + бейдж «на обслуживании»),
    слева «Железо» и «Версии» (+ «сервер работает 11 дн 17 ч» из `stats.uptimeSeconds`), справа «Загрузка сейчас» (CPU, RAM занято + кэш, GPU % · °C ·
    видеокодер, видеопамять, по полосе на каждую ФС с `purposeLabel`), снизу «Слоты · занят N из
    M» и `AdminSessionsTable` с «Остановить». Нет снимка или офлайн — вместо полос «нет данных».
  - `AdminSessionsTable({ sessions, now, showWorker, onStop? })` — колонки Игрок, Игра, [Воркер],
    Этап (state/stage по-русски, как на экране загрузки), Идёт, Ввод, кнопка.
  - `FailuresCard({ sessions })` — «Последние сбои», «за 7 дней · N», строки дата · игрок · игра
    · причина.

- [ ] **Step 1: Write the failing tests:**
  - `adminFormat.test.ts`: `formatBytes(317*2**20) === "317 МБ"`, `formatBytes(2*2**30) ===
    "2,0 ГБ"`, `formatBytes(7.3*2**40) === "7,3 ТБ"`; `formatAgo(4000) === "4 с назад"`;
    `formatDuration(65*60_000) === "1 ч 5 мин"`; `diskLabel` для md127 из Task 1 →
    `"RAID5 (sda, sdb, sdd) …"`.
  - `workerCard.test.tsx`: с фикстурой brofrong — видны «AMD Ryzen 5 2600X», «12 потоков»,
    «GeForce GTX 1650 Super» (имя как пришло), «scratch и шаблон Steam», «библиотека игр»,
    «Слоты · занят 1 из 1», клик «Остановить» вызывает `onStop("s1")`, клик «На обслуживание» —
    `onDraining(true)`; `stats: null` → «нет данных», `online: false` → «офлайн»;
    `hardware.gpus = []` → строка GPU «нет данных».
- [ ] **Step 2: Run** `cd apps/web && bun test test/adminFormat.test.ts test/workerCard.test.tsx` — FAIL.
- [ ] **Step 3: Implement** файлы; страница: вкладка «Воркеры» — `WorkerCard` на каждый воркер
  (`usePolling(adminWorkersAtom)`), под ними `FailuresCard` из `adminSessionsAtom(true)`;
  «Остановить» — `AlertDialog` «Остановить сессию?» (профиль сохранится), успех/ошибка — `toast`.
- [ ] **Step 4: Run** `cd apps/web && bun test` + `bun run check` — PASS.
- [ ] **Step 5: Commit** `feat(web): админка — вкладки и воркеры`.

### Task 6: Вкладка «Сессии»

**Files:**
- Create: `apps/web/src/components/admin/SessionsTab.tsx`
- Modify: `apps/web/src/routes/admin.tsx`
- Test: `apps/web/test/adminSessions.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`AdminSessionsTable`, атомы, `usePolling`).
- Produces: `SessionsTab()` — «Сейчас идут» (`active`, со столбцом «Воркер» и «Остановить»;
  пусто — «Сейчас никто не играет»), «История за 7 дней» (`recent`) с переключателем «Только
  сбои» (`adminSessionsAtom(failedOnly)`), у `failed` — причина красным бейджем.

- [ ] **Step 1: Write the failing test** `adminSessions.test.tsx` (атомы подменяются, как в
  `appPages.test.tsx`): видны строки active с воркером `brofrong`; «Только сбои» показывает
  только строку с «Не удалось остановить игровой сервер»; пустой `active` → «Сейчас никто не
  играет».
- [ ] **Step 2: Run** `cd apps/web && bun test test/adminSessions.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd apps/web && bun test` + `bun run check` — PASS.
- [ ] **Step 5: Commit** `feat(web): админка — вкладка «Сессии»`.

### Task 7: Деплой: GPU и шаблон для агента, коммит, проверка на проде

**Files:**
- Modify: `deploy/compose.yaml` (`cg-agent`: `CG_COMMIT: ${CG_COMMIT:-unknown}`; GPU —
  `deploy.resources.reservations.devices: [{ driver: nvidia, count: all, capabilities: [utility] }]`;
  bind `${STEAM_CLIENT_DIR:-/home/brofrong/cloud-gaming-steam/client}` по тому же пути,
  `read_only: true`, `create_host_path: false`; поправить комментарий «в агент не монтируется»)
- Modify: `deploy/deploy.sh` (локально `commit="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"`,
  `-dirty` при незакоммиченных изменениях; `CG_COMMIT=${commit}` в окружение `docker compose up`)
- Modify: `deploy/README.md` (переменные `cg-agent`, GPU `utility`, монтирование шаблона на чтение,
  раздел «Админка»: что показывает, «На обслуживание» перед деплоем)

- [ ] **Step 1:** `bash -n deploy/deploy.sh`; на brofrong проверить, что compose принимает
  блок GPU: `ssh brofrong 'cd ~/cloud-gaming && docker compose -f deploy/compose.yaml --env-file .env config >/dev/null && echo ok'` (после rsync — делает `deploy.sh`; локально Docker нет).
- [ ] **Step 2: Commit** `chore(deploy): агенту GPU utility, шаблон на чтение, CG_COMMIT`.
- [ ] **Step 3:** Мерж в `main` (проверить ветку/статус общего чекаута), деплой из чистого
  worktree на `main` — только когда нет `cg.session`/`cg.install` (`deploy.sh` проверяет сам).
- [ ] **Step 4: Проверка на проде** (`https://game.brofrong.ru/admin`, владелец или
  `preview_*` только если владелец попросит): железо — Ryzen 5 2600X, 12 потоков, 31 ГБ, GTX 1650
  Super 4 ГБ, NVMe 233 ГБ, RAID5 7,3 ТБ; версии — коммит деплоя, `cg-session:550.163.01`, драйвер
  550.163.01, дата шаблона 28.10; `docker exec cg-agent nvidia-smi -L` работает; во время тестовой
  сессии (`deploy/measure-session-start.sh <owner> 1295320 1`) карточка показывает сессию и
  растущую загрузку GPU, «Остановить» из админки завершает её с `profileSaved: true` в логе
  агента; «На обслуживание» → новая сессия ждёт «Ждём свободный сервер», «Вернуть в работу» →
  стартует.
