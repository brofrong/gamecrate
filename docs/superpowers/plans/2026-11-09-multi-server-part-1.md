# Несколько серверов, часть 1: главный и игровые серверы, релизы из GitLab — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сервис разворачивается как один главный сервер (сайт, api, оркестратор, Postgres,
RustFS) и любое число игровых серверов (только `cg-agent`). Игровой сервер добавляется из админки
одной командой, стрим идёт через главный по тоннелю агента, у каждого сервера своя библиотека игр,
а образы собирает GitLab CI по тегу `vX.Y.Z`.

**Architecture:**
- Агент авторизуется собственным токеном сервера (`worker_credentials`, в БД хэш), а секреты
  хранилища профилей получает от оркестратора (`GET /agent/config`).
- Оркестратор открывает наружу только `/agent*`: RPC, канал тоннеля, установку и обмен кода.
  На внутреннем порту `RELAY_PORT` он выглядит для api как Selkies сессии: `/relay/<sessionId>/…`.
  Каждое соединение api (HTTP-запрос или WebSocket) превращается в команду `OpenTunnel` агенту.
  Агент открывает канал `wss://…/agent/tunnel/<id>` и сам ходит в `cg-session-<id>:8080`.
- `gamestore_apps` и активные `install_jobs` получают сервер. Планировщик ставит игру на
  конкретный подходящий сервер и размещает сессию только там, где игра стоит.
- Регионы появляются в БД и админке. Выбор по пингу — часть 2.

**Tech Stack:** Bun 1.4, Effect 4 (HttpRouter, RpcServer/RpcClient, Socket), drizzle-orm 1.0 rc и
Postgres 18, React 19 и shadcn/ui, bash, Docker Compose, GitLab CI, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-09-multi-server-deploy-design.md` (часть 1 из «Порядка
работ»).

## Global Constraints

- Код, комментарии, тексты интерфейса и сообщения скриптов на русском, как в репозитории. Логи
  (`Effect.log*`) на английском, как сейчас.
- Видео, звук и ввод идут напрямую по UDP. Проверено 2026-11-09 по `selkies-core.js` в
  `cg-session:550.163.01`: ввод уходит через `sendDataChannelMessage` → `_send_channel` (канал
  данных WebRTC), движение мыши через `_motion_channel`. Через тоннель идут только страница плеера
  и WebSocket сигналинга.
- Общий `AGENT_TOKEN` удаляется отовсюду: конфиг оркестратора и агента, compose, `deploy.sh`,
  README, `.env.example`.
- Токен сервера: `cgw_` + 43 символа base64url (32 случайных байта). Код подключения: 24 символа
  из алфавита `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Оба хранятся в БД только как SHA-256 hex.
  Код одноразовый и живёт `ENROLL_CODE_TTL_MS = 24 * 60 * 60 * 1000`.
- Id сервера (`workers.id`, `WORKER_ID`): `^[a-z0-9][a-z0-9-]{1,31}$`. Код региона:
  `^[a-z][a-z0-9-]{1,15}$`.
- Публичные маршруты главного: сайт `https://<домен>` → `cg-api:3000`, агенты `https://<домен>/agent*`
  → `cg-orchestrator:3001`, S3 `https://<хост S3>` → `cg-rustfs:9000`. `RELAY_PORT` (3002) наружу
  не публикуется.
- Пути на игровом сервере: `/opt/cloud-gaming/` (`.env` с правами 600, `compose.yaml`), данные
  по умолчанию в `/srv/cloud-gaming/{library,install-scratch,games}`, scratch сессий
  `/srv/cloud-gaming-scratch`, клиент Steam `/srv/cloud-gaming-steam/client`. Всё принадлежит
  uid 1000.
- Образы: `registry.imtechnologies.ru/gamecrate/imt-cloud-gaming/cg-app:<тег>` и
  `…/cg-session:<версия драйвера>-<тег>`. Драйверы перечислены в `images/session/drivers.txt`,
  одна версия на строку, сначала только `550.163.01`.
- Миграции генерируются `bunx drizzle-kit generate` (из `packages/db`). Перенос данных и замена PK
  пишутся вручную в той же миграции. Миграция должна проходить на базе brofrong-стенда, где один
  воркер `brofrong` с ролями `worker,gamestore`.
- Без согласия владельца не пушить в `origin`, не создавать теги и не деплоить. Задачи 10 и 11
  кончаются локальной проверкой. Пробный пайплайн и раскатка на brofrong — задача 12, с владельцем.
- Каждая задача заканчивается зелёными `bun run check`, `bun run lint` и тестами затронутых пакетов.

## Review Focus

1. **Отозванный сервер переподключается.** После «Отозвать доступ» живое соединение закрывается
   за ≤ 15 с, а повторное подключение получает 401. Тест в задаче 3 (`revoked worker is kicked
   and refused`).
2. **Чужой `workerId` с валидным токеном.** Агент с токеном `spb-1` шлёт `workerId: "msk-1"` — отказ
   `AgentUnauthorized`, строка `msk-1` не меняется. Тест в задаче 3.
3. **Тоннель к чужой или мёртвой сессии.** Relay для сессии, которая не активна или стоит на другом
   сервере, отвечает 502 без команды агенту. Агент отказывает `OpenTunnel`, если сессии у него нет.
   Тесты в задачах 5 и 6.
4. **Игра стоит на занятом сервере.** Игра стоит на `w1`, все слоты `w1` заняты, `w2` свободен:
   сессия ждёт в очереди, вторая копия на `w2` не ставится. Тест в задаче 8.
5. **Повторный обмен кода.** Второй `POST /agent/enroll` с тем же кодом и просроченный код получают
   403, токен не выдаётся. Тест в задаче 3.

---

### Task 1: Схема: регионы, учётные данные серверов, библиотека по серверам

**Files:**
- Modify: `packages/db/src/schema/sessions.ts` (таблицы `regions`, `workerCredentials`, колонка `workers.regionId`)
- Modify: `packages/db/src/schema/gamestore.ts` (`gamestoreApps.workerId`, PK; индекс `install_jobs`)
- Create: `packages/db/migrations/<ts>_multi_server/migration.sql` (сгенерировать и дописать вручную)
- Test: `packages/db/test/multiServerMigration.test.ts`

