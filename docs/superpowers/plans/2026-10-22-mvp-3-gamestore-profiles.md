# MVP-3: общая библиотека игр, установка и профили в RustFS — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Игра, которой нет на сервере, ставится автоматически с процентами на сайте; все сессии играют из одной общей библиотеки и никогда в неё не пишут; дом Steam пользователя собирается на каждую сессию заново из общего клиента Steam и зашифрованного профиля в RustFS и выгружается обратно при выходе — сохранения не теряются, профиль не привязан к машине.

**Architecture:** Агент получает с хоста три каталога из конфига: библиотека (`steamapps`), чистый клиент Steam и scratch для личных слоёв. Контейнер сессии больше не монтирует том дома: `~/.local/share/Steam` — overlay (lower = клиент Steam), `~/.local/share/Steam/steamapps` — overlay (lower = библиотека), остальной дом — слой контейнера; профиль (whitelist путей, ~7 МБ) кладётся в созданный контейнер через Docker archive API до старта и снимается скриптом в образе при остановке. Overlay собирает сам Docker (`local`-том `type=overlay`), sudo не нужен. Установка — отдельный контейнер того же образа на gamestore-агенте: заготовка `appmanifest_<appid>.acf` → Steam качает сам → новые приложения переносятся из личного слоя в библиотеку `rename`. Сессия ждёт установку в состоянии `installing`; одна установка на appid.

**Tech Stack:** как в MVP-2 (Bun 1.4.4, effect 4.0.5, Drizzle 1.0.0-rc.4 с патчем, React 19.3); S3 — `Bun.S3Client` (без новых зависимостей); шифрование — WebCrypto AES-256-GCM, сжатие — `Bun.gzipSync`/`gunzipSync`; RustFS `rustfs/rustfs:1.0.3`; Docker Engine API v1.47 (тома `local` с `type=overlay`, `PUT/GET /containers/{id}/archive`).

**Spec:** `docs/superpowers/specs/2026-10-16-cloud-gaming-mvp-design.md` (§3 п.3, §6 `installing`, §7.4, §8, §14 риски 4–6). Решения владельца 2026-10-21: NFS в MVP не используется — агент получает путь к библиотеке на хосте (в проде provisioner смонтирует NFS по тому же пути); профили в RustFS входят в этот план.

**Выводы спайков 2026-10-21/22 на brofrong (на них опирается план):**
- Docker `local`-том `-o type=overlay -o device=overlay -o o=lowerdir=…,upperdir=…,workdir=…` монтируется демоном без sudo; запись в контейнере попадает только в upper. Steam запустил Vampire Survivors из overlay-библиотеки за 40 с, ничего не обновлял, upper — 340 КБ.
- Заготовка манифеста (`StateFlags 1026`) + перезапуск Steam → Steam сам ставит игру и её зависимости (Baba Is You 736260 потянул Steam Linux Runtime 1628350): `BytesDownloaded`/`BytesToDownload` в acf — прогресс, конец — `StateFlags 4` («Fully Installed» в `content_log.txt`).
- Чистый клиент Steam (bootstrap без входа, 2,5 ГБ) как lower для `~/.local/share/Steam` + профиль 7 МБ (gzip) через `docker cp` в созданный контейнер → Steam вошёл сам по сохранённому JWT (без QR) и запустил игру. От старта Steam до игры 67 с, upper клиента 479 МБ (Steam доразворачивал `steamrt64` и `appcache`) — шаблон клиента нужно доводить до устойчивого состояния (Task 7).
- Ловушка: каталоги, которых нет в образе/архиве, Docker создаёт от root (точки монтирования, родители путей из tar) → `bin_steam.sh: ln: Permission denied`, Steam молча выходит. Отсюда: каталоги дома заранее в образе, архив профиля содержит записи всех каталогов-родителей.
- В `steamapps` есть личные данные: `compatdata/<appid>` (префикс Proton с сохранениями), `common/Steam Controller Configs/<accountid>` (раскладки), `workshop`, `shadercache` — в общую библиотеку они не попадают никогда.

**Место в MVP.** План 3 из 4. Не входит (план 4): админка gamestore (место, список, удалить игру), обновление уже установленных игр в библиотеке (пока устаревшую игру Steam докачает в личный слой сессии — медленнее, но работает), несколько gamestore/воркеров, NFS, kiosk-образ, сетевая изоляция.

## Global Constraints

