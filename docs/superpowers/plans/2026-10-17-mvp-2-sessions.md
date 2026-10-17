# MVP-2: сессии — «Играть» запускает стрим — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь нажимает «Играть» на карточке игры, через ~минуту играет в неё в браузере на https://game.brofrong.ru, а система учитывает сыгранное время по правилам простоя и отключения из спеки.

**Architecture:** Три процесса делят только Postgres. `apps/api` принимает команды браузера (RPC `session.*`), пишет их в БД и проксирует веб-клиент Selkies нужной сессии на `/stream/<sessionId>/`. `apps/orchestrator` ведёт жизненный цикл сессий (чистая функция-автомат + тик раз в 5 с), выбирает слот на воркере и держит WebSocket-соединения с агентами. `apps/agent` на воркере создаёт контейнеры сессий через Docker API и сообщает о процессе игры. Изменения сессии доходят до браузера через `pg_notify` → RPC-стрим.

**Tech Stack:** как в MVP-1 (Bun 1.4.4, Turborepo, effect 4.0.5 + `effect/rpc`/`effect/http`/`effect/socket`, @effect/sql-pg 4.0.5, Drizzle 1.0.0-rc.4 с патчем, React 19.3, TanStack Router, @effect/atom-react); Docker Engine API через unix-сокет (`fetch(url, { unix })` в Bun); образ сессии на базе `ghcr.io/selkies-project/selkies-egl-desktop:26.04` из `spike/`.

**Spec:** `docs/superpowers/specs/2026-10-16-cloud-gaming-mvp-design.md` (§3, §4, §6, §7.3, §7.5, §9, §10, §11 «Настройки»). Выводы спайка — `spike/README.md`, рабочий конфиг — `spike/compose.yaml`, `spike/Dockerfile`.

**Место в MVP.** План 2 из 4. Не входит (план 3): общий gamestore, overlayfs, installer с прогрессом, профили в RustFS. До плана 3 дом Steam пользователя (вход, установленные игры, сохранения) лежит в личном Docker-томе `cg-home-<userId>` на воркере, как в спайке; неустановленную игру Steam предложит установить прямо в стриме. Не входит (план 4): подключение воркеров по токенам из админки, метрики GPU, стоимость игр и упаковка нескольких сессий на GPU, адаптивный битрейт и индикатор сети.

## Global Constraints

- Версии и инструменты — как в MVP-1: точный пиннинг, `bun test` / `bun check` / `bun lint` / `bun fmt`, turbo-задачи `check`, `lint`, `test`, `build`. Новые пакеты — `@cg/orchestrator` (`apps/orchestrator`), `@cg/agent` (`apps/agent`).
- Стиль Effect 4 в репо: сервисы — `Context.Service`, ошибки — `Schema.TaggedError`, конфиг — `Config` с `Redacted` для секретов (см. `apps/api/src/config.ts`).
- Интерфейс на русском. Секреты только в `.env` (gitignored); новые: `AGENT_TOKEN`.
- Состояния сессии (точные строки): `queued`, `starting`, `playing`, `idle_warning`, `disconnected`, `stopping`, `ended`, `failed`.
- Игровое время (`play_segments`, `billable`): учитывается только при живом процессе игры; простой учитывается; минуты отключения учитываются, только если пользователь вернулся; очередь, запуск, синхронизация сохранений — нет (спека §6, анти-цель «платит за ожидание»).
- Настройки по умолчанию: простой до предупреждения N = 15 мин (1–120), ответ на предупреждение M = 2 мин (1–30), ожидание после отключения K = 5 мин (1–60), таймаут запуска 15 мин (5–60). Применяются на лету, в том числе к идущим таймерам.
- Одна активная сессия на пользователя (активная = не `ended`/`failed`).
- Один слот = одна GPU целиком в этом плане. Слот `i` на воркере = UDP-порт `UDP_PORT_BASE + i` (на brofrong `59000`), публичный IP воркера — `WORKER_PUBLIC_IP` (на brofrong `37.153.14.138`).
- Обязательные настройки Selkies в образе сессии (спека §9): `SELKIES_MODE=webrtc`, `SELKIES_WAYLAND=true`, `SELKIES_ENCODER=h264enc`, CBR, старт 10 Мбит/с, 60 fps, `SELKIES_KEYFRAME_INTERVAL=2`, `SELKIES_WEBRTC_UDP_MUX_PORT=<порт слота>`, `SELKIES_WEBRTC_PUBLIC_IP=<IP воркера>`, `SELKIES_WEBRTC_ICE_LITE=true`, HTTPS и basic auth выключены, `SELKIES_UI_SHOW_SIDEBAR=false`.
- Требования к воркеру (спека §9): `nvidia-drm modeset=1`; 32-битные библиотеки NVIDIA версии драйвера хоста в образе (`cg-session:<driver>`); на Debian пробросить `libnvidia-allocator` в `/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1` и `/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so`.
- Сеть: контейнеры сессий в отдельной docker-сети `cg-sessions`; к ней подключён только `cg-api`. Веб-порт Selkies (8080) наружу не публикуется. Наружу публикуется только UDP-порт слота.
- На `brofrong`: не трогать чужие контейнеры, не перезагружать хост, без sudo, без `docker * prune`.