**Interfaces:**
- Produces:
  - `regions`: `id uuid pk default gen_random_uuid()`, `code text not null unique`,
    `name text not null`, `position integer not null default 0`,
    `createdAt timestamptz not null default now()`.
  - `workers.regionId uuid null references regions(id) on delete restrict`.
  - `workerCredentials`: `workerId text pk references workers(id) on delete cascade`,
    `tokenHash text unique null`, `enrollCodeHash text unique null`,
    `enrollExpiresAt timestamptz null`, `tokenIssuedAt timestamptz null`,
    `revokedAt timestamptz null`.
  - `gamestoreApps.workerId text not null references workers(id)`, PK `(worker_id, app_id)`,
    имя PK `gamestore_apps_pkey`.
  - `install_jobs`: индекс `install_jobs_active_app_idx` удалён, вместо него
    `install_jobs_active_worker_app_idx` unique `(worker_id, app_id) where state in ('queued','running')`.

- [ ] **Step 1: Write the failing test** `multiServerMigration.test.ts`. Тест создаёт временную БД
  (`testDb.ts`), прогоняет миграции до предыдущей (`20261105090640_play_segments_user_idx`),
  вставляет воркер `brofrong` (`roles = {worker,gamestore}`), игру и строку `gamestore_apps(app_id=10)`,
  затем прогоняет остальные миграции.
  - `backfills gamestore_apps.worker_id with the gamestore worker`: у строки `app_id=10` теперь
    `worker_id = 'brofrong'`.
  - `allows the same app on two workers`: вставка `(w2, 10)` проходит, повторная `(brofrong, 10)`
    падает на PK.
  - `allows one active install job per worker and app`: две `queued` задачи `(brofrong, 10)` —
    вторая падает; `queued` на `(w2, 10)` проходит.
  - `drops orphan gamestore rows when no gamestore worker exists`: в отдельной БД без воркеров
    строка `gamestore_apps` после миграции удалена.

  Если `testDb.ts` не умеет останавливаться на конкретной миграции, добавь туда
  `migrateUpTo(name)`: она копирует каталоги миграций до `name` включительно во временный каталог
  и прогоняет только их.
- [ ] **Step 2: Run to verify it fails.** `cd packages/db && bun test --env-file=../../.env test/multiServerMigration.test.ts`
  Ожидается FAIL: колонки `worker_id` нет.
- [ ] **Step 3: Change the schema and generate the migration.** Обнови схему и запусти
  `bunx drizzle-kit generate --name multi_server`. В сгенерированный SQL добавь вручную, по порядку:
  колонку `worker_id` сначала nullable; заполнение
  `update gamestore_apps set worker_id = (select id from workers where 'gamestore' = any(roles) order by id limit 1)`;
  `delete from gamestore_apps where worker_id is null`; `set not null`; удаление старого PK и
  `add constraint gamestore_apps_pkey primary key (worker_id, app_id)`; задачам `install_jobs`
  в состоянии `queued` и `worker_id is null` проставь того же воркера, затем замени индекс. Комментарий
  у таблицы `gamestoreApps` перепиши: «библиотека сервера», а не «общая библиотека».
- [ ] **Step 4: Run to verify it passes.** Та же команда, PASS. Затем `bun run check` из корня. Он
  покажет все места, где код читал `gamestoreApps` по одному `appId`. Временно поправь их
  минимально, чтобы компилировалось (`workerId` в `insert`). Настоящая логика будет в задаче 8.
  Тесты оркестратора и api, сломанные этим, отметь в коммите как известные, задача 8 их чинит.
- [ ] **Step 5: Commit** `feat(db): регионы, учётные данные серверов, библиотека игр по серверам`.

### Task 2: Admin RPC: регионы и серверы (api)

**Files:**
- Modify: `packages/rpc/src/admin.ts`
- Create: `apps/api/src/admin/regions.ts`, `apps/api/src/admin/workerEnroll.ts`
- Modify: `apps/api/src/admin/workers.ts`, `apps/api/src/admin/rpc.ts`
- Create: `packages/db/src/workerTokens.ts` (общие для api и оркестратора), экспорт из `packages/db/src/index.ts`
- Test: `apps/api/test/adminRegions.test.ts`, `apps/api/test/adminWorkerEnroll.test.ts`, дополнить `apps/api/test/adminWorkers.test.ts`

**Interfaces:**
- Produces (`packages/db/src/workerTokens.ts`):
  - `sha256Hex(value: string): string`
  - `newWorkerToken(): string` (`cgw_` + base64url(32 байта))
  - `newEnrollCode(): string` (24 символа алфавита из Global Constraints)
  - `ENROLL_CODE_TTL_MS = 86_400_000`
  - `WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/`, `REGION_CODE_PATTERN = /^[a-z][a-z0-9-]{1,15}$/`
- Produces (`packages/rpc/src/admin.ts`):
  - `AdminRegion = { id: string, code: string, name: string, position: Int, workers: Int }`
  - `AdminWorker` получает поля `regionId: NullOr(String)`, `enrolled: Boolean` (есть `tokenHash`
    и нет `revokedAt`), `pendingCode: NullOr({ expiresAt: String })` (код выдан и не истёк)
  - RPC:
    - `admin.regions.list` → `Array(AdminRegion)`, порядок `position asc, name asc`
    - `admin.regions.create { code, name }` → `AdminRegion | "codeTaken" | "invalid"`
    - `admin.regions.update { id, name, position }` → `"ok" | "notFound"`
    - `admin.regions.delete { id }` → `"ok" | "notEmpty" | "notFound"`
    - `admin.workers.create { id, regionId }` → `{ code: String, expiresAt: String } | "idTaken" | "invalid"`.
      Создаёт `workers(id, publicIp: "", slots: 0, regionId)` и `workerCredentials` с кодом.
    - `admin.workers.issueCode { workerId }` → `{ code, expiresAt } | "notFound"`. Новый код для
      существующего сервера; текущий токен действует, пока код не обменяют.
    - `admin.workers.revoke { workerId }` → `Boolean`. Ставит `tokenHash = null`,
      `enrollCodeHash = null`, `revokedAt = now`.
    - `admin.workers.setRegion { workerId, regionId: NullOr(String) }` → `Boolean`