- Всё из MVP-2 остаётся в силе: пиннинг версий, `bun check`/`bun lint`/`bun test`/`bun fmt`, стиль Effect 4 (`Context.Service`, `Schema.TaggedError`, `Config` + `Redacted`), интерфейс на русском, секреты только в `.env`.
- Состояния сессии (точные строки): `queued`, `installing`, `starting`, `playing`, `idle_warning`, `disconnected`, `stopping`, `ended`, `failed`. `installing` не оплачивается и не требует агента сессии.
- Новые секреты `.env`: `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` (≥ 16 символов), `PROFILE_KEY` (base64 ровно 32 байт). Ключ профиля видит только агент; в логи и отчёты — никогда.
- Пути в контейнере сессии: `HOME=/home/ubuntu`, клиент Steam `/home/ubuntu/.local/share/Steam`, библиотека `/home/ubuntu/.local/share/Steam/steamapps`. Все процессы контейнера — uid/gid 1000 (`ubuntu`); любой файл/каталог, который мы создаём в доме, — 1000:1000.
- Каталоги хоста на brofrong (значения по умолчанию в `deploy/compose.yaml`, в коде — только из конфига): библиотека `LIBRARY_DIR=/raid/cloud-gaming/library` (внутри `steamapps/`), клиент `STEAM_CLIENT_DIR=/raid/cloud-gaming/steam-client`, scratch сессий `SCRATCH_DIR=/home/brofrong/cloud-gaming/scratch` (NVMe), scratch установок `INSTALL_SCRATCH_DIR=/raid/cloud-gaming/install-scratch` (та же ФС, что библиотека — перенос `rename`). Владелец каталогов — uid 1000 (brofrong). Агент монтирует их в свой контейнер по тем же путям.
- Сессия и установщик никогда не пишут в lower-каталоги напрямую; в библиотеку пишет только перенос из Task 4 и только новые приложения (существующие в библиотеке не трогаются).
- Профиль: формат `CGP1` (4 байта ASCII) + IV 12 байт + AES-256-GCM(gzip(tar)) с тегом; объект `profiles/<userId>/<uuid>.cgp` в бакете `S3_BUCKET` (по умолчанию `cg-profiles`); версия — в таблице `profiles`, выгрузка с устаревшей базовой версией отклоняется (спека §6).
- Старый том `cg-home-<userId>` (MVP-2) только читается — один раз, для импорта профиля, если в `profiles` нет записи. Никогда не изменяется и не удаляется кодом.
- На brofrong: без sudo, без перезагрузок, без `docker * prune`, чужие контейнеры/тома/сети не трогать; перед деплоем — нет запущенных `cg.session`/`cg.install` контейнеров.

## Review Focus

1. **Сохранения переживают сессию**, включая Proton-игры (сохранения в `compatdata/<appid>/pfx/drive_c/users/steamuser`, реестр `pfx/user.reg`) и Linux-игры (`~/.config/…`, `~/.local/share/<Company>`). Тесты: Task 3 `pack list covers saves and parents`; приёмка Task 7 (20 Minutes Till Dawn + Vampire Survivors).
2. **Выгрузка профиля не удалась** (RustFS недоступен, тайм-аут, сбой экспорта) — дом не теряется: контейнер `cg-session-<id>` остаётся остановленным вместе со своими overlay-слоями, агент пишет в лог `profile-unsaved` с id, `Stopped{profileSaved:false}`; ни остановка, ни перезапуск агента такой контейнер не удаляют; следующая сессия получает предыдущий профиль. Тест: Task 3 `profile upload failure keeps container`.
3. **Двое нажали «Играть» на одной неустановленной игре** — одна установка, обе сессии в `installing` видят один и тот же процент; установка упала — обе `failed` с «Не удалось установить игру». Тест: Task 5 `second session joins running install job`, `failed job fails waiting sessions`.
4. **Агент перезапустился посреди установки или сессии** — осиротевшие контейнеры установки, overlay-тома и scratch убраны; установка помечена `failed`, ждущие её сессии `failed`; живая сессия подхвачена как раньше. Тесты: Task 4 `reconcile removes orphan installs`, Task 5 `install missing from reconnect fails job`.
5. **Устаревшая выгрузка профиля** (две записи с одной базовой версией) — вторая отклонена, загруженный ею объект удалён, более новый профиль цел. Тесты: Task 5 `profile commit rejects stale base`, Task 3 `rejected commit deletes uploaded object`.

---

## Файловая структура