## Review Focus

1. **Вкладку закрыли и вернулись через 3 минуты** — игра на месте, стрим подхватывается, время непрерывно; не вернулись за K — сессия закрыта, минуты отключения не учтены. Тесты: Task 2 `disconnect then return within K bills the gap`, `disconnect without return closes unbilled`; приёмка Task 9.
2. **Первый запуск: окно входа Steam (QR) или игра не установлена** — стрим уже показан, сессия в `starting`, время не идёт; через таймаут запуска сессия закрывается с понятной причиной. Тест: Task 2 `starting never bills and times out`.
3. **Воркер/агент умер посреди игры** — через 90 с без heartbeat сессия `failed`, последний отрезок закрыт на времени последнего heartbeat, пользователь видит «Сервер с игрой перестал отвечать». Тест: Task 4 `lost agent fails session and closes segment at last heartbeat`.
4. **Двойной клик «Играть» / две вкладки** — одна сессия; второй вызов возвращает существующую. Тест: Task 7 `start twice returns same session`.
5. **Чужой sessionId в `/stream/<id>/`** (или без cookie, или чужой Origin на WS) — 403, контейнер чужой сессии недоступен. Тест: Task 7 `stream proxy rejects foreign session`.

---

## Файловая структура

```
packages/db/src/schema/sessions.ts      sessions, play_segments, workers, settings (+ миграция с триггером pg_notify)
packages/rpc/src/settings.ts            SessionSettings (Effect Schema, дефолты, диапазоны)
packages/rpc/src/session.ts             SessionRpcs (браузер ↔ api), SessionView
packages/rpc/src/agent.ts               AgentRpcs (агент ↔ оркестратор), команды и отчёты
packages/rpc/src/admin.ts               + admin.settings.get / admin.settings.update
apps/orchestrator/src/lifecycle.ts      чистый автомат: события → новое состояние + операции с отрезками
apps/orchestrator/src/{main,config,http,AgentHub,Scheduler,SessionRunner,SessionRepo}.ts
apps/agent/src/{main,config,DockerClient,SessionSupervisor,OrchestratorLink}.ts
apps/api/src/session/{SessionRepo,rpc,streamProxy}.ts
apps/web/src/routes/session.$id.tsx, src/components/{Player,IdlePrompt,SessionStatus}.tsx, admin settings form
images/session/{Dockerfile,cg-launch,cg-launch.desktop,README.md}
deploy/compose.yaml (+ cg-orchestrator, cg-agent, сеть cg-sessions), deploy/build-session-image.sh
```

---

### Task 1: Данные сессий и настройки

**Files:**
- Create: `packages/db/src/schema/sessions.ts`, `packages/rpc/src/settings.ts`, миграция `packages/db/migrations/<ts>_sessions/` (generate + ручной SQL триггера)
- Modify: `packages/db/src/schema/index.ts`, `packages/rpc/src/index.ts`
- Test: `packages/db/test/sessions.test.ts`, `packages/rpc/test/settings.test.ts`

**Interfaces:**
- Produces:
  - `sessionStates = ["queued","starting","playing","idle_warning","disconnected","stopping","ended","failed"] as const`, `type SessionState`.
  - `workers`: `id text pk` (имя воркера из конфига агента), `publicIp text`, `slots integer`, `lastSeenAt timestamptz null`, `createdAt`.
  - `sessions`: `id text pk` (uuid), `userId fk user cascade`, `appId integer fk games`, `state text not null default 'queued'`, `workerId text fk workers null`, `slot integer null`, `streamUrl text null` (внутренний адрес Selkies, напр. `http://cg-session-<id>:8080`), `failReason text null`, `clientSeenAt timestamptz null`, `lastInputAt timestamptz null`, `agentSeenAt timestamptz null`, `stopRequestedAt timestamptz null`, `stateSince timestamptz not null default now()`, `createdAt`, `endedAt null`. Частичный уникальный индекс `(userId) where state not in ('ended','failed')`; частичный уникальный индекс `(workerId, slot) where state not in ('ended','failed')`.
  - `playSegments`: `id serial pk`, `sessionId fk sessions cascade`, `userId`, `appId`, `startedAt`, `endedAt` (при открытии = `startedAt`, продлевается heartbeat), `billable boolean not null`, `open boolean not null default true`; не более одного открытого отрезка на сессию (частичный уникальный индекс).
  - `settings`: `key text pk`, `value jsonb not null`, `updatedAt`.
  - Триггер `AFTER INSERT OR UPDATE ON sessions` → `pg_notify('session_changed', NEW.id)`.
  - `@cg/rpc` `SessionSettings = Schema.Struct({ idleWarningMinutes: Int 1..120, idleGraceMinutes: Int 1..30, disconnectGraceMinutes: Int 1..60, startTimeoutMinutes: Int 5..60 })`, `defaultSessionSettings = { idleWarningMinutes: 15, idleGraceMinutes: 2, disconnectGraceMinutes: 5, startTimeoutMinutes: 15 }`, ключ в `settings` — `"session"`.