- [ ] **Step 1: Write failing tests.**
  - `adminRegions.test.ts`:
    - `creates, lists in position order, renames`;
    - `rejects duplicate code` → `"codeTaken"`;
    - `rejects bad code "Spb"` → `"invalid"`;
    - `refuses to delete a region with workers` → `"notEmpty"`.
  - `adminWorkerEnroll.test.ts`:
    - `create returns a 24-char code valid for 24h and stores only its hash`: в
      `worker_credentials` лежит `sha256Hex(code)`, а не сам код; `expiresAt` = now + 24 ч ± 1 с;
    - `create rejects existing id` → `"idTaken"`;
    - `create rejects "Spb_1"` → `"invalid"`;
    - `issueCode keeps the current token until exchange`: `tokenHash` не изменился;
    - `revoke clears token and code`.
  - `adminWorkers.test.ts`: `list shows regionId, enrolled and pendingCode`.
  - Все RPC требуют роль admin; тест `non-admin gets AccessDenied` для `admin.workers.create`
    по образцу существующих.
- [ ] **Step 2: Run to verify they fail.** `cd apps/api && bun test --env-file=../../.env test/adminRegions.test.ts test/adminWorkerEnroll.test.ts test/adminWorkers.test.ts`
- [ ] **Step 3: Implement** `workerTokens.ts`, схемы RPC и обработчики, по образцу `classes.ts`
  (CRUD) и `workers.ts` (список). `create` и `issueCode` в одной транзакции.
- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit** `feat(api): регионы и выдача кодов подключения серверов в админке`.

### Task 3: Оркестратор: токены серверов, обмен кода, `/agent/config`, отзыв

**Files:**
- Modify: `apps/orchestrator/src/config.ts`, `apps/orchestrator/src/http.ts`, `apps/orchestrator/src/AgentHub.ts`
- Create: `apps/orchestrator/src/WorkerAuth.ts`
- Modify: `packages/rpc/src/agent.ts` (`AgentConnect.token`, ошибка `AgentUnauthorized`)
- Test: `apps/orchestrator/test/workerAuth.test.ts`, дополнить `apps/orchestrator/test/agentHub.test.ts`

**Interfaces:**
- Consumes: `sha256Hex`, `newWorkerToken`, `workerCredentials` (задачи 1–2).
- Produces:
  - Конфиг оркестратора: убрать `agentToken`; добавить `publicUrl` (`ORCHESTRATOR_PUBLIC_URL`,
    напр. `https://game.example.ru`), `relayPort` (`RELAY_PORT`, по умолчанию 3002),
    `s3PublicEndpoint` (`S3_PUBLIC_ENDPOINT`), `s3Bucket` (`S3_BUCKET`, по умолчанию `cg-profiles`),
    `s3AccessKey`/`s3SecretKey` (`S3_ACCESS_KEY`/`S3_SECRET_KEY`, Redacted), `profileKey`
    (`PROFILE_KEY`, Redacted, тот же формат base64 32 байт, что `SEED_KEY`), `cgVersion`
    (`CG_VERSION`, по умолчанию `dev`), `registry` (`REGISTRY_SERVER`, `REGISTRY_USERNAME`,
    `REGISTRY_PASSWORD`: все три или ничего, по образцу `pairOrNone` в api).
  - `WorkerAuth` (Context.Service):
    - `workerOfToken(token: string): Effect<Option<string>>` — сервер по действующему токену
      (`tokenHash` совпал, `revokedAt is null`)
    - `enroll(code: string, now: Date): Effect<Option<{ workerId: string, token: string, regionCode: string | null }>>` —
      атомарно проверяет `enrollCodeHash` и `enrollExpiresAt > now`, пишет новый `tokenHash`,
      `tokenIssuedAt = now`, `revokedAt = null`, обнуляет код
  - HTTP (порт `ORCHESTRATOR_PORT`):
    - `GET /agent`: `Authorization: Bearer <token>` проверяется через `workerOfToken`, неверный → 401
    - `POST /agent/enroll` с телом `{ "code": "…" }` → 200
      `{ workerId, token, regionCode, orchestratorUrl, version, registry: { server, username, password } | null }`,
      иначе 403 `{ "error": "Код недействителен или истёк" }`
    - `GET /agent/config` с Bearer → 200
      `{ s3: { endpoint, bucket, accessKey, secretKey }, profileKey }`, иначе 401
    - `GET /agent/install.sh` и `GET /agent/build-steam-client.sh` — отдаются в задаче 11
  - `AgentConnect.token: Schema.Redacted(Schema.String)`. `hub.connect` сверяет
    `workerOfToken(token) === payload.workerId`, иначе поток падает с `AgentUnauthorized`.
  - `AgentHubShape.disconnect(workerId: string): Effect<void>` — закрывает текущее соединение
    (как при вытеснении).
  - Фоновая проверка в `WorkerAuth.layer`: каждые `REVOKE_CHECK_MS = 10_000` для каждого
    `hub.connected()` смотрит, действует ли токен, с которым он подключился (хаб хранит
    `tokenHash` в `Connection`). Если нет — `hub.disconnect`.

- [ ] **Step 1: Write failing tests** (`workerAuth.test.ts`, HTTP через `HttpRouter.toWebHandler`
  по образцу существующих тестов api):
  - `enroll exchanges a valid code once`: первый POST → 200 и токен начинается с `cgw_`,
    второй → 403;
  - `enroll refuses an expired code` → 403;
  - `config requires a worker token`: без заголовка → 401, с токеном → 200 и `s3.endpoint` =
    `S3_PUBLIC_ENDPOINT`;
  - `GET /agent with unknown token is 401`;
  - `connect with another worker's id fails with AgentUnauthorized` (Review Focus 2): строка
    `workers` для чужого id не изменилась;
  - `revoked worker is kicked and refused` (Review Focus 1): подключённый `spb-1`, `revoke`
    в БД, `TestClock.adjust("10 seconds")` → хаб публикует `Disconnected`, новый upgrade → 401.
- [ ] **Step 2: Run to verify they fail.** `cd apps/orchestrator && bun test --env-file=../../.env test/workerAuth.test.ts test/agentHub.test.ts`
- [ ] **Step 3: Implement.** Убери `isAgentAuthorized`. Сделай `upsertWorker` обновлением
  существующей строки: строку создаёт админка, а у неизвестного `workerId` токена нет. Тесты хаба,
  которые полагались на создание строки при connect, переведи на заранее созданную строку и
  учётные данные (хелпер в `test/support.ts`: `seedWorker(id, { regionId?, token })`).
- [ ] **Step 4: Run tests → PASS**, плюс весь `bun test` оркестратора (кроме тестов,
  отмеченных в задаче 1).
- [ ] **Step 5: Commit** `feat(orchestrator): свой токен у каждого сервера, обмен кода, конфиг агенту`.

### Task 4: Агент: токен сервера, конфиг с главного, сеть сессий