```
packages/db/src/schema/gamestore.ts           gamestore_apps, install_jobs, profiles (+ миграция, триггер прогресса)
packages/db/src/schema/sessions.ts            + state 'installing', sessions.install_job_id
packages/rpc/src/{agent,session,settings}.ts  протокол установки/профиля, installPercent, installTimeoutMinutes
apps/agent/src/profile/{codec,ProfileStore}.ts   шифрование/формат, S3
apps/agent/src/{Overlay,Installer}.ts            overlay-тома и scratch; установщик (роль gamestore)
apps/agent/src/{config,DockerClient,SessionSupervisor,OrchestratorLink,main}.ts   изменения
apps/orchestrator/src/{InstallRepo,InstallDispatcher}.ts   установки; + lifecycle/Scheduler/SessionRepo/AgentHub/http
apps/api/src/session/SessionRepo.ts, apps/web/src/components/SessionStatus.tsx, admin settings form
images/session/{Dockerfile,cg-launch,cg-steam-shutdown,cg-profile-pack}
deploy/{compose.yaml,deploy.sh,build-steam-client.sh,README.md}
```

---

### Task 1: Данные и протокол

**Files:**
- Create: `packages/db/src/schema/gamestore.ts`, миграция `packages/db/migrations/<ts>_gamestore/` (generate + ручной SQL триггера)
- Modify: `packages/db/src/schema/{sessions,index}.ts`, `packages/rpc/src/{agent,session,settings}.ts`
- Test: `packages/db/test/gamestore.test.ts`, `packages/rpc/test/{settings,agent}.test.ts`

**Interfaces:**
- Produces:
  - `sessionStates` (db) и `SessionState` (rpc): `installing` между `queued` и `starting`.
  - `sessions.installJobId text null` → `install_jobs.id`.
  - `gamestoreApps` (`gamestore_apps`): `appId integer pk → games`, `sizeBytes bigint not null`, `buildId text not null`, `installedAt timestamptz not null default now()`. Строка есть ⇔ игра в библиотеке.
  - `installJobStates = ["queued","running","done","failed"] as const`; `installJobs` (`install_jobs`): `id text pk` (uuid), `appId → games`, `userId → user cascade` (чьим Steam качаем), `state text default 'queued'`, `workerId text → workers null`, `bytesDownloaded bigint null`, `bytesTotal bigint null`, `error text null`, `createdAt`, `updatedAt`. Частичный уникальный индекс `(appId) where state in ('queued','running')`.
  - `profiles`: `userId text pk → user cascade`, `version integer not null`, `objectKey text not null`, `sizeBytes integer not null`, `updatedAt`.
  - Триггер `AFTER UPDATE ON install_jobs` → `pg_notify('session_changed', s.id)` для каждой `sessions s` с `s.install_job_id = NEW.id and s.state = 'installing'`.
  - `SessionSettings.installTimeoutMinutes: Int 10..720`, по умолчанию `180`.
  - `SessionView.installPercent: NullOr(Int 0..100)` — только в `installing`, иначе `null`.
  - Протокол агента:
    - `AgentConnect` + `roles: Array(Literals(["worker","gamestore"]))`, `installs: Array(String)` (id установок, чьи контейнеры живы).
    - `ProfileRef = Struct({ version: Int, objectKey: String })`.
    - `StartSession` + `profile: NullOr(ProfileRef)`.
    - Команды `InstallGame { jobId, appId, userId, profile: NullOr(ProfileRef) }`, `CancelInstall { jobId }`.
    - Отчёты `InstallProgress { jobId, bytesDownloaded: NonNegativeInt, bytesTotal: NonNegativeInt }`, `InstallFinished { jobId, sizeBytes: NonNegativeInt, buildId: String }`, `InstallFailed { jobId, reason: String }`; `Stopped` + `profileSaved: Boolean`.
    - RPC `agent.profileCommit`: payload `{ userId, baseVersion: NullOr(Int), objectKey, sizeBytes: NonNegativeInt }`, success `{ accepted: Boolean }`, error `AgentNotConnected`.

- [ ] **Step 1: тесты**
  ```ts
  // packages/db/test/gamestore.test.ts (DbTest)
  it("second active install job for an app violates unique index", ...)
  it("done job does not block a new job for the app", ...)
  it("install job progress update notifies its installing sessions", ...)   // LISTEN session_changed → id сессии
  // packages/rpc/test/settings.test.ts
  it("installTimeoutMinutes defaults to 180 and rejects 9 and 721", ...)
  // packages/rpc/test/agent.test.ts
  it("decodes InstallGame and InstallProgress round-trip", ...)
  it("rejects AgentConnect with unknown role", ...)
  ```