- [ ] **Step 1: тесты**
  ```ts
  // packages/db/test/sessions.test.ts (DbTest)
  it("second active session for a user violates unique index", ...)   // 2 вставки state 'queued' → вторая падает
  it("ended session does not block a new one", ...)
  it("same worker slot cannot host two active sessions", ...)
  it("update of a session emits pg_notify session_changed", ...)     // PgClient.listen("session_changed") получает id
  // packages/rpc/test/settings.test.ts
  it("decodes defaults", ...); it("rejects idleWarningMinutes 0 and 121", ...)
  ```
- [ ] **Step 2:** `bun run --cwd packages/db test` и `--cwd packages/rpc` — Expected: FAIL.
- [ ] **Step 3:** Схема, `bunx drizzle-kit generate`, затем `drizzle-kit generate --custom --name sessions_notify` с SQL функции и триггера; схема настроек.
- [ ] **Step 4:** Тесты — PASS; `bun run check && bun run lint`.
- [ ] **Step 5:** Commit `feat(db): sessions, play segments, workers, settings`.

---

### Task 2: Автомат жизненного цикла сессии

**Files:**
- Create: `apps/orchestrator/package.json`, `tsconfig.json`, `src/lifecycle.ts`
- Test: `apps/orchestrator/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `SessionState`, `SessionSettings` (Task 1).
- Produces (всё чистое, без Effect-сервисов, время — аргумент):
  ```ts
  type Snapshot = { state: SessionState; stateSince: Date; clientSeenAt: Date | null; lastInputAt: Date | null; agentSeenAt: Date | null; openSegment: { startedAt: Date; billable: boolean } | null }
  type LifecycleEvent =
    | { _tag: "Scheduled" } | { _tag: "StreamReady" } | { _tag: "GameStarted" } | { _tag: "GameExited" }
    | { _tag: "UserStop" } | { _tag: "StopFinished" } | { _tag: "Failed"; reason: string } | { _tag: "Tick" }
  type SegmentOp = { _tag: "Open"; at: Date; billable: boolean } | { _tag: "Close"; at: Date } | { _tag: "MarkOpenBillable" }
  type Decision = { state: SessionState; ops: ReadonlyArray<SegmentOp>; command: "StopContainer" | null; failReason: string | null }
  decide(s: Snapshot, e: LifecycleEvent, now: Date, settings: SessionSettings): Decision
  ```
  Константы: `CLIENT_TIMEOUT_MS = 15_000` (нет heartbeat браузера 15 с → отключён), `AGENT_TIMEOUT_MS = 90_000`.
  Правила (Tick проверяет по порядку): агент молчит > 90 с в любом активном состоянии кроме `queued` → `failed`, «Сервер с игрой перестал отвечать», `Close at agentSeenAt`; `starting` дольше `startTimeoutMinutes` → `stopping`, «Игра не запустилась за отведённое время», `StopContainer`; `playing`/`idle_warning` и клиент молчит > 15 с → `disconnected`, `Close at clientSeenAt` + `Open at clientSeenAt billable=false`; `disconnected` и клиент снова виден → `playing`, `MarkOpenBillable` + `Close at now` + `Open at now billable=true`; `disconnected` дольше K (от `stateSince`) → `stopping`, `Close at stateSince`, `StopContainer`; `playing` и `now - lastInputAt > N` → `idle_warning`; `idle_warning` и свежий ввод → `playing`; `idle_warning` дольше M → `stopping`, `Close at now`, `StopContainer`. `GameStarted` из `starting` → `playing` + `Open billable=true`. `GameExited`/`UserStop` → `stopping` + `Close at now` (+ `StopContainer` для UserStop). `StopFinished` → `ended`. Клиент молчит дольше K (от `clientSeenAt ?? stateSince`): в `starting` → `stopping` «Игрок отключился» + `StopContainer`, без отрезков; в `queued` → `ended` без команды (контейнера ещё нет). «Клиент виден» = `now - clientSeenAt ≤ 15 с`.

- [ ] **Step 1: тесты** (табличные, `now` и `settings` задаются явно):
  ```ts
  it("game start opens billable segment", ...)
  it("idle counts: playing → idle_warning after N, segment stays open billable", ...)
  it("idle_warning answered returns to playing", ...)
  it("idle_warning unanswered for M stops and closes segment", ...)
  it("disconnect then return within K bills the gap", ...)      // ops: Close(clientSeenAt), Open(clientSeenAt,false) … затем MarkOpenBillable, Close(now), Open(now,true)
  it("disconnect without return closes unbilled", ...)          // после K: stopping, Close(stateSince), открытый отрезок остаётся billable=false
  it("starting never bills and times out", ...)                 // нет Open в starting; Tick после 15 мин → stopping + failReason
  it("lost agent fails from any active state", ...)
  it("settings change applies to running timers", ...)          // тот же snapshot, N=15 → playing, N=1 → idle_warning
  it("user stop and game exit close the segment", ...)
  it("queued session of a vanished client ends after K", ...)
  ```
- [ ] **Step 2:** `bun run --cwd apps/orchestrator test` — FAIL.
- [ ] **Step 3:** Реализовать `decide`.
- [ ] **Step 4:** PASS; check/lint.
- [ ] **Step 5:** Commit `feat(orchestrator): session lifecycle state machine`.

---

### Task 3: Протокол агента и сервер оркестратора

**Files:**
- Create: `packages/rpc/src/agent.ts`, `apps/orchestrator/src/{config,http,main,AgentHub}.ts`
- Modify: `packages/rpc/src/index.ts` (экспорт, НЕ в `AppRpcs`)
- Test: `apps/orchestrator/test/agentHub.test.ts`

**Interfaces:**
- Produces:
  - `AgentRpcs` (отдельная группа, не обслуживается api):
    - `agent.connect({ workerId, publicIp, slots, udpPortBase, running: Array<{ sessionId, slot, streamUrl, gameRunning: boolean }> })` → **stream** `AgentCommand`;
    - `agent.report(AgentReport)` → `void`.
  - `AgentCommand = { _tag: "StartSession"; sessionId; userId; appId; slot; udpPort } | { _tag: "StopSession"; sessionId }`.
  - `AgentReport = { _tag: "StreamReady"; sessionId; streamUrl } | { _tag: "GameState"; sessionId; running: boolean } | { _tag: "Heartbeat"; sessionIds: string[] } | { _tag: "Stopped"; sessionId; cloudSynced: boolean } | { _tag: "Failed"; sessionId; reason: string }`.
  - Аутентификация: заголовок `Authorization: Bearer <AGENT_TOKEN>` на HTTP-апгрейде `GET /agent` (не Origin — клиент не браузер); неверный/нет → 401 до апгрейда. Сравнение токена за постоянное время.
  - `OrchestratorConfig`: `port` (default 3001), `databaseUrl: Redacted`, `agentToken: Redacted`.
  - `AgentHub` (сервис): `send(workerId, AgentCommand): Effect<boolean>` (false — агент не подключён); `connected(): ReadonlySet<string>`; при `agent.connect` upsert `workers` (`lastSeenAt=now`), публикация `AgentHubEvent` (`Connected` с `running`, `Report`, `Disconnected`) в `PubSub`, который читает Task 4.
  - `GET /healthz` → `ok`.

- [ ] **Step 1: тесты** (RpcTest/реальный BunHttpServer как в `apps/api/test/auth.test.ts`):
  ```ts
  it("agent without token gets 401 before upgrade", ...)
  it("connect upserts worker and send delivers command to its stream", ...)
  it("send to unknown worker returns false", ...)
  it("reports are published as hub events", ...)
  it("disconnect publishes Disconnected", ...)
  ```
- [ ] **Step 2–4:** FAIL → реализация → PASS, check/lint.
- [ ] **Step 5:** Commit `feat(orchestrator): agent protocol and hub`.

---

### Task 4: Планировщик и ведение сессий

**Files:**
- Create: `apps/orchestrator/src/{SessionRepo,Scheduler,SessionRunner}.ts`; Modify: `apps/orchestrator/src/main.ts`
- Test: `apps/orchestrator/test/runner.test.ts`

**Interfaces:**
- Consumes: `decide`, `AgentHub`, таблицы Task 1, `SessionSettings`.
- Produces:
  - `SessionRepo.loadSettings(): Effect<SessionSettings>` — из `settings["session"]`, при отсутствии/битом значении — `defaultSessionSettings` (с логом).
  - `SessionRepo.apply(sessionId, decision, now)` — в одной транзакции: обновить `state`/`stateSince` (если состояние сменилось)/`failReason`/`endedAt` (для `ended`/`failed`), выполнить `SegmentOp` над единственным открытым отрезком сессии.
  - `Scheduler.tick` (раз в 2 с): `queued` сессии по `createdAt` с `FOR UPDATE SKIP LOCKED`; слот = наименьший свободный `0..slots-1` у подключённого воркера (первый по `id`); `StartSession` с `udpPort = UDP_PORT_BASE + slot` (`udpPortBase` из `agent.connect`); если `send` вернул false — сессия остаётся `queued`. Записать `workerId`, `slot`, `state='starting'`, `agentSeenAt=now`.
  - `SessionRunner`: на события хаба — `StreamReady` → `streamUrl`; `GameState running` → событие `GameStarted`/`GameExited` (по смене); `Heartbeat` → `agentSeenAt=now` для перечисленных сессий и продление `endedAt` открытого отрезка до now; `Stopped` → `StopFinished`; `Failed` → `Failed`; `Connected` с `running` — сверка: сессии, о которых агент не знает, но они активны на этом воркере → `failed` «Сессия потеряна при перезапуске сервера»; раз в 5 с — по всем активным сессиям: если `stopRequestedAt` задан — событие `UserStop`, иначе `Tick`; `command: StopContainer` → `AgentHub.send(StopSession)`.

- [ ] **Step 1: тесты** (DbTest + фейковый AgentHub, время — TestClock или явный `now`):
  ```ts
  it("queued session gets lowest free slot and StartSession with udpPort 59000+slot", ...)
  it("no connected worker keeps session queued", ...)
  it("full worker keeps session queued until a slot frees", ...)
  it("GameState running opens billable segment, heartbeat extends it", ...)
  it("lost agent fails session and closes segment at last heartbeat", ...)
  it("tick applies settings changed in db", ...)
  it("agent reconnect without a known session fails it", ...)
  ```
- [ ] **Step 2–4:** FAIL → реализация → PASS, check/lint.
- [ ] **Step 5:** Commit `feat(orchestrator): scheduler and session runner`.

---

### Task 5: Образ сессии

**Files:**
- Create: `images/session/Dockerfile`, `images/session/cg-launch`, `images/session/cg-launch.desktop`, `images/session/README.md`, `deploy/build-session-image.sh`

**Interfaces:**
- Produces: образ `cg-session:<NV_VER>` (на brofrong `cg-session:550.163.01`). Контракт окружения контейнера (задаёт агент): `CG_APP_ID` (appid игры), `SELKIES_WEBRTC_UDP_MUX_PORT`, `SELKIES_WEBRTC_PUBLIC_IP` + постоянные настройки Selkies из Global Constraints (зашиты в Dockerfile как `ENV`, кроме двух переменных слота). Метка контейнера `cg.session=<sessionId>`. Дом пользователя — том на `/home/ubuntu`.
  - `cg-launch` — запускается автостартом KDE (`/etc/xdg/autostart/cg-launch.desktop`), т.е. в окружении графической сессии с `LD_PRELOAD` интерпозера ввода (спека §7.3); выполняет `steam -silent -applaunch "$CG_APP_ID"`; если `CG_APP_ID` пуст — ничего.
  - `deploy/build-session-image.sh`: rsync `images/session` на воркер, скачивание `NVIDIA-Linux-x86_64-<ver>.run` (версия = `nvidia-smi --query-gpu=driver_version`), `--extract-only`, `docker build --build-arg NV_VER=<ver> -t cg-session:<ver>`.

- [ ] **Step 1:** Dockerfile = `spike/Dockerfile` + `ENV` Selkies из Global Constraints + `COPY cg-launch /usr/local/bin/`, `COPY cg-launch.desktop /etc/xdg/autostart/`.
- [ ] **Step 2:** Сборка на brofrong: `./deploy/build-session-image.sh` — Expected: `cg-session:550.163.01` в `docker images`.
- [ ] **Step 3: ручная проверка (риск №3 спеки)** — запустить вручную в bridge-сети `cg-sessions` (`docker network create cg-sessions`, если нет), с томом `cg-spike-home` (там вход Steam владельца и Vampire Survivors) скопированным в новый том `cg-home-manualtest` (`docker run --rm -v cg-spike-home:/a -v cg-home-manualtest:/b busybox cp -a /a/. /b/`), `-p 59001:59001/udp`, `SELKIES_WEBRTC_UDP_MUX_PORT=59001`, `CG_APP_ID=1794680`, библиотеки GBM как в `spike/compose.yaml`, `--gpus all --runtime nvidia --shm-size 2g`, метка `cg.session=manual`. Проверить: в логе `Wayland capture`, через ~40 с процесс `VampireSurvivors.exe`; `docker exec … pgrep -f "AppId=1794680"` находит процесс; через временный `ssh -L` на веб-порт контейнера — картинка идёт, в Stats `host udp` и `Wayland · zero-copy`. Спайк `cg-spike` на время проверки остановить (одна GPU) и потом запустить обратно; том `cg-spike-home` не изменять.
- [ ] **Step 4:** Удалить контейнер и том `cg-home-manualtest`. Записать результаты (время до игры, Stats) в `images/session/README.md`.
- [ ] **Step 5:** Commit `feat(images): session image with game autolaunch`.

---

### Task 6: Агент воркера

**Files:**
- Create: `apps/agent/package.json`, `tsconfig.json`, `src/{config,DockerClient,SessionSupervisor,OrchestratorLink,main}.ts`
- Test: `apps/agent/test/supervisor.test.ts`, `apps/agent/test/dockerClient.test.ts`

**Interfaces:**
- Consumes: `AgentRpcs`, `AgentCommand`, `AgentReport` (Task 3); контракт образа (Task 5).
- Produces:
  - `AgentConfig`: `workerId`, `orchestratorUrl` (`ws://…/agent`), `agentToken: Redacted`, `publicIp`, `slots` (default 1), `udpPortBase` (default 59000), `sessionImage`, `sessionNetwork` (default `cg-sessions`), `gbmAllocatorPath` (optional; на Debian — `/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.<ver>`), `dockerSocket` (default `/var/run/docker.sock`).
  - `DockerClient` (сервис над Docker Engine API v1.47 через `fetch(url, { unix })`): `createAndStart(spec: ContainerSpec): Effect<string, DockerError>`, `stop(name, timeoutSec)`, `remove(name)`, `exec(name, cmd: string[]): Effect<{ exitCode: number; stdout: string }, DockerError>`, `listByLabel(label): Effect<Array<{ name; labels }>>`.
  - Контейнер сессии: имя `cg-session-<sessionId>`, образ `sessionImage`, метки `cg.session=<id>`, `cg.slot=<slot>`, `cg.app=<appId>`, env (Task 5 контракт), том `cg-home-<userId>:/home/ubuntu`, bind GBM-библиотек, `Runtime: nvidia`, `DeviceRequests` GPU all, `ShmSize` 2 ГиБ, сеть `sessionNetwork`, `PortBindings` `<udpPort>/udp → <udpPort>`, `RestartPolicy: no`. `streamUrl = http://cg-session-<id>:8080`.
  - `SessionSupervisor`: `StartSession` → создать контейнер, ждать готовности Selkies (`GET streamUrl/api/status` 200, до 120 с) → `StreamReady`; затем каждые 5 с `exec pgrep -f "AppId=<appId>"` → `GameState` при смене; `StopSession` или игра завершилась → ждать маркер облака (`grep -c "Upload complete, result OK"` в `/home/ubuntu/.local/share/Steam/logs/cloud_log.txt` вырос относительно значения на старте, до 60 с) → `stop(15)` + `remove` → `Stopped{cloudSynced}`; ошибка Docker → `Failed{reason}`. Heartbeat каждые 30 с со всеми живыми sessionId. На старте агента — `listByLabel("cg.session")` и передача их в `agent.connect.running`.
  - `OrchestratorLink`: подключение с `Authorization: Bearer`, переподключение с backoff 1→30 с; команды из стрима → `SessionSupervisor`.