**Files:**
- Modify: `apps/agent/src/config.ts`, `apps/agent/src/OrchestratorLink.ts`, `apps/agent/src/main.ts`
- Create: `apps/agent/src/RemoteConfig.ts`
- Modify: `apps/agent/src/WorkerMonitor.ts` / `hostProbe.ts` (версия `CG_VERSION` в `WorkerVersions`)
- Modify: `packages/rpc/src/agent.ts` (`WorkerVersions.agentVersion: optional(String)`)
- Test: `apps/agent/test/remoteConfig.test.ts`, дополнить `apps/agent/test/config.test.ts`, `apps/agent/test/link.test.ts`

**Interfaces:**
- Consumes: `GET /agent/config`, `AgentConnect.token` (задача 3).
- Produces:
  - Переменные агента: убрать `AGENT_TOKEN`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`,
    `S3_SECRET_KEY`, `PROFILE_KEY`; добавить `WORKER_TOKEN` (Redacted, `^cgw_[A-Za-z0-9_-]{43}$`),
    `CG_VERSION` (по умолчанию `dev`).
  - `orchestratorHttpBase(orchestratorUrl: string): string` — `wss://h/agent` → `https://h`,
    `ws://h:3001/agent` → `http://h:3001`.
  - `fetchRemoteConfig(url: string, token: Redacted<string>): Effect<RemoteConfigValues, RemoteConfigError>`;
    `RemoteConfigValues = { s3Endpoint, s3Bucket, s3AccessKey: Redacted, s3SecretKey: Redacted, profileKey: Redacted }`.
  - `AgentConfig.layer` читает env, затем `fetchRemoteConfig` с повтором (экспоненциально
    от 1 с до 30 с, без предела). Тип `AgentConfigValues` сохраняет поля `s3Endpoint`, `s3Bucket`,
    `s3AccessKey`, `s3SecretKey`, `profileKey`, поэтому остальной код агента не меняется. Пока
    конфиг не получен, лог раз в попытку: `Waiting for orchestrator config`. Секреты в лог
    не попадают.
  - `OrchestratorLink`: Bearer = `WORKER_TOKEN`, `AgentConnect.token` = он же. При
    `AgentUnauthorized` — `Effect.logError("Worker token rejected by orchestrator")` и обычный
    повтор с паузой `RECONNECT_MAX`.

- [ ] **Step 1: Write failing tests.**
  - `remoteConfig.test.ts` (фейковый `Bun.serve`):
    - `fetches config with bearer token`: сервер видит `authorization: Bearer cgw_…`, агент
      получает `s3Endpoint`;
    - `retries until the orchestrator answers`: первые два ответа 503, третий 200;
    - `does not log secrets`: перехваченный лог не содержит `secretKey` и `profileKey`.
  - `config.test.ts`:
    - `orchestratorHttpBase maps wss and ws`;
    - `rejects WORKER_TOKEN without cgw_ prefix`.
  - `link.test.ts`: `sends token in AgentConnect`.
- [ ] **Step 2: Run to verify they fail.** `cd apps/agent && bun test test/remoteConfig.test.ts test/config.test.ts test/link.test.ts`
- [ ] **Step 3: Implement.** `SessionSupervisor` и тесты, где сейчас стоит `AGENT_TOKEN`, переведи
  на новый конфиг.
- [ ] **Step 4: Run** весь `bun test` агента → PASS.
- [ ] **Step 5: Commit** `feat(agent): токен сервера и конфиг хранилища с главного`.

### Task 5: Оркестратор: канал тоннеля и relay для api

**Files:**
- Modify: `packages/rpc/src/agent.ts` (команда `OpenTunnel`)
- Create: `packages/rpc/src/tunnel.ts` (сообщения канала, общие для оркестратора и агента)
- Create: `apps/orchestrator/src/Tunnels.ts` (ожидающие каналы, `/agent/tunnel/:id`)
- Create: `apps/orchestrator/src/relay.ts` (сервер на `RELAY_PORT`)
- Modify: `apps/orchestrator/src/http.ts`, `apps/orchestrator/src/main.ts`
- Test: `apps/orchestrator/test/tunnel.test.ts`

**Interfaces:**
- Produces:
  - `AgentCommand` + `Schema.TaggedStruct("OpenTunnel", { tunnelId: Schema.String, sessionId: Schema.String })`.
  - Протокол канала (`packages/rpc/src/tunnel.ts`). Первое сообщение после открытия — текстовый
    JSON от оркестратора:
    - `TunnelOpenHttp = { kind: "http", method, path, headers: Array<[string,string]>, hasBody: boolean }`.
      Если `hasBody`, следом одно бинарное сообщение с телом. Агент отвечает текстом
      `TunnelHttpResponse = { kind: "response", status, headers }`, затем бинарными кусками тела,
      затем закрывает канал кодом 1000. Сбой — `{ kind: "error", message }` и 1011.
    - `TunnelOpenWs = { kind: "ws", path, headers, protocols: string[] }`. Агент отвечает
      `{ kind: "open", protocol: string }` или `{ kind: "error", message }`. После `open` каждое
      сообщение канала — кадр Selkies 1:1 (текст остаётся текстом, бинарное — бинарным), а
      закрытие канала повторяет код и причину закрытия Selkies (и наоборот).
    - `encodeTunnelControl(msg)` и `decodeTunnelControl(text): Option<TunnelControl>`.
  - `Tunnels` (Context.Service):
    - `open(workerId: string, sessionId: string): Effect<Socket.Socket, TunnelError, Scope>` —
      создаёт `tunnelId` (uuid), шлёт `OpenTunnel` через `hub.send`, ждёт канал агента
      `TUNNEL_OPEN_TIMEOUT = "10 seconds"`.
    - Маршрут `GET /agent/tunnel/:tunnelId`. Bearer проверяется через `workerOfToken`, сервер
      токена должен совпасть с `workerId` ожидающего канала, иначе 401 или 404. Неизвестный или
      просроченный `tunnelId` → 404.
  - Relay (`RELAY_PORT`, отдельный `BunHttpServer`): `ANY /relay/:sessionId/*`.
    - Сессия должна быть активной (тот же предикат `isActive`, что у `streamUrlOf` в api; если он
      объявлен в api, вынеси его в `@cg/db`), с `stream_url is not null`, а её `worker_id` —
      подключён. Иначе 502 без команды агенту.
    - HTTP: `Tunnels.open`, `TunnelOpenHttp` с путём без префикса `/relay/<id>`, ответ
      пробрасывается потоком.
    - WebSocket: `Tunnels.open`, `TunnelOpenWs`, после `open` апгрейд и перекачка кадров.
      Возьми `pipeFrames`/`closeFor` из `apps/api/src/session/streamProxy.ts` и вынеси их
      в `packages/rpc/src/wsBridge.ts`, чтобы не копировать.
  - Лимит: не больше `MAX_TUNNELS_PER_WORKER = 64` открытых каналов на сервер, сверх — 503.