- [ ] **Step 2:** `bun test` в `packages/db`, `packages/rpc` — FAIL (нет таблиц/полей).
- [ ] **Step 3:** схема + `bun run db:generate`, SQL триггера руками в ту же миграцию; поля протокола; дополнить `installing` везде, где `switch` по состоянию должен быть исчерпывающим (`bun check` по монорепе покажет места; поведение там — Task 5/6).
- [ ] **Step 4:** `bun run check && bun test` в корне — PASS.
- [ ] **Step 5:** commit `feat(db,rpc): gamestore, install jobs, profiles, installing state`.

### Task 2: Профиль — формат, шифрование, хранилище

**Files:**
- Create: `apps/agent/src/profile/codec.ts`, `apps/agent/src/profile/ProfileStore.ts`
- Modify: `apps/agent/src/config.ts`
- Test: `apps/agent/test/profileCodec.test.ts`, `apps/agent/test/profileStore.test.ts`

**Interfaces:**
- Produces:
  - `codec.ts`: `PROFILE_MAGIC = "CGP1"`; `sealProfile(tar: Uint8Array, key: CryptoKey) => Effect<Uint8Array>`; `openProfile(blob: Uint8Array, key: CryptoKey) => Effect<Uint8Array, ProfileCorrupt>`; `importProfileKey(base64: Redacted<string>) => Effect<CryptoKey, ProfileKeyInvalid>` (ровно 32 байта); `extractSingleFile(tar: Uint8Array) => Uint8Array` — содержимое единственного файла из tar, который отдаёт `GET /archive` (ustar: заголовок 512 байт, размер — октальное поле 124..135).
  - `ProfileStore` (`Context.Service`): `get(objectKey) => Effect<Uint8Array, ProfileStoreError>` (расшифрованный tar), `put(userId, tar) => Effect<{ objectKey: string; sizeBytes: number }, ProfileStoreError>` (ключ `profiles/<userId>/<crypto.randomUUID()>.cgp`, `sizeBytes` — размер зашифрованного объекта), `remove(objectKey) => Effect<void, ProfileStoreError>`. Слой поверх `Bun.S3Client` (endpoint, bucket, ключи из конфига; path-style).
  - `config.ts` + `s3Endpoint` (`S3_ENDPOINT`, напр. `http://cg-rustfs:9000`), `s3Bucket` (`S3_BUCKET`, по умолчанию `cg-profiles`), `s3AccessKey`/`s3SecretKey` (Redacted), `profileKey` (`PROFILE_KEY`, Redacted).

- [ ] **Step 1: тесты**
  ```ts
  it("seal/open round-trips and starts with CGP1", ...)
  it("open fails ProfileCorrupt on flipped ciphertext byte", ...)
  it("open fails ProfileCorrupt on wrong key", ...)
  it("importProfileKey rejects 31-byte key", ...)
  it("extractSingleFile returns the payload of a one-entry tar", ...)  // фикстура: tar из `tar -cf` с файлом 1500 байт
  it("ProfileStore.put uses profiles/<userId>/<uuid>.cgp and get returns the original tar", ...)  // фейковый S3 на Bun.serve
  ```
- [ ] **Step 2:** `bun test apps/agent/test/profile*` — FAIL.
- [ ] **Step 3:** реализация (gzip внутри шифрования; IV — `crypto.getRandomValues`).
- [ ] **Step 4:** тесты PASS, `bun check` PASS.
- [ ] **Step 5:** commit `feat(agent): encrypted profile archives in S3`.

### Task 3: Сессия на overlay и профиле

**Files:**
- Create: `apps/agent/src/Overlay.ts`, `images/session/cg-profile-pack`, `images/session/cg-steam-shutdown`
- Modify: `apps/agent/src/{DockerClient,SessionSupervisor,config,main}.ts`, `images/session/{Dockerfile,cg-launch,README.md}`
- Test: `apps/agent/test/{overlay,dockerClient,supervisor}.test.ts`, `apps/agent/test/profilePack.test.ts`