- [ ] **Step 1: тесты** (фейковый `DockerClient`, TestClock):
  ```ts
  it("start creates container with slot port, labels, volume and env", ...)  // проверить ContainerSpec: имя, cg.session, 59000+slot/udp, cg-home-<userId>, CG_APP_ID
  it("reports StreamReady when selkies answers", ...)
  it("reports GameState on pgrep changes only", ...)
  it("game exit waits for cloud marker then removes container", ...)
  it("cloud marker timeout still stops with cloudSynced false", ...)
  it("docker failure reports Failed", ...)
  it("adopts labelled containers on startup", ...)
  // dockerClient.test.ts — Bun.serve на unix-сокете во временной папке как фейковый dockerd
  it("createAndStart posts create then start", ...)
  it("exec returns exit code and stdout", ...)
  ```
- [ ] **Step 2–4:** FAIL → реализация → PASS, check/lint.
- [ ] **Step 5:** Commit `feat(agent): docker-based session supervisor`.

---

### Task 7: API — RPC сессий, прокси стрима, настройки

**Files:**
- Create: `packages/rpc/src/session.ts`, `apps/api/src/session/{SessionRepo,rpc,streamProxy}.ts`, `apps/api/src/admin/settings.ts`
- Modify: `packages/rpc/src/index.ts` (`AppRpcs` += `SessionRpcs`), `packages/rpc/src/admin.ts`, `apps/api/src/http.ts`, `apps/api/src/admin/rpc.ts`
- Test: `apps/api/test/session.test.ts`, `apps/api/test/streamProxy.test.ts`, `apps/api/test/settings.test.ts`