- [ ] **Step 1: Write failing tests** `tunnel.test.ts`. Фейковый агент: подключённый к хабу
  клиент, который на `OpenTunnel` открывает `/agent/tunnel/<id>` и отвечает как Selkies.
  - `relays an HTTP GET through the agent`: `GET /relay/<id>/index.html` → 200, тело и
    `content-type` от фейка, путь у фейка `/index.html`;
  - `relays a WebSocket with text and binary frames and close code`: эхо, код закрытия 4001
    доходит до клиента relay;
  - `refuses a session on another worker or not active` (Review Focus 3): 502, фейк не получил
    `OpenTunnel`;
  - `tunnel from another worker's token is refused`: канал открыт токеном `w2` для ожидания `w1`
    → 401, relay отвечает 502 по тайм-ауту;
  - `times out when the agent never dials`: 502 через 10 с (`TestClock`).
- [ ] **Step 2: Run to verify they fail.** `cd apps/orchestrator && bun test --env-file=../../.env test/tunnel.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit** `feat(orchestrator): тоннель стрима через агента и relay для api`.

### Task 6: Агент: открытие тоннеля к Selkies

**Files:**
- Create: `apps/agent/src/TunnelClient.ts`
- Modify: `apps/agent/src/OrchestratorLink.ts` (обработка `OpenTunnel`), `apps/agent/src/main.ts`
- Test: `apps/agent/test/tunnelClient.test.ts`

**Interfaces:**
- Consumes: `OpenTunnel`, протокол `packages/rpc/src/tunnel.ts`, `orchestratorHttpBase` (задачи 4–5),
  `sessionStreamUrl(sessionId)`.
- Produces:
  - `TunnelClient` (Context.Service): `open(command: { tunnelId, sessionId }): Effect<void>`.
    Запускается в фоне, не блокирует поток команд.
    - Сессию должен знать `SessionSupervisor` (живая, есть `streamUrl`), иначе канал не
      открывается, а в лог пишется предупреждение.
    - Агент открывает `ws(s)://<база>/agent/tunnel/<tunnelId>` с Bearer `WORKER_TOKEN` и читает
      первое управляющее сообщение.
    - Для `http` делает `fetch(sessionStreamUrl(id) + path)` (тайм-аут 10 с, `redirect: "manual"`)
      и стримит ответ. Для `ws` открывает WebSocket к Selkies с `protocols` и гонит кадры через
      `wsBridge`.
  - `SessionSupervisor` получает метод `hasStream(sessionId): boolean`, если похожего ещё нет.
  - Предел одновременных каналов агента `MAX_TUNNELS = 64`, сверх — отказ с предупреждением.
  - Upstream в тестах подменяется через `Context.Reference` `TunnelUpstream`
    (`(sessionId) => string`, по умолчанию `sessionStreamUrl`), как `StreamUpstream` в api.

- [ ] **Step 1: Write failing tests** `tunnelClient.test.ts`. Фейковый оркестратор (Bun.serve
  с маршрутом канала) и фейковый Selkies.
  - `serves an HTTP request from Selkies`;
  - `bridges a WebSocket and mirrors close codes`;
  - `refuses a session it does not run` (Review Focus 3): канал не открыт, к фейку не было запроса;
  - `sends the worker token when dialing`.
- [ ] **Step 2: Run to verify they fail.** `cd apps/agent && bun test test/tunnelClient.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** весь `bun test` агента → PASS.
- [ ] **Step 5: Commit** `feat(agent): канал тоннеля к Selkies сессии`.

### Task 7: api: прокси стрима через relay оркестратора

**Files:**
- Modify: `apps/api/src/session/streamProxy.ts`, `apps/api/src/config.ts`
- Test: `apps/api/test/streamProxy.test.ts`

**Interfaces:**
- Consumes: relay `/relay/<sessionId>/…` (задача 5), `wsBridge` (вынесен в задаче 5).
- Produces:
  - Конфиг api `orchestratorRelayUrl` (`ORCHESTRATOR_RELAY_URL`, по умолчанию `http://cg-orchestrator:3002`).
  - Значение `StreamUpstream` по умолчанию: `(id) => \`${orchestratorRelayUrl}/relay/${id}\``.
    Проверки владельца, Origin и `isSessionStreamUrl` остаются как есть. Переписывание
    `Location` понимает оба origin: relay и `streamUrl`.
  - Шапку файла переписать: api ходит в relay оркестратора, а не в сеть `cg-sessions`.

- [ ] **Step 1: Write failing test** `upstream defaults to the orchestrator relay`: со слоем
  конфига `ORCHESTRATOR_RELAY_URL=http://relay.test:3002` и без подмены `StreamUpstream` запрос
  уходит на `http://relay.test:3002/relay/<id>/` (перехват `fetch`). Существующие тесты с подменой
  `StreamUpstream` должны остаться зелёными.