**Interfaces:**
- Consumes: Task 1 `StartSession.profile`, `Stopped.profileSaved`, `agent.profileCommit`; Task 2 `ProfileStore`, `extractSingleFile`.
- Produces:
  - `DockerClient`: `createVolume({ name, labels, overlay: { lower, upper, work } })` (`POST /volumes/create`, драйвер `local`, `type=overlay,device=overlay,o=lowerdir=…,upperdir=…,workdir=…`), `removeVolume(name)` (нет — успех), `putArchive(container, path, tar)`, `getArchive(container, path) => Uint8Array`, `create(spec)` (без старта) + `start(name)`; `createAndStart` остаётся как `create`+`start`. `ContainerSpec` + `mounts: Array<{ volume: string; target: string; readOnly?: boolean }>` (→ `HostConfig.Mounts`), `entrypoint?`, `cmd?`, `user?`.
  - `Overlay.ts`: `sessionLayers(config, sessionId)` → `{ client: { volume: "cg-s-<id>-client", upper, work }, apps: { volume: "cg-s-<id>-apps", upper, work } }` под `<SCRATCH_DIR>/<id>/{client,apps}/{upper,work}`; `prepare(layers)` — `mkdir -p` (агент, uid 1000) + `createVolume` с метками `cg.session=<id>`; `cleanup(layers)` — `removeVolume` + удаление `<SCRATCH_DIR>/<id>` вспомогательным контейнером образа сессии (`user: "0"`, `entrypoint: ["rm","-rf",path]`, bind каталога) — `work/work` создаёт ядро от root, сам агент его не удалит.
  - Образ: `cg-profile-pack` — из `$HOME` пишет `/tmp/cg-profile.tar` (GNU tar, uid 1000) по whitelist; `--list` печатает записи (сначала каталоги-родители, затем пути). Whitelist: `.local/share/Steam/config` (без `htmlcache`, `avatarcache`), `.local/share/Steam/local.vdf`, `.local/share/Steam/userdata`, `.steam/registry.vdf`, `.config`, все `.local/share/*` кроме `Steam`, `.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/users/steamuser`, `.local/share/Steam/steamapps/compatdata/*/pfx/user.reg`, `.local/share/Steam/steamapps/common/Steam Controller Configs`. Несуществующие пути пропускаются. `cg-steam-shutdown` — `steam -shutdown` в окружении сессии Plasma (как `cg-launch`), ждёт выхода клиента до 30 с. Dockerfile: `/home/ubuntu/.local/share/Steam/steamapps` и `/home/ubuntu/.steam` заранее, владелец `ubuntu`.
  - `sessionSpec`: без тома `cg-home-*`; `mounts` = client-том → `/home/ubuntu/.local/share/Steam`, apps-том → `/home/ubuntu/.local/share/Steam/steamapps`.
  - Старт: `prepare` → `create` → профиль в контейнер (`putArchive(name, "/home/ubuntu", tar)`): из `ProfileStore.get(profile.objectKey)`, либо (нет `profile`, есть том `cg-home-<userId>`) импорт — вспомогательный контейнер образа с этим томом `readOnly` в `/home/ubuntu`, `cmd: ["cg-profile-pack"]`, затем `getArchive(helper, "/tmp/cg-profile.tar")`; иначе пустой дом (первый вход по QR) → `start`.
  - Остановка (после ожидания облака, как сейчас): `exec cg-steam-shutdown` → `exec cg-profile-pack` → `getArchive` → `ProfileStore.put` → `agent.profileCommit({ baseVersion: profile?.version ?? null, … })`; `accepted: false` → `ProfileStore.remove(objectKey)`. Успех (в т.ч. отклонение) → `remove` контейнера, `cleanup`, `Stopped{profileSaved: accepted}`. Сбой экспорта/выгрузки/коммита → контейнер `stop`, не удаляется, `cleanup` не вызывается (upper-слои принадлежат контейнеру), лог `profile-unsaved` с id, `Stopped{profileSaved:false}`.
  - Переподключение (`running`) — как раньше (только запущенные контейнеры). При старте агента тома/scratch `cg-s-<id>` удаляются, только если контейнера `cg-session-<id>` нет вовсе; остановленные контейнеры `cg.session` агент не удаляет никогда.

- [ ] **Step 1: тесты**
  ```ts
  // profilePack.test.ts — запускает `bash images/session/cg-profile-pack --list` с HOME=фикстура
  it("pack list covers saves and parents", ...)   // compatdata/1966900/pfx/drive_c/users/steamuser, user.reg, .config/x, .local/share/Company/save, Controller Configs; каждый их родитель от .local/.steam перечислен раньше; нет htmlcache, core.*, steamapps/common/<игра>
  // overlay.test.ts
  it("sessionLayers puts upper/work under SCRATCH_DIR/<id>", ...)
  it("createVolume body carries overlay options", ...)            // createBody для томов, как createBody для контейнеров
  // supervisor.test.ts (фейковые DockerClient/ProfileStore/link)
  it("start restores profile before container start", ...)        // порядок: prepare, create, putArchive, start
  it("start imports legacy cg-home volume when no profile", ...)  // helper read-only, getArchive /tmp/cg-profile.tar
  it("stop saves profile then removes container and layers", ...) // put → commit → remove → cleanup → Stopped{profileSaved:true}
  it("rejected commit deletes uploaded object", ...)
  it("profile upload failure keeps container", ...)               // нет remove/cleanup, Stopped{profileSaved:false}
  it("agent start removes orphan cg-s volumes and scratch", ...)
  ```