**Interfaces:**
- Consumes: таблицы Task 1, `SessionSettings`, `CurrentUser`, `AuthMiddleware`, `AdminMiddleware`, `rpcAllowedOrigins` (MVP-1).
- Produces:
  - `SessionView = { id; appId; gameName; state: SessionState; streamReady: boolean; failReason: string | null; idleDeadline: string | null; playedSeconds: number; createdAt: string }` — `streamReady = streamUrl !== null`; `idleDeadline` — ISO времени автозакрытия в `idle_warning`; `playedSeconds` — сумма billable-отрезков (открытый — до now).
  - `SessionRpcs` (с `AuthMiddleware`): `session.start({ appId })` → `SessionView` (если есть активная — её; игра должна быть в библиотеке пользователя, иначе `GameNotOwned`); `session.active()` → `SessionView | null`; `session.watch({ sessionId })` → **stream** `SessionView` (сразу текущее, далее на каждый `session_changed` по этому id; чужая/нет → `SessionNotFound`); `session.heartbeat({ sessionId, lastInputAt })` → `void` (пишет `clientSeenAt=now`, `lastInputAt=min(lastInputAt, now)`); `session.stop({ sessionId })` → `void` (пишет `stopRequestedAt=now`; дальше оркестратор, Task 4).
  - `admin.settings.get()` → `SessionSettings`; `admin.settings.update(SessionSettings)` → `SessionSettings` (валидация схемой; вне диапазона — ошибка схемы).
  - `streamProxy`: `ANY /stream/:sessionId/*` → прокси HTTP и WebSocket на `streamUrl` сессии; доступ только владельцу (cookie Better Auth), только для активной сессии со `streamReady`; WS-апгрейд — с той же проверкой Origin, что `/rpc`; иначе 403 (не 404 — не раскрывать существование). Путь пересобирается без префикса `/stream/<id>` (клиент Selkies строит URL относительно своего пути — проверено в его бандле: `he()` от `location.pathname`). `Host` апстрима — хост `streamUrl`.
  - Сеть: `cg-api` подключается к сети `cg-sessions` (Task 9).