- [ ] **Step 2: Run to verify it fails.** `cd apps/api && bun test --env-file=../../.env test/streamProxy.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit** `feat(api): стрим через relay оркестратора`.

### Task 8: Планировщик, установки и удаление игр по серверам

**Files:**
- Modify: `apps/orchestrator/src/InstallRepo.ts`, `apps/orchestrator/src/Scheduler.ts`, `apps/orchestrator/src/InstallDispatcher.ts`, `apps/orchestrator/src/GameDeleter.ts`, `apps/orchestrator/src/GameRepo.ts`
- Modify: `packages/db/src/placement.ts` (`eligibleWorkers` исключает серверы без клиента Steam)
- Modify: `apps/api/src/admin/games.ts`, `apps/api/src/library/CloudRepo.ts`, `packages/rpc/src/admin.ts` (`AdminGames`, `admin.games.delete`)
- Modify: `apps/web/src/components/admin/*` (вкладка «Игры»: колонка «Сервер», удаление с сервера)
- Test: `apps/orchestrator/test/scheduler.test.ts`, `apps/orchestrator/test/install.test.ts`, `apps/orchestrator/test/gameDeleter.test.ts`, `apps/api/test/adminGames.test.ts`, `packages/db/test/placement.test.ts` (или где сейчас тесты `eligibleWorkers`)

**Interfaces:**
- Consumes: `gamestoreApps(workerId, appId)`, индекс задач (задача 1).
- Produces:
  - `InstallRepo`:
    - `installedOn(appId: number): Effect<ReadonlyArray<string>>` — серверы, где игра стоит и
      не удаляется
    - `lockActiveJob(appId: number, workerIds: ReadonlyArray<string>)` — активная задача игры
      на одном из этих серверов
    - `createJob(workerId: string, appId: number, userId: string): Effect<string>`
    - `claimNext(candidates, now)` выдаёт только задачи, у которых `worker_id ∈ candidates` и на
      этом сервере нет `running`
    - `finish` пишет `gamestore_apps` с `worker_id` задачи
  - `Scheduler.placeOne`, новый порядок для каждой из `PLACE_SCAN` старейших `queued` сессий:
    1. `eligible = eligibleWorkers(userId, appId, { workerIds: candidates })`, где `candidates`
       — подключённые серверы с ролью `worker`. Пусто → следующая сессия.
    2. Своя игра — как сейчас.
    3. Steam-игра: `installed = installedOn(appId) ∩ eligible`. Не пусто → первый из `installed`
       со свободным слотом, иначе сессия ждёт (Review Focus 4).
    4. Пусто → если у игры отменяется задача (`appInstallCancelling`) — ждать. Иначе
       присоединиться к активной задаче на любом из `eligible` (`lockActiveJob`) или создать
       задачу на цели: первый из `eligible` с ролью `gamestore` и свободным слотом, иначе первый
       из `eligible` с ролью `gamestore`. Нет такого → ждать. Сессия переходит в `installing`,
       как сейчас.
  - `eligibleWorkers` дополнительно отбрасывает серверы с `versions.steamClientBuiltAt == null`
    (только для Steam-игр).
  - Удаление: `admin.games.delete { workerId, appId }` → `"started" | "inUse" | "notFound"`.
    `inUse`, если на этом сервере есть активная сессия этой игры или удерживается её слот.
    `GameDeleter` шлёт `DeleteGame` нужному серверу, `GameDeleted`/`GameDeleteFailed`
    применяются к строке `(workerId, appId)`.
  - `AdminGames.games[]` получает `workerId`. Строка таблицы — пара (сервер, игра).
  - `CloudRepo`: «игра в облаке» = есть строка хотя бы на одном сервере.

- [ ] **Step 1: Write failing tests.**
  - `scheduler.test.ts`:
    - `installs on a worker with a free slot`: два сервера, у `w1` занят единственный слот →
      задача на `w2`;
    - `waits when the game is installed only on a busy worker` (Review Focus 4): игра на `w1`,
      `w1` занят, `w2` свободен → сессия остаётся `queued`, новых `install_jobs` нет;
    - `places on the worker that has the game`: игра на `w2` → `workerId = w2`;
    - `joins the active install on another eligible worker`;
    - `skips workers without a Steam client template`.
  - `install.test.ts`:
    - `claimNext only gives a job to its own worker`;
    - `finish records the game for the job's worker`.
  - `gameDeleter.test.ts`: `deletes only on the requested worker` — строка `(w2, app)`
    остаётся.
  - `adminGames.test.ts`: `delete is refused while the game runs on that worker` → `"inUse"`;
    тот же запрос для другого сервера → `"started"`.
  - Тесты, отмеченные сломанными в задаче 1, переписать на серверную библиотеку.
- [ ] **Step 2: Run to verify they fail.** `cd apps/orchestrator && bun test --env-file=../../.env` и `cd apps/api && bun test --env-file=../../.env test/adminGames.test.ts`
- [ ] **Step 3: Implement.** Обнови комментарии к `placeOne`/`startInstall`: «библиотека сервера».
- [ ] **Step 4: Run** все тесты оркестратора, api, db и web → PASS; `bun run check`.
- [ ] **Step 5: Commit** `feat: библиотека игр у каждого сервера — установка, размещение, удаление`.

### Task 9: Админка: «Серверы», добавление сервера, регионы

**Files:**
- Modify: `apps/web/src/routes/admin.tsx` (вкладка `["workers","Серверы"]`, группировка по регионам)
- Create: `apps/web/src/components/admin/AddWorkerDialog.tsx`, `apps/web/src/components/admin/RegionsCard.tsx`
- Modify: `apps/web/src/components/admin/WorkerCard.tsx`, `apps/web/src/rpc.ts`
- Test: `apps/web/test/addWorkerDialog.test.tsx`, `apps/web/test/regionsCard.test.tsx`, дополнить тест `WorkerCard`, если он есть

**Interfaces:**
- Consumes: RPC задачи 2.
- Produces (UI, тексты как есть):
  - Кнопка «Добавить сервер» над списком. Диалог: поле «Имя сервера» (подсказка
    «латиница, цифры и дефис, напр. spb-1»), выбор «Регион», кнопка «Получить команду».
    Затем показывается команда
    `curl -fsSL ${window.location.origin}/agent/install.sh | sudo bash -s -- <код>`, кнопка
    «Скопировать» и «Код действует до <дата время>». `idTaken` → «Сервер с таким именем уже есть».
  - Список серверов сгруппирован по регионам в порядке `position`, внизу группа «Без региона».
  - Карточка сервера:
    - выбор региона;
    - бейдж «Ждёт подключения», если `lastSeenAt === null`;
    - предупреждение «Клиент Steam не собран», если `versions?.steamClientBuiltAt` пуст;
    - строка «Версия» = `versions.agentVersion`;
    - кнопки «Новый код подключения» (тот же показ команды) и «Отозвать доступ» с подтверждением
      «Сервер отключится и не сможет подключиться, пока не получит новый код».
  - `RegionsCard`: список (имя, код, серверов), «Добавить регион» (имя и код), переименование,
    стрелки порядка, «Удалить» (недоступно, если есть серверы; при `notEmpty` — «В регионе есть
    серверы»).

- [ ] **Step 1: Write failing tests** (по образцу существующих тестов админки в `apps/web/test`):
  - `addWorkerDialog.test.tsx`:
    - `shows the install command with the code`: команда содержит `/agent/install.sh` и код
      из ответа;
    - `shows idTaken message`.
  - `regionsCard.test.tsx`: `delete is disabled for a region with workers`.
  - Тест группировки: `groups workers by region in position order with "Без региона" last`.
- [ ] **Step 2: Run to verify they fail.** `cd apps/web && bun test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests → PASS**, `bun run check`, `bun run lint`.
- [ ] **Step 5: Commit** `feat(web): серверы по регионам, добавление сервера командой, регионы`.

### Task 10: GitLab CI: проверки и образы по тегу

**Files:**
- Create: `.gitlab-ci.yml`
- Create: `images/session/drivers.txt` (одна строка `550.163.01`)
- Create: `deploy/ci/build-session-images.sh`
- Modify: `deploy/Dockerfile` (`ARG CG_COMMIT`, `ARG CG_VERSION` → `ENV`)
- Modify: `deploy/build-session-image.sh` (берёт драйвер из того же места распаковки, что и CI; поведение для brofrong не меняется)

**Interfaces:**
- Produces:
  - Джоба `check` (стадия `check`; MR, `main`, теги): образ `oven/bun:1.4`, сервис `postgres:18`
    (`POSTGRES_USER=cg`, `POSTGRES_PASSWORD=cg`, `POSTGRES_DB=cloud_gaming`),
    `DATABASE_URL`/`TEST_DATABASE_URL=postgres://cg:cg@postgres:5432/cloud_gaming`,
    `bun install --frozen-lockfile`, `bun run check`, `bun run lint`, `bun run test`,
    `bun test deploy/test`. Тесты api, оркестратора и db читают `--env-file=../../.env`, поэтому
    джоба пишет `.env` с этими двумя переменными.
  - Джоба `build-app` (стадия `build`; только теги `/^v\d+\.\d+\.\d+$/`): `docker:27` +
    `docker:27-dind`, логин `$CI_REGISTRY_USER`/`$CI_REGISTRY_PASSWORD`,
    `docker build -f deploy/Dockerfile --build-arg CG_COMMIT=$CI_COMMIT_SHORT_SHA --build-arg CG_VERSION=$CI_COMMIT_TAG`,
    пуш `$CI_REGISTRY_IMAGE/cg-app:$CI_COMMIT_TAG` и `:latest`.
  - Джоба `build-session` (те же теги): `deploy/ci/build-session-images.sh <tag>` — для каждой
    версии из `drivers.txt` скачивает `.run` (кэш CI `nv/`), распаковывает `--extract-only`,
    собирает `images/session` с `--build-arg NV_VER` и пушит
    `$CI_REGISTRY_IMAGE/cg-session:<версия>-<tag>`.
  - Комментарий в начале `.gitlab-ci.yml`: если раннер не даёт privileged для dind, джобы сборки
    переводятся на `buildah` (`quay.io/buildah/stable`, `--storage-driver vfs`). Что подошло,
    решает пробный пайплайн в задаче 12.

- [ ] **Step 1: Validate locally.** Все `bun run check/lint/test` зелёные. Затем сборка образа
  приложения: `docker build -f deploy/Dockerfile --build-arg CG_VERSION=v0.0.0-local -t cg-app:local .`
  и `docker run --rm cg-app:local printenv CG_VERSION` → `v0.0.0-local`. Если на Mac нет docker,
  эту часть пропусти и запиши в отчёт.
- [ ] **Step 2: Lint CI.** API GitLab `POST /projects/351/ci/lint` с содержимым файла (токен
  из Keychain `devops.gitlab-imt.token`, в вывод не печатать) → `"valid": true`.
- [ ] **Step 3: shellcheck** `deploy/ci/build-session-images.sh` (если установлен) → без ошибок.
- [ ] **Step 4: Commit** `ci: проверки на MR и main, образы cg-app и cg-session по тегу`.

### Task 11: Развёртывание: compose главного и игрового, установка сервера, brofrong

**Files:**
- Create: `deploy/compose.main.yaml`, `deploy/compose.worker.yaml`, `deploy/compose.stand.yaml`
- Create: `deploy/worker/install.sh`, `deploy/worker/build-steam-client.sh`
- Modify: `deploy/build-steam-client.sh` (обёртка: `ssh host bash -s < deploy/worker/build-steam-client.sh`)
- Modify: `deploy/session-isolation.sh` (к `:8080` пускать IP `cg-agent`, а не `cg-api`; режим `apply-local`)
- Create: `deploy/deploy-stand.sh` (деплой brofrong по тегу, заменяет `deploy/deploy.sh`)
- Delete: `deploy/deploy.sh`, `deploy/compose.yaml`
- Modify: `apps/orchestrator/src/http.ts` (отдать `install.sh`/`build-steam-client.sh`)
- Modify: `deploy/README.md`, `.env.example`
- Test: `deploy/test/installScript.test.ts`, дополнить `deploy/test/sessionIsolation.test.ts`; `apps/orchestrator/test/workerAuth.test.ts` (отдача скрипта)

**Interfaces:**
- Consumes: `/agent/enroll` (задача 3), образы (задача 10).
- Produces:
  - `compose.main.yaml`: `cg-api`, `cg-orchestrator` (порты 3001 и 3002 только в сети `cg`),
    `cg-postgres`, `cg-rustfs`, `cg-rustfs-bucket` (профиль `tools`). Образ
    `${CG_REGISTRY:-registry.imtechnologies.ru/gamecrate/imt-cloud-gaming}/cg-app:${CG_VERSION:?}`,
    без `build`. `cg-api` в сетях `cg` и `proxy`, сети `cg-sessions` нет. Секреты оркестратора —
    из задачи 3.
  - `compose.worker.yaml`: только `cg-agent` (тот же образ, `command` агента), сети `cg-sessions`
    (external) и своя default. Переменные: `ORCHESTRATOR_URL`, `WORKER_ID`, `WORKER_TOKEN`,
    `WORKER_PUBLIC_IP`, `SLOTS`, `UDP_PORT_BASE`, `SESSION_IMAGE`, `GBM_ALLOCATOR_PATH`, `ROLES`
    (`worker,gamestore`), `CG_DATA_DIR`, `SCRATCH_DIR`, `STEAM_CLIENT_DIR`, `STEAM_CLIENT_PARENT`,
    `MIN_FREE_GB`, `DOCKER_GID`, `CG_VERSION`. Биндинги и GPU `utility` — как в нынешнем compose.
  - `compose.stand.yaml`: оверлей для brofrong. Подключает `cg-agent` к внешней сети `cg`, чтобы
    `ORCHESTRATOR_URL=ws://cg-orchestrator:3001/agent`, и задаёт пути brofrong
    (`/raid/cloud-gaming` и т.д.).
  - `deploy/worker/install.sh <код>` (запуск от root). Оркестратор отдаёт его, подставляя
    `__ORCHESTRATOR_PUBLIC_URL__` и `__CG_VERSION__`. Шаги, при любой ошибке выход с понятным
    русским сообщением:
    1. проверки: `docker`, `docker compose`, `nvidia-smi`, NVIDIA runtime в `docker info`,
       `/sys/module/nvidia_drm/parameters/modeset` = `Y`; версия драйвера есть в образах релиза
       (`docker manifest inspect …/cg-session:<драйвер>-<версия>` после логина);
    2. `POST /agent/enroll` → `.env` в `/opt/cloud-gaming/.env` (права 600, владелец root),
       `docker login` реестра с выданными учётными данными (`--password-stdin`);
    3. каталоги из Global Constraints (владелец 1000), сеть `cg-sessions`, `DOCKER_GID`, путь
       `libnvidia-allocator.so.<драйвер>` (Debian `…/nvidia/current/`, Ubuntu
       `/usr/lib/x86_64-linux-gnu/`), публичный IP (`curl -fsS https://api.ipify.org`,
       переопределяется флагом `--public-ip`), `SLOTS` = число GPU, `UDP_PORT_BASE=59000`;
    4. `docker compose pull && up -d` агента, затем `session-isolation.sh apply-local`;
    5. `build-steam-client.sh` локально, если клиента ещё нет;
    6. итог: «Сервер <id> подключён. Откройте UDP <порты> в файрволе провайдера».
    Флаг `--dry-run` печатает план и ничего не меняет (для теста).
  - `deploy-stand.sh <тег>`: проверка, что на brofrong нет живых `cg.session`/`cg.install`/`cg.template`
    (как в старом `deploy.sh`); запись `CG_VERSION` в `~/cloud-gaming/.env`; копирование трёх
    compose-файлов; `pull` и `up -d` (main + worker + stand).

- [ ] **Step 1: Write failing tests.**
  - `installScript.test.ts`:
    - `refuses without modeset`: запуск с фейковыми `PATH`-заглушками и `--dry-run`, modeset `N`
      → код выхода 1 и сообщение про `nvidia-drm modeset=1`;
    - `dry run prints the plan with the worker id from enroll`: фейковый enroll на `Bun.serve`.
  - `sessionIsolation.test.ts`: `allows the agent container to reach 8080`.
  - `workerAuth.test.ts`: `install.sh is served with the public URL and version substituted`.
- [ ] **Step 2: Run to verify they fail.** `bun test deploy/test` и тест оркестратора.
- [ ] **Step 3: Implement.** README переписать: разделы «Главный сервер», «Игровой сервер»
  (добавление из админки), «Стенд brofrong», «Релиз» (тег → CI → `deploy-stand.sh`). Старые
  разделы про `deploy.sh` удалить.
- [ ] **Step 4: Run** тесты → PASS; `docker compose -f deploy/compose.main.yaml config -q` и то же
  для worker и stand (с примером `.env`) → без ошибок; `shellcheck` скриптов.
- [ ] **Step 5: Commit** `feat(deploy): главный и игровой серверы, установка сервера командой, стенд brofrong`.

### Task 12: Раскатка с владельцем (не автоматическая)

Каждый пункт выполняется только после явного «да» владельца.

- [ ] **Step 1: Секреты.** В GitLab создать deploy token проекта `read_registry` для серверов.
  Сохранить его в Bitwarden, папка `AI agents`, запись `gitrepo.imtechnologies.ru (registry read, cloud-gaming)`.
- [ ] **Step 2: Пробный пайплайн.** Запушить ветку `feat/multi-server` и тег `v0.1.0-rc.1`
  (для пробы шаблон тега расширить до `-rc.N`). Если dind не разрешён, перевести сборку на buildah
  и повторить. Итог: образы в реестре.
- [ ] **Step 3: brofrong.** В админке стенда выдать код существующему серверу `brofrong`
  («Новый код подключения»), прописать в `.env` новые переменные (`WORKER_TOKEN` из обмена,
  `S3_PUBLIC_ENDPOINT=http://cg-rustfs:9000`, `ORCHESTRATOR_PUBLIC_URL`, `PROFILE_KEY`
  переезжает к оркестратору), выполнить `deploy-stand.sh v0.1.0-rc.1`. Проверить сессию в
  браузере (стрим через relay), установку новой игры и сохранение профиля. Заодно проверить,
  что происходит с идущим стримом, если перезапустить `cg-orchestrator` (живёт ли видео без
  управляющего WebSocket), и записать результат в `deploy/README.md` (спека, пункт 4).
- [ ] **Step 4: Новый прод** — когда будут серверы: compose главного (Arcane подхватит позже),
  маршруты прокси, затем «Добавить сервер» для каждого игрового сервера. Версию драйвера нового
  сервера добавить в `images/session/drivers.txt` и выпустить тег.

## Итог исполнения (2026-11-09)

Задачи 1–11 сделаны и прошли ревью (по задачам и всей ветки), задача 12 ждёт владельца.
Отложенные мелочи, которые ревью не сочло блокирующими:

- Перед открытием прода чужим игрокам: сессии, ждущие установки, стоят за окном `PLACE_SCAN`
  (50); задача установки, привязанная к упавшему серверу, держит сессии игрока до
  `installTimeoutMinutes`; `admin.workers.setClass` падает дефектом на неизвестном id.
- Тоннель: отказ после `open` уходит кадром `{kind:"error"}` в поток вместо закрытия 1011;
  непроверенные пути relay (тайм-аут ответа, обрыв тела, `Disconnected`); `MAX_TUNNELS` без теста;
  `channelMessages` продублирован в агенте и relay.
- Конфиги: `ORCHESTRATOR_PUBLIC_URL` пропускает `https://:3001`; 404/400 от `/agent/config`
  повторяются бесконечно; разбор `ORCHESTRATOR_RELAY_URL` не покрыт тестом.
- Оркестратор: после отзыва сервер не закрывает WebSocket сам; схема `Bearer` чувствительна
  к регистру; нет теста на «более старое подключение проигрывает».
- Проверить в задаче 12: маршрут по умолчанию у `cg-agent` на игровом сервере (не через
  `cg-sessions`?), поведение стрима при перезапуске главного.
- Старый падающий тест web `SteamQrLogin > shows QR and statuses` (падает и на main).