- [ ] **Step 2:** тесты — FAIL.
- [ ] **Step 3:** реализация; `cg-launch` не меняется в этой задаче.
- [ ] **Step 4:** `bun test` и `bun check` в `apps/agent` — PASS; `bash -n` для скриптов.
- [ ] **Step 5:** commit `feat(agent): sessions on shared overlays with encrypted profiles`.

### Task 4: Установщик (роль gamestore)

**Files:**
- Create: `apps/agent/src/Installer.ts`
- Modify: `apps/agent/src/{config,OrchestratorLink,main}.ts`, `images/session/cg-launch`
- Test: `apps/agent/test/installer.test.ts`

**Interfaces:**
- Consumes: Task 1 `InstallGame`/`CancelInstall`, отчёты установки, `AgentConnect.roles/installs`; Task 3 `DockerClient` (тома, archive), профиль (restore/save — те же функции, что у сессии).
- Produces:
  - `config.ts` + `roles` (`ROLES`, через запятую, по умолчанию `worker`), `libraryDir` (`LIBRARY_DIR`), `steamClientDir` (`STEAM_CLIENT_DIR`), `scratchDir` (`SCRATCH_DIR`), `installScratchDir` (`INSTALL_SCRATCH_DIR`). Роль `gamestore` без `LIBRARY_DIR`/`INSTALL_SCRATCH_DIR` — ошибка конфига.
  - `cg-launch`: `CG_MODE=install` → `exec steam -silent` (без `-applaunch`); иначе как раньше.
  - `Installer` (`Context.Service`): `install(cmd: InstallGame)`, `cancel(jobId)`, `running(): ReadonlyArray<string>`. Одна установка за раз; вторая команда, пока идёт первая, → `InstallFailed{reason:"Установщик занят"}` (оркестратор так не делает — защита).
  - Контейнер `cg-install-<jobId>` (метка `cg.install=<jobId>`, без UDP-порта, без `-applaunch`, `CG_MODE=install`): client-overlay и apps-overlay (lower = `<LIBRARY_DIR>/steamapps`) (тома `cg-i-<jobId>-client`, `cg-i-<jobId>-apps`, метка `cg.install=<jobId>`) со scratch в `<INSTALL_SCRATCH_DIR>/<jobId>/{client,apps}/{upper,work}`; профиль пользователя восстанавливается как у сессии; заготовка кладётся `putArchive` в `…/steamapps` до старта:
    ```
    "AppState"
    {
    	"appid"		"<appId>"
    	"Universe"		"1"
    	"installdir"		"<appId>"
    	"StateFlags"		"1026"
    }
    ```
    (`installdir` Steam перезапишет на настоящий; `<appId>` — чтобы не зависеть от названия.)
  - Опрос раз в 2 с: `exec cat …/steamapps/appmanifest_<appId>.acf` → `InstallProgress` при изменении `BytesDownloaded`/`BytesToDownload`; `StateFlags` = `4` → готово. Нет прогресса 10 мин → `InstallFailed{reason:"Загрузка остановилась"}`.
  - Готово → прочитать `SizeOnDisk`, `buildid` целевого манифеста → `cg-steam-shutdown` → сохранить профиль (как в Task 3) → удалить контейнер и `removeVolume` обоих томов (overlay размонтирован; трогать upper смонтированного overlay нельзя) → перенос: для каждого `appmanifest_<id>.acf` в upper apps со `StateFlags 4`, которого нет в lower, — `rename` каталога `common/<installdir из этого манифеста>` и самого манифеста из upper в `<LIBRARY_DIR>/steamapps` (каталог раньше манифеста); существующие в lower приложения и всё остальное в upper (`compatdata`, `workshop`, `shadercache`, `Steam Controller Configs`, обновления чужих игр) не переносится → `InstallFinished{ sizeBytes, buildId }` → удалить scratch.
  - Сбой/отмена/таймаут → контейнер и scratch удалены, библиотека не тронута, `InstallFailed`.
  - Старт агента: контейнеры `cg.install` и scratch установок удаляются (установка после перезапуска не продолжается; оркестратор пометит её failed по `installs`).