- [ ] **Step 1: тесты** (DbTest, фейковый апстрим — `Bun.serve` с HTTP и WS эхо):
  ```ts
  it("start twice returns same session", ...)
  it("start for a game not in library fails GameNotOwned", ...)
  it("watch emits current view then each change", ...)          // UPDATE sessions → новое значение в стриме
  it("watch of someone else's session fails SessionNotFound", ...)
  it("heartbeat updates clientSeenAt and clamps future lastInputAt", ...)
  it("playedSeconds sums only billable segments", ...)
  it("stream proxy forwards http and websocket for owner", ...)
  it("stream proxy rejects foreign session", ...)               // чужой пользователь, без cookie, ended-сессия, чужой Origin на WS → 403
  it("admin.settings.update validates ranges and persists", ...)
  it("player cannot call admin.settings.update", ...)
  ```
- [ ] **Step 2–4:** FAIL → реализация → PASS, check/lint.
- [ ] **Step 5:** Commit `feat(api): session rpc, stream proxy, settings`.

---

### Task 8: Плеер и настройки в админке

**Files:**
- Create: `apps/web/src/routes/session.$id.tsx`, `apps/web/src/components/{Player,SessionStatus,IdlePrompt}.tsx`, `apps/web/src/components/admin/SessionSettingsForm.tsx`
- Modify: `apps/web/src/components/GameCard.tsx` (кнопка «Играть» активна), `apps/web/src/routes/library.tsx`, `apps/web/src/routes/admin.tsx`, `apps/web/src/rpc.ts`
- Test: `apps/web/test/session.test.tsx`, `apps/web/test/settingsForm.test.tsx`