- [ ] **Step 1: тесты** (фейковые Docker/ProfileStore/link; библиотека и scratch — временные каталоги)
  ```ts
  it("writes stub manifest before starting the installer container", ...)
  it("reports progress from appmanifest bytes", ...)                     // acf с BytesDownloaded 44/88 → InstallProgress{44,88}
  it("promotes new apps and their dependencies into the library", ...)   // upper: 736260 и 1628350 со StateFlags 4 → оба в lower
  it("never promotes apps already in the library or per-user dirs", ...) // 1794680 в lower и upper, compatdata, workshop — lower не меняется
  it("stalled download fails the job and leaves the library untouched", ...)
  it("reconcile removes orphan installs", ...)
  ```
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализация; `OrchestratorLink` передаёт `InstallGame`/`CancelInstall` в `Installer` и добавляет `roles`, `installs` в `AgentConnect`.
- [ ] **Step 4:** `bun test`, `bun check` в `apps/agent` — PASS.
- [ ] **Step 5:** commit `feat(agent): unattended game installs into the shared library`.

### Task 5: Оркестратор — установки и версии профилей

**Files:**
- Create: `apps/orchestrator/src/InstallRepo.ts`, `apps/orchestrator/src/InstallDispatcher.ts`
- Modify: `apps/orchestrator/src/{lifecycle,Scheduler,SessionRepo,SessionRunner,AgentHub,http,main}.ts`
- Test: `apps/orchestrator/test/{lifecycle,install,profile}.test.ts`

**Interfaces:**
- Consumes: Task 1 таблицы и протокол.
- Produces:
  - `lifecycle`: события `InstallStarted`, `InstallFinished`, `InstallFailed{reason}`; `queued` + `InstallStarted` → `installing`; `installing` + `InstallFinished` → `queued` (`stateSince = now`); `installing` + `InstallFailed` → `failed` с `failReasons.installFailed = "Не удалось установить игру"`; `Tick` в `installing` дольше `installTimeoutMinutes` → `failed` с `failReasons.installTimeout = "Установка не закончилась за отведённое время"`. Проверка молчания агента не применяется к `queued` и `installing`. Отрезков и `StopContainer` нет.
  - `Scheduler.placeOne`: игры `appId` нет в `gamestore_apps` → сессия не размещается, а получает `installJobId` (активная задача этого appid или новая `queued` с `userId` сессии) и `InstallStarted` — в той же транзакции.
  - `InstallDispatcher` (цикл раз в 2 с): самая старая `queued`-задача → подключённый агент с ролью `gamestore` без `running`-задачи → `state='running'`, `workerId` → `InstallGame` с `profile` пользователя задачи (не доставлено — назад в `queued`). Отчёты: `InstallProgress` → байты; `InstallFinished` → upsert `gamestore_apps`, `done`, ждущие сессии `InstallFinished`; `InstallFailed` → `failed`+`error`, ждущие сессии `InstallFailed`. Агент переподключился без задачи в `installs` или молчит дольше `AGENT_TIMEOUT_MS` → задача `failed` («Установка прервана»). У ждущей сессии запрошена остановка (`stopRequestedAt`) → `ended` (последняя ждущая — `CancelInstall`).
  - `agent.profileCommit` (http): `baseVersion = null` → `insert … on conflict do nothing` (принято, если вставлено, `version = 1`); иначе `update profiles set version = base + 1, objectKey, sizeBytes where userId and version = base` (принято, если обновлена 1 строка). Старый объект после принятия не удаляется в MVP (рост ограничен числом сессий; чистка — план 4).
  - `StartSession.profile` из `profiles` пользователя.
- [ ] **Step 1: тесты**
  ```ts
  // lifecycle.test.ts
  it("installing never bills and times out with installTimeout reason", ...)
  it("install finished returns session to queued", ...)
  // install.test.ts (DbTest + фейковый AgentHub)
  it("uninstalled game moves session to installing with a new job", ...)
  it("second session joins running install job", ...)
  it("dispatcher sends InstallGame only to a gamestore agent", ...)
  it("failed job fails waiting sessions", ...)
  it("install missing from reconnect fails job", ...)
  it("stop requested while installing ends the session and cancels the last waiter's job", ...)
  // profile.test.ts
  it("first profile commit with null base is accepted as version 1", ...)
  it("profile commit rejects stale base", ...)
  ```
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** реализация.
- [ ] **Step 4:** `bun test`, `bun check` в `apps/orchestrator` — PASS.
- [ ] **Step 5:** commit `feat(orchestrator): install jobs and versioned profiles`.

### Task 6: Сайт — «Устанавливаем N %»

**Files:**
- Modify: `apps/api/src/session/SessionRepo.ts` (`installPercent`), `apps/web/src/components/SessionStatus.tsx`, форма настроек админки, `apps/api/src/admin/settings.ts` (новое поле проходит как есть)
- Test: `apps/api/test/session*.test.ts`, `apps/web/test/session*.test.tsx`, `apps/web/test/settings*.test.tsx`

**Interfaces:**
- Consumes: Task 1 `SessionView.installPercent`, `installTimeoutMinutes`.
- Produces: `installPercent = floor(100 * bytesDownloaded / bytesTotal)` задачи сессии, `0` пока `bytesTotal` нет или 0, только в `installing`. Экран: заголовок «Устанавливаем игру», полоса прогресса и «N %», подпись «Время установки не входит в игровое»; кнопка «Отменить» (тот же `session.stop`). Админка: поле «Таймаут установки, мин» (10–720).
- [ ] **Step 1: тесты**
  ```ts
  it("session view reports installPercent 34 for 34 of 100 bytes", ...)
  it("installPercent is null outside installing", ...)
  it("installing screen shows 34 % and the not-billed note", ...)
  it("settings form rejects install timeout 9", ...)
  ```
- [ ] **Step 2:** FAIL. **Step 3:** реализация. **Step 4:** `bun test`, `bun check`, `bun lint` — PASS.
- [ ] **Step 5:** commit `feat(web): install progress screen`.

### Task 7: Образ, RustFS, деплой и приёмка на brofrong

**Files:**
- Create: `deploy/build-steam-client.sh`
- Modify: `deploy/{compose.yaml,deploy.sh,README.md}`, `images/session/README.md`, `.env.example`
- Test: приёмка на сервере (ниже); `bash -n` скриптов.

**Interfaces:**
- Consumes: всё выше.
- Produces:
  - `compose.yaml`: `cg-rustfs` (`rustfs/rustfs:1.0.3`, только сеть `cg`, том `cg-rustfs-data`, `mem_limit` 512m, ключи из `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`); `cg-agent`: `ROLES=worker,gamestore`, четыре каталога из Global Constraints по тем же путям (bind), `S3_*`, `PROFILE_KEY`, зависит от `cg-rustfs`.
  - `deploy.sh`: создаёт каталоги хоста (без sudo, владелец brofrong), бакет (идемпотентно, пиннутый образ S3-клиента в сети `cg`), отказывается деплоить при живых `cg.session`/`cg.install`.
  - `build-steam-client.sh` (на воркере): контейнер образа с пустым домом и `CG_MODE=install` → ждёт входа в цикл (`logs/connection_log.txt` и 60 с без роста `~/.local/share/Steam`) → `cg-steam-shutdown` → второй такой же цикл (довести `steamrt64`/`appcache`) → `docker cp` клиента в `<STEAM_CLIENT_DIR>.new` без `logs/`, с пустым `steamapps/` → замена каталога переименованием, старый удаляется вспомогательным контейнером.
  - README: топология, секреты, пересборка клиента Steam, что делать с контейнером `profile-unsaved`, импорт старого `cg-home-*` (происходит сам при первой сессии; том можно удалить вручную после проверки).
- [ ] **Step 1:** образ сессии пересобран (`build-session-image.sh`), клиент Steam собран (`build-steam-client.sh`), деплой.
- [ ] **Step 2: приёмка с владельцем** (сессий в начале нет):
  1. Vampire Survivors (нет в библиотеке) → «Устанавливаем N %» растёт → игра; профиль импортирован из `cg-home-*` — QR не спрашивали.
  2. Поиграть, получить прогресс, выйти → в `profiles` версия 1, объект в RustFS; `<SCRATCH_DIR>` пуст, томов `cg-s-*` нет.
  3. Снова Vampire Survivors → без установки, ≤ 60 с от «Играть» до игры, прогресс на месте.
  4. 20 Minutes Till Dawn (Proton) → установка → сохранение в игре → выход → снова → сохранение на месте.
  5. Вторая вкладка/второй аккаунт на ту же неустановленную игру (если есть второй аккаунт) — одна установка, общий процент.
  6. Библиотека: `steamapps` содержит только `appmanifest_*.acf` и `common/<игры и рантаймы>`; нет `compatdata`, `workshop`, `shadercache`, `Steam Controller Configs`.
- [ ] **Step 3:** commit `feat(deploy): rustfs, shared library dirs and steam client template`.