**Interfaces:**
- Consumes: `session.*`, `admin.settings.*`, `SessionView` (Task 7).
- Produces: маршрут `/session/$id`; тексты (точные):
  - `queued` — «Ждём свободный сервер…»; `starting` без стрима — «Запускаем игру…»; `starting` со стримом — стрим + плашка «Если появилось окно входа Steam — отсканируйте QR-код в мобильном приложении Steam».
  - `playing`/`disconnected` — полноэкранный `<iframe src="/stream/<id>/">` (allow `autoplay; fullscreen; gamepad; clipboard-read; clipboard-write`) и кнопка «Выйти из игры» (с подтверждением «Закончить игру? Прогресс сохранится.»).
  - `idle_warning` — поверх стрима «Вы ещё здесь?», кнопка «Я здесь», «Сессия закроется через m:ss» (от `idleDeadline`).
  - `stopping` — «Сохраняем прогресс…»; `ended` — «Сессия завершена. Вы играли {Ч} ч {ММ} мин» (меньше часа — «{М} мин»), кнопка «В библиотеку»; `failed` — «Не удалось запустить игру» + `failReason` + «В библиотеку».
  - Карточка игры: «Играть» → `session.start` → переход на `/session/$id`; если есть активная сессия другой игры — кнопка «Вернуться в игру» в шапке библиотеки, а «Играть» на других карточках неактивна с подсказкой «Сначала завершите текущую игру».
  - Heartbeat каждые 5 с, пока открыта страница сессии: `lastInputAt` — время последнего `keydown`/`pointermove`/`pointerdown`/`wheel` в документе iframe (тот же origin) или в родителе, либо изменения состояния `navigator.getGamepads()` (опрос раз в 250 мс). «Я здесь» отправляет heartbeat с `lastInputAt = now` сразу.
  - Админка: форма «Настройки сессий» — четыре числовых поля с подписями «Простой до предупреждения, мин», «Время на ответ, мин», «Ожидание после отключения, мин», «Таймаут запуска, мин», кнопка «Сохранить», ошибка диапазона показывается у поля.

- [ ] **Step 1: тесты** (чистые компоненты, без сокета):
  ```tsx
  it("renders status text for each state", ...)       // все 8 состояний, точные строки
  it("ended shows played time in hours and minutes", ...) // 4320 c → «1 ч 12 мин»; 600 c → «10 мин»
  it("idle prompt counts down to idleDeadline and calls onHere", ...)
  it("play disabled on other games while a session is active", ...)
  it("settings form shows range error and submits valid values", ...)
  ```
- [ ] **Step 2–4:** FAIL → реализация → PASS; `bun run check && bun run lint && bun run build`.
- [ ] **Step 5:** Commit `feat(web): player, session flow, session settings`.

---

### Task 9: Деплой и приёмка

**Files:**
- Modify: `deploy/compose.yaml`, `deploy/Dockerfile` (сборка двух доп. сервисов или общий образ с разными командами), `deploy/deploy.sh`, `deploy/README.md`, `.env.example`

**Interfaces:**
- Consumes: всё выше.
- Produces на brofrong (compose-проект `cloud-gaming`): `cg-orchestrator` (сеть `cg`, без публикации портов, `mem_limit` 256m, healthcheck `/healthz`, логи с ротацией); `cg-agent` (сеть `cg`, `/var/run/docker.sock` смонтирован, env `WORKER_ID=brofrong`, `ORCHESTRATOR_URL=ws://cg-orchestrator:3001/agent`, `WORKER_PUBLIC_IP=37.153.14.138`, `SLOTS=1`, `UDP_PORT_BASE=59000`, `SESSION_IMAGE=cg-session:550.163.01`, `GBM_ALLOCATOR_PATH=/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01`, `mem_limit` 256m); внешняя сеть `cg-sessions` (создаётся `deploy.sh`, если нет), к ней подключён `cg-api`; `AGENT_TOKEN` (новый случайный) — в серверный `.env` дописывается одной строкой, если его нет, без чтения остальных значений.

- [ ] **Step 1:** Compose, deploy.sh, README (как пересобрать образ сессии при обновлении драйвера; как посмотреть сессии: `docker ps --filter label=cg.session`).
- [ ] **Step 2:** `./deploy/deploy.sh`; проверка: `cg-api`, `cg-postgres`, `cg-orchestrator`, `cg-agent` healthy/running; в логе оркестратора `agent brofrong connected`; `healthz` ok; список прочих контейнеров не изменился.
- [ ] **Step 3: приёмка с владельцем** (контейнер `cg-spike` остановить на время приёмки, после — запустить обратно; это одна GPU):
  1. «Играть» на Vampire Survivors → статусы → вход Steam по QR (первый раз, новый том) → игра; геймпад работает.
  2. В админке поставить простой N = 1 мин → через минуту без ввода «Вы ещё здесь?» → «Я здесь» возвращает игру; вернуть N = 15.
  3. Закрыть вкладку на ~1 мин, открыть `/session/<id>` → игра продолжается.
  4. «Выйти из игры» → «Сохраняем прогресс…» → «Вы играли …»; в БД `play_segments` сходятся с фактическим временем ±1 мин; контейнер `cg-session-*` удалён.
- [ ] **Step 4:** Commit `feat(deploy): orchestrator, agent, session network`.
