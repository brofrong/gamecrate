# Вход в Steam по QR на сайте — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Новый игрок подключает Steam одним QR на сайте; этот вход привязывает Steam-аккаунт и попадает в профиль, так что установки и игры идут под его аккаунтом без QR в трансляции.

**Architecture:** API заводит попытку входа строкой в `steam_logins`; оркестратор (`steam-session`) показывает QR через эту строку, по подтверждению привязывает Steam (`account` + `user.steam_id`) и держит вход в памяти. Вход прикладывается к следующей `StartSession`/`InstallGame` пользователя; агент вписывает его в дом контейнера (`local.vdf` ConnectCache и ещё три файла) до старта, сохранение профиля уносит его в RustFS. Установщик ждёт `Logged On` в логе Steam и без него падает причиной «Войдите в Steam», по которой сайт снова показывает QR.

**Tech Stack:** Bun, Effect 4.0.5 (Schema, RPC), Drizzle 1.0 RC + PostgreSQL, `steam-session` 1.9.4, React SPA (effect/reactivity атомы), библиотека QR для браузера (`qrcode` 1.5.4).

**Spec:** `docs/superpowers/specs/2026-10-23-steam-qr-login-design.md` (читать вместе с блоком «Отклонения при планировании» в шапке — он заменяет §5.2–5.3).

## Global Constraints

- Токен (`refreshToken`) и `accountName` никогда не попадают в БД, логи, ответы API, тексты ошибок и браузер; в схемах — `Schema.Redacted(Schema.String)` (или эквивалент Effect 4.0.5), в коде — `Redacted`.
- `machineFriendlyName: "GameCrate"`, платформа `EAuthTokenPlatformType.SteamClient`.
- Ключ ConnectCache: CRC-32 (IEEE) от `accountName` строчным hex **без** дополнения нулями + `"1"`; значение — hex `AES-256-ECB(K, IV) ‖ AES-256-CBC(K, IV, PKCS7(token))`, `K = SHA-256(accountName)`, IV — 16 случайных байт.
- Файлы входа (владелец uid/gid 1000): `/home/ubuntu/.local/share/Steam/local.vdf`, `/home/ubuntu/.local/share/Steam/config/loginusers.vdf`, `/home/ubuntu/.local/share/Steam/config/config.vdf`, `/home/ubuntu/.steam/registry.vdf`.
- Попытка QR ждёт сканирования не дольше 5 мин; на пользователя одна активная попытка, новая отменяет старую.
- Вход в памяти оркестратора живёт 24 ч или до принятого коммита профиля с `steamLoginSeeded: true`.
- `steamLoginTimeoutSeconds` в настройках сессий: 30–600, по умолчанию 90.
- `steamLoginRequiredReason` = `"Войдите в Steam"`.
- Тексты для игрока: «Подключить Steam», «Откройте приложение Steam на телефоне → значок щита → «Сканировать QR-код»», «Ждём сканирования», «Подтвердите вход в приложении Steam», «Готово», «Время вышло», «Показать новый код», «Войдите в Steam ещё раз», «Сначала отвяжите текущий Steam», «Этот Steam уже привязан к другому аккаунту», «Вход прервался, покажите новый код», «Steam не ответил, попробуйте ещё раз».
- brofrong: без sudo, только свои `cg*`-контейнеры/тома; перед деплоем — ни одного контейнера `cg.session`/`cg.install`.

## Review Focus

- Попытка «зависла» после перезапуска оркестратора (строка `waiting`, процесса нет) — сайт должен получить `failed` «Вход прервался, покажите новый код», а не крутиться вечно (Task 5).
- В шаблоне клиента Steam уже есть старые `connection_log.txt` со строками `Logged On` — установщик не должен принять их за вход (Task 3: смещение лога на момент старта).
- В профиле уже вошёл **другой** Steam-аккаунт (или тот же со старым токеном) — после вписывания автологин идёт на новый аккаунт, чужие записи `loginusers.vdf`/ConnectCache не ломаются (Task 2).
- Две вкладки: старая продолжает опрашивать отменённую попытку — должна показать «Время вышло» + «Показать новый код», а не ошибку (Task 6 — отображение `cancelled → expired`, Task 7 — кнопка).
- Логи агента/оркестратора: команды `StartSession`/`InstallGame` со вложенным входом и ошибки `steam-session` логируются без токена (Task 3, Task 5).

---

### Task 1: Контракты — таблица попыток, RPC, команды агента, настройка

**Files:**
- Modify: `packages/db/src/schema/gamestore.ts` (таблица `steamLogins`), `packages/db/src/schema/index.ts` (экспорт, если требуется)
- Create: миграция `packages/db/migrations/<ts>_steam_logins/` (`bunx drizzle-kit generate` из `packages/db`)
- Create: `packages/rpc/src/steamLogin.ts`; Modify: `packages/rpc/src/index.ts` (экспорт, `SteamLoginRpcs` в `AppRpcs`)
- Modify: `packages/rpc/src/agent.ts`, `packages/rpc/src/settings.ts`
- Modify (чтобы дерево компилировалось): все места, где строятся `StartSession`, `InstallGame`, `ProfileCommit` (оркестратор `Scheduler.ts:254`, `InstallDispatcher.ts:308`, агент `HomeProfile.saveProfile`, тесты/фейки) — пока `steamLogin: null`, `steamLoginTimeoutSeconds` из настроек/90, `steamLoginSeeded: false`; админ-форма `apps/web/src/components/admin/SessionSettingsForm*` — новое поле
- Test: `packages/db/test/gamestore.test.ts`, `packages/rpc/test/agent.test.ts`, `packages/rpc/test/steamLogin.test.ts` (новый), `apps/web/test/settingsForm.test.tsx`

**Interfaces:**
- Produces:
  - `steamLogins` (`steam_logins`): `id text pk`, `userId text not null → user.id cascade`, `state text enum steamLoginStates not null default 'pending'`, `qrUrl text null`, `error text null`, `createdAt`, `updatedAt` (`$onUpdate`); частичный уникальный индекс `steam_logins_active_user_idx` на `userId` где `state in ('pending','waiting','scanned')`.
  - `steamLoginStates = ["pending","waiting","scanned","done","expired","failed","cancelled"] as const`, `SteamLoginState`.
  - `packages/rpc/src/steamLogin.ts`: `SteamLoginView = Schema.Struct({ attemptId: String, status: Literals(["waiting","scanned","done","expired","failed"]), qrUrl: NullOr(String), reason: NullOr(String) })`; `class SteamLoginNotFound extends Schema.TaggedError(...)("SteamLoginNotFound", {})`; `SteamLoginRpcs = RpcGroup.make(Rpc.make("steamLogin.start", { success: Schema.Struct({ attemptId: Schema.String }) }), Rpc.make("steamLogin.status", { payload: Schema.Struct({ attemptId: Schema.String }), success: SteamLoginView, error: SteamLoginNotFound })).middleware(AuthMiddleware)`; `steamLoginReasons = { otherSteamLinked: "Сначала отвяжите текущий Steam", steamTaken: "Этот Steam уже привязан к другому аккаунту", interrupted: "Вход прервался, покажите новый код", steamError: "Steam не ответил, попробуйте ещё раз" } as const`.
  - `packages/rpc/src/agent.ts`: `SteamLoginSeed = Schema.Struct({ accountName: Schema.Redacted(Schema.String), steamId: Schema.String, refreshToken: Schema.Redacted(Schema.String) })`; `StartSession` и `InstallGame` получают `steamLogin: Schema.NullOr(SteamLoginSeed)`; `InstallGame` — ещё `steamLoginTimeoutSeconds: Schema.Int`; `ProfileCommit` — `steamLoginSeeded: Schema.Boolean`; `steamLoginRequiredReason = "Войдите в Steam"`.
  - `SessionSettings.steamLoginTimeoutSeconds` (30–600), `defaultSessionSettings.steamLoginTimeoutSeconds = 90`.

- [ ] **Step 1: Тесты**
  - `gamestore.test.ts` → `"steam_logins allows one active attempt per user"`: вставка второй строки `waiting` того же пользователя падает с нарушением `steam_logins_active_user_idx`; после `update state='cancelled'` первой — вставка проходит; строки `done`/`failed` того же пользователя не мешают.
  - `steamLogin.test.ts` → `"SteamLoginView rejects internal states"`: `Schema.decodeUnknownSync(SteamLoginView)({ …, status: "pending" })` бросает; `"waiting"` с `qrUrl: null` декодируется.
  - `agent.test.ts` → `"InstallGame carries a redacted Steam login"`: декод JSON `{ _tag: "InstallGame", …, steamLogin: { accountName: "acc", steamId: "7656…", refreshToken: "tok" }, steamLoginTimeoutSeconds: 90 }` даёт `Redacted`, `String(decoded.steamLogin.refreshToken)` не содержит `"tok"`; кодирование обратно даёт исходный JSON (токен уходит агенту по WebSocket).
  - `agent.test.ts` → `"ProfileCommit requires steamLoginSeeded"`.
  - `settingsForm.test.tsx` → `"settings form rejects steam login timeout 29"` (по образцу `rejects install timeout 9`).
- [ ] **Step 2:** `bun test` в `packages/db`, `packages/rpc`, `apps/web` — новые тесты падают.
- [ ] **Step 3:** Реализовать схемы и таблицу, сгенерировать миграцию, поправить места сборки команд/коммитов и форму (подпись поля: «Ожидание входа в Steam установщиком, с»).
- [ ] **Step 4:** `bun run check && bun run test` в корне — зелёно.
- [ ] **Step 5:** Commit `feat(rpc,db): Steam QR login contracts`.

---

### Task 2: Агент — VDF и сборка файлов входа (чистые функции)

**Files:**
- Create: `apps/agent/src/steam/vdf.ts` (перенести `tokenize` из `Installer.ts`; `parseAppManifest` остаётся в `Installer.ts` и импортирует `tokenize`)
- Create: `apps/agent/src/steam/loginSeed.ts`
- Modify: `apps/agent/src/profile/codec.ts` (`filesTar`)
- Test: `apps/agent/test/vdf.test.ts`, `apps/agent/test/loginSeed.test.ts`, `apps/agent/test/profileCodec.test.ts`

**Interfaces:**
- Consumes: `SteamLoginSeed` (Task 1).
- Produces:
  - `type VdfNode = { readonly key: string; readonly value: string | ReadonlyArray<VdfNode> }`; `parseVdf(text: string): ReadonlyArray<VdfNode> | undefined`; `formatVdf(nodes: ReadonlyArray<VdfNode>): string` (табы, `"key"\t\t"value"`, как пишет Steam); `getPath(nodes, path: ReadonlyArray<string>)` / `setPath(nodes, path, value)` — регистронезависимый поиск ключей (Steam пишет `valve`/`Valve`), при записи сохраняется существующее написание ключа, недостающие — создаются.
  - `connectCacheKey(accountName: string): string`; `encryptConnectCache(accountName: string, token: string, iv?: Uint8Array): string`; `decryptConnectCache(accountName: string, hex: string): string` (только для тестов и проверки).
  - `LOGIN_FILES = { localVdf: ".local/share/Steam/local.vdf", loginUsers: ".local/share/Steam/config/loginusers.vdf", config: ".local/share/Steam/config/config.vdf", registry: ".steam/registry.vdf" } as const` (относительно `/home/ubuntu`).
  - `applyLoginSeed(current: Partial<Record<keyof typeof LOGIN_FILES, string>>, seed: { accountName: string; steamId: string; token: string }, now: number): Record<keyof typeof LOGIN_FILES, string>` — правила:
    - `local.vdf`: `MachineUserConfigStore/Software/Valve/Steam/ConnectCache/<connectCacheKey>` = зашифрованный токен; остальное содержимое файла сохраняется.
    - `loginusers.vdf`: блок `users/<steamId>` = `AccountName`, `PersonaName` (сохранить прежний, если был, иначе `accountName`), `RememberPassword "1"`, `WantsOfflineMode "0"`, `SkipOfflineModeWarning "0"`, `AutoLogin "1"`, `MostRecent "1"`, `timestamp <now>`; у остальных пользователей `MostRecent "0"`, `AutoLogin "0"`.
    - `config.vdf`: `InstallConfigStore/Software/Valve/Steam/Accounts/<accountName>/SteamID = <steamId>`, остальное сохраняется.
    - `registry.vdf`: `Registry/HKCU/Software/Valve/Steam/AutoLoginUser = <accountName>`, `RememberPassword = "1"`.
    - Файла нет или он не парсится — создаётся с нуля (для нечитаемого — без исключения; агент логирует предупреждение в Task 3).
  - `filesTar(entries: ReadonlyArray<{ path: string; data?: Uint8Array; mode: number }>, options: { uid: number; gid: number; mtime: number }): Uint8Array` — ustar; запись без `data` — каталог (typeflag `'5'`); пути до 100 байт ASCII.

- [ ] **Step 1: Тесты**
  - `loginSeed.test.ts` → `"connectCacheKey drops leading zeros"`: для имени, у которого CRC-32 начинается с нуля (подобрать в тесте перебором коротких строк, где `zlib.crc32(name) < 0x10000000`), ключ = `zlib.crc32(name).toString(16) + "1"` и его длина 8, а не 9.
  - `"encryptConnectCache round-trips"`: `decryptConnectCache(a, encryptConnectCache(a, t)) === t`; длина hex при токене из 498 символов = `(16 + 512) * 2`; два вызова с разным IV дают разный hex.
  - `"applyLoginSeed builds all four files from nothing"`: на `{}` — каждый файл парсится `parseVdf`, значения по путям из правил.
  - `"applyLoginSeed switches autologin to the new account and keeps others"`: на входе `loginusers.vdf` с другим пользователем (`MostRecent "1"`, `AutoLogin "1"`) и `local.vdf` с чужой записью ConnectCache и ключами `valve`/`steam` строчными — чужая запись на месте, у чужого пользователя `MostRecent "0"`, `AutoLogin "0"`, новый — `"1"`; `registry.vdf` `AutoLoginUser` = новый.
  - `"applyLoginSeed replaces the token of the same account"`: повторный вызов с другим токеном — запись ConnectCache одна, расшифровывается в новый токен.
  - `vdf.test.ts` → `"formatVdf(parseVdf(x)) keeps structure"` на фикстуре `config.vdf` с вложенными блоками и `"parseVdf rejects garbage"` → `undefined`.
  - `profileCodec.test.ts` → `"filesTar writes directories and files"`: `tar -tvf` (через `Bun.spawn`) на результате показывает каталог `a/` и файл `a/b` с uid 1000.
- [ ] **Step 2:** `bun test apps/agent/test/loginSeed.test.ts apps/agent/test/vdf.test.ts apps/agent/test/profileCodec.test.ts` — падают.
- [ ] **Step 3:** Реализовать (`node:crypto` `createCipheriv("aes-256-ecb")` с `setAutoPadding(false)` для IV и `aes-256-cbc` для тела; CRC — `zlib.crc32` из `node:zlib`, проверить, что Bun его даёт, иначе таблица).
- [ ] **Step 4:** Тесты агента зелёные, `bun run check` чистый.
- [ ] **Step 5:** Commit `feat(agent): Steam login seed files (ConnectCache, loginusers, config, registry)`.

---

### Task 3: Агент — вход в контейнере сессии и установщика, ожидание входа

**Files:**
- Create: `apps/agent/src/steam/seedContainer.ts`
- Modify: `apps/agent/src/SessionSupervisor.ts` (`launch`), `apps/agent/src/Installer.ts` (`download`, `finish`, причины), `apps/agent/src/profile/HomeProfile.ts` (`saveProfile`), `apps/agent/src/OrchestratorLink.ts` (лог команды — без изменений, только проверить тестом)
- Test: `apps/agent/test/supervisor.test.ts`, `apps/agent/test/installer.test.ts`, `apps/agent/test/link.test.ts`, фикстуры `apps/agent/test/fixtures/steam-logs/*.txt` (строки из спеки §5.4)

**Interfaces:**
- Consumes: `applyLoginSeed`, `LOGIN_FILES`, `filesTar` (Task 2); `SteamLoginSeed`, `steamLoginTimeoutSeconds` (Task 1); `DockerClient.getArchive/putArchive/exec`, `extractSingleFile`.
- Produces:
  - `seedSteamLogin(options: { container: string; seed: SteamLoginSeed }): Effect<void, SeedError, DockerClient>` — для созданного (не запущенного) контейнера: читает четыре файла `getArchive` (нет файла — пропуск; `extractSingleFile`), `applyLoginSeed`, один `putArchive` в `/home/ubuntu` с записями каталогов-родителей (`.local`, `.local/share`, `.local/share/Steam`, `.local/share/Steam/config`, `.steam`, mode 0o700 для каталогов, 0o600 для файлов, uid/gid 1000). `class SeedError extends Data.TaggedError("SeedError")<{ message: string }>`; токен и имя аккаунта в `message` не попадают.
  - `SessionSupervisor.launch`: после `restoreProfile`, если `command.steamLogin !== null` — `seedSteamLogin`; ошибка → `Abort` с `failReasons.profileRestore`. Сессия помнит `seeded: boolean` и передаёт его в `saveProfile`.
  - `saveProfile(options: { …; steamLoginSeeded: boolean })` → `ProfileCommit.steamLoginSeeded`.
  - `Installer.download`: `from === "empty" && command.steamLogin === null` → `Abort(steamLogin)` как сейчас; с входом — `seedSteamLogin`, затем старт. Перед `docker.start` — `logOffset = archiveSize(container, connection_log)` (нет файла → 0). После старта — `waitForSteamLogon(job, offset, timeoutSeconds)`: раз в `INSTALL_POLL` `exec ["tail","-c",`+${offset + 1}`, path]`; найдено `RecvMsgClientLogOnResponse()` с `'OK'` — дальше `watch`; истекло — `Abort({ reason: installReasons.steamLogin })` и, если вход был вписан в этот раз, `Effect.logWarning("Seeded Steam login was not accepted", { jobId, userId })`.
  - `Installer.finish` → `saveProfile({ …, steamLoginSeeded: job.seeded })`.

- [ ] **Step 1: Тесты** (фейковый `DockerClient` из `test/fakes.ts`)
  - `installer.test.ts` → `"installer with empty profile and a Steam login seeds and starts"`: `putArchive` в `/home/ubuntu` получил tar с `.local/share/Steam/local.vdf`; контейнер стартовал; причина `steamLogin` не отправлена.
  - `"installer fails with steamLogin when Steam does not log on in time"`: `connection_log.txt` содержит только строки `WaitingForCredentials`/`'Try another CM' / 'Failure'` → через `steamLoginTimeoutSeconds` (TestClock) `InstallFailed { reason: "Войдите в Steam" }`, контейнер и слои убраны.
  - `"installer ignores Logged On lines written before start"`: до старта в логе (смещение) уже есть `RecvMsgClientLogOnResponse() : [U:1:1] 'OK'`, после — нет → `InstallFailed` «Войдите в Steam».
  - `"installer proceeds after logon and commits steamLoginSeeded"`: лог после смещения получает строку `'OK'` → идёт `watch`, по завершении `ProfileCommit.steamLoginSeeded === true`.
  - `supervisor.test.ts` → `"session seeds the Steam login before start"` и `"session without a Steam login does not touch login files"`; коммит при остановке — `steamLoginSeeded` соответственно `true`/`false`.
  - `link.test.ts` → `"command log never contains the Steam token"`: прогнать `InstallGame` с токеном `"SECRET-TOKEN"` через ссылку с перехватом логгера (`Logger.replace`) — ни одна строка не содержит `SECRET-TOKEN` и имени аккаунта.
- [ ] **Step 2:** Тесты падают.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** `bun test` в `apps/agent` и `bun run check` — зелёно.
- [ ] **Step 5:** Commit `feat(agent): seed Steam login into containers, installer waits for logon`.

---

### Task 4: Оркестратор — хранилище входов и вложение в команды

**Files:**
- Create: `apps/orchestrator/src/SteamLoginSeeds.ts`
- Modify: `apps/orchestrator/src/Scheduler.ts` (`StartSession`), `apps/orchestrator/src/InstallDispatcher.ts` (`InstallGame`, таймаут входа из настроек), `apps/orchestrator/src/http.ts` (`agent.profileCommit`), `apps/orchestrator/src/main.ts` (слой)
- Test: `apps/orchestrator/test/steamLoginSeeds.test.ts`, `apps/orchestrator/test/install.test.ts`, `apps/orchestrator/test/runner.test.ts` или `lifecycle.test.ts` (там, где проверяется `StartSession`), `apps/orchestrator/test/profile.test.ts`

**Interfaces:**
- Consumes: `SteamLoginSeed`, `ProfileCommit.steamLoginSeeded`, `SessionSettings.steamLoginTimeoutSeconds` (Task 1).
- Produces:
  - `class SteamLoginSeeds extends Context.Service<SteamLoginSeeds, { put(userId: string, seed: SteamLoginSeed): Effect<void>; get(userId: string): Effect<SteamLoginSeed | null>; clear(userId: string): Effect<void> }>()` и `SteamLoginSeeds.layer` — память процесса, `SEED_TTL = Duration.hours(24)` по `Clock` (истёкший — `get` даёт `null` и удаляет).
  - Scheduler: `StartSession.steamLogin = yield* seeds.get(session.userId)`; InstallDispatcher: `InstallGame.steamLogin = yield* seeds.get(job.userId)`, `steamLoginTimeoutSeconds` из настроек сессий.
  - `agent.profileCommit`: принятый коммит с `steamLoginSeeded: true` → `seeds.clear(commit.userId)`; отклонённый или с `false` — вход остаётся.

- [ ] **Step 1: Тесты**
  - `steamLoginSeeds.test.ts` → `"seed expires after 24 hours"` (TestClock: 23 ч — есть, 24 ч 1 с — `null`); `"put replaces the previous seed"`.
  - `install.test.ts` → `"InstallGame carries the user's pending Steam login and timeout"`: после `put(userA, seed)` выданная команда для задачи A содержит этот вход и `steamLoginTimeoutSeconds` из настроек (в тесте — 120); для пользователя B — `steamLogin: null`.
  - тест старта сессии → `"StartSession carries the pending Steam login"`.
  - `profile.test.ts` → `"accepted seeded commit clears the pending login"`, `"rejected or unseeded commit keeps it"`.
- [ ] **Step 2:** Тесты падают.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** `bun test` в `apps/orchestrator`, `bun run check` — зелёно.
- [ ] **Step 5:** Commit `feat(orchestrator): pending Steam logins attached to the user's next container`.

---

### Task 5: Оркестратор — QR-попытки и привязка Steam

**Files:**
- Modify: `apps/orchestrator/package.json` (`steam-session@1.9.4`), `bun.lock`
- Create: `apps/orchestrator/src/SteamLoginRunner.ts`, `apps/orchestrator/src/SteamLoginRepo.ts`
- Modify: `apps/orchestrator/src/main.ts`
- Test: `apps/orchestrator/test/steamLogin.test.ts`

**Interfaces:**
- Consumes: `steamLogins`, `steamLoginStates`, `steamLoginReasons` (Task 1); `SteamLoginSeeds.put` (Task 4); таблицы `user`, `account`.
- Produces:
  - Порт к Steam, чтобы тесты шли без сети: `interface QrLogin { readonly start: Effect<{ qrUrl: string }, SteamQrError>; readonly events: Stream<QrEvent, SteamQrError>; readonly cancel: Effect<void> }`, `type QrEvent = { _tag: "QrUrl"; url: string } | { _tag: "Scanned" } | { _tag: "Authenticated"; accountName: Redacted<string>; steamId: string; refreshToken: Redacted<string> } | { _tag: "Timeout" }`; `class SteamQr extends Context.Service<SteamQr, { begin: Effect<QrLogin, SteamQrError, Scope> }>()`; `SteamQr.live` — на `steam-session` (`LoginSession(SteamClient, { machineFriendlyName: "GameCrate" })`, `loginTimeout = 5 мин`, новый URL — из события `debug` `"poll response"` → `newChallengeUrl`, как в пробе; `remoteInteraction` → `Scanned`; `authenticated` → `Authenticated`; `timeout` → `Timeout`; `error` → `SteamQrError` без сообщения Steam в тексте для игрока).
  - `SteamLoginRepo`: `pending()`, `setWaiting(id, qrUrl)`, `setQrUrl(id, qrUrl)`, `setScanned(id)`, `finish(id, state: "done" | "expired" | "failed", error: string | null)`, `isCancelled(id)`, `failStale()` (все `pending/waiting/scanned` при старте → `failed`, `interrupted`), `linkSteam(userId, steamId): Effect<"linked" | "otherSteamLinked" | "steamTaken">` — одна транзакция: `user.steam_id` текущего = `steamId` → `linked` (ничего не пишет); другой не-null → `otherSteamLinked`; `steamId` у другого пользователя → `steamTaken`; иначе `insert account { id: randomUUID(), accountId: steamId, providerId: "steam", userId, createdAt, updatedAt }` + `update user set steam_id`.
  - `SteamLoginRunner.layer`: при старте `failStale`; цикл `STEAM_LOGIN_INTERVAL = "1 second"` подхватывает `pending`-строки (не больше `MAX_ACTIVE = 20` одновременно, на каждую — свой fiber в scope слоя); fiber: `begin` → `setWaiting` → события: `QrUrl` → `setQrUrl`; `Scanned` → `setScanned`; `Authenticated` → `linkSteam` → `linked`: `seeds.put(userId, seed)` + `finish(done)`, иначе `finish(failed, otherSteamLinked|steamTaken)`; `Timeout` → `finish(expired)`; ошибка → `finish(failed, steamError)`; раз в интервал `isCancelled` → `cancel` и выход без записи.

- [ ] **Step 1: Проверить `steam-session` под Bun.** Временный скрипт в `/tmp` (не в репозитории): `bun -e` с `require("steam-session")`, `startWithQR()` → вывести только `typeof qrChallengeUrl === "string"` и сразу `cancelLoginAttempt()`. Ожидается `true`. Если не работает под Bun — остановиться и сообщить контроллеру (спека §8: тогда решение — отдельный Node-процесс).
- [ ] **Step 2: Тесты** (фейковый `SteamQr`, настоящая тестовая БД как в других тестах оркестратора)
  - `"attempt goes waiting → scanned → done and links Steam"`: строка `pending` → `waiting` с `qrUrl`, событие `QrUrl` меняет `qrUrl`, `Scanned` → `scanned`, `Authenticated` → `done`; у пользователя `steam_id` и строка `account` `providerId "steam"`; `seeds.get(userId)` — этот вход.
  - `"same Steam already linked to the user is done without a second account row"`.
  - `"another Steam linked to the user fails with otherSteamLinked"` и `"Steam linked to another user fails with steamTaken"` — `seeds` пусты, `account` не добавлен.
  - `"timeout expires the attempt"`, `"Steam error fails with steamError and no Steam text"`.
  - `"cancelled attempt stops the Steam login"`: строка → `cancelled` извне → у фейка вызван `cancel`, строка остаётся `cancelled`.
  - `"stale attempts fail with interrupted on start"`.
  - `"runner logs never contain the token"` (перехват логгера, как в Task 3).
- [ ] **Step 3:** Тесты падают.
- [ ] **Step 4:** Реализовать.
- [ ] **Step 5:** `bun test` в `apps/orchestrator`, `bun run check` — зелёно.
- [ ] **Step 6:** Commit `feat(orchestrator): Steam QR login attempts and Steam linking`.

---

### Task 6: API — `steamLogin.*`

**Files:**
- Create: `apps/api/src/steamLogin/rpc.ts`, `apps/api/src/steamLogin/SteamLoginRepo.ts`
- Modify: `apps/api/src/http.ts` (или где собираются хендлеры `AppRpcs`)
- Test: `apps/api/test/steamQrLogin.test.ts`

**Interfaces:**
- Consumes: `SteamLoginRpcs`, `SteamLoginView`, `SteamLoginNotFound`, `steamLogins` (Task 1).
- Produces:
  - `steamLogin.start`: в транзакции активные (`pending/waiting/scanned`) попытки пользователя → `cancelled`, вставка `pending` с `id = randomUUID()`; ответ `{ attemptId }`.
  - `steamLogin.status({ attemptId })`: только своя попытка, иначе `SteamLoginNotFound`; отображение `pending → waiting (qrUrl null)`, `cancelled → expired`, остальные как есть; `reason` = `error` строки (для `expired` — `null`).

- [ ] **Step 1: Тесты**
  - `"start cancels the previous active attempt"`: два `start` → первая строка `cancelled`, вторая `pending`; `status` первой → `expired`.
  - `"status of another user's attempt is SteamLoginNotFound"`.
  - `"pending maps to waiting without qrUrl"`, `"failed carries the reason"`.
  - `"steamLogin RPCs require a session"` → `Unauthorized`.
- [ ] **Step 2:** Тесты падают.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** `bun test` в `apps/api`, `bun run check` — зелёно.
- [ ] **Step 5:** Commit `feat(api): steamLogin.start / steamLogin.status`.

---

### Task 7: Сайт — экран QR в библиотеке, профиле и на экране сессии

**Files:**
- Modify: `apps/web/package.json` (`qrcode@1.5.4`, `@types/qrcode`), `bun.lock`
- Create: `apps/web/src/components/SteamQrLogin.tsx`
- Modify: `apps/web/src/rpc.ts` (атомы), `apps/web/src/routes/library.tsx` (`ConnectSteam`), `apps/web/src/routes/profile.tsx` (`handleLink` для Steam), `apps/web/src/components/profile/LoginMethods.tsx` (подпись «Подключить» для Steam), `apps/web/src/components/SessionStatus.tsx` и `apps/web/src/components/Player.tsx` / `apps/web/src/routes/session.$id.tsx` (повтор «Играть»), `apps/web/src/components/landing/HowItWorks.tsx` (сверить текст)
- Test: `apps/web/test/steamQrLogin.test.tsx` (новый), `apps/web/test/library.test.tsx`, `apps/web/test/profile.test.tsx`, `apps/web/test/session.test.tsx`

**Interfaces:**
- Consumes: `steamLogin.start/status`, `SteamLoginView`, `steamLoginRequiredReason` (Task 1); `startSessionAtom`, `refreshLibraryAtom`, `meAtom`.
- Produces:
  - `SteamQrLogin({ title, onDone }: { title: string; onDone: () => void })`: при монтировании `steamLogin.start`, опрос `steamLogin.status` раз в 1 с, пока статус не терминальный; QR рисуется `QRCode.toString(qrUrl, { type: "svg" })` (или canvas); подсказка и строки состояния — тексты из Global Constraints; `expired`/`failed` → `reason ?? "Время вышло"` + кнопка «Показать новый код» (новый `start`); `done` → «Готово», затем `onDone()`.
  - `/library`: `ConnectSteam` — заголовок «Подключите Steam», кнопка «Подключить Steam» открывает `SteamQrLogin` (заголовок «Подключите Steam»); `onDone` → обновить `meAtom`, выполнить `library.refresh`.
  - `/profile`: `handleLink("steam")` открывает тот же экран (диалог), `onDone` → обновить список и `meAtom`. OpenID-вызов `linkSteam` из интерфейса убрать (функция и плагин на сервере остаются).
  - `SessionStatus` (`failed`, `view.failReason === steamLoginRequiredReason`, игра не шла): вместо «Не удалось запустить игру» — `SteamQrLogin` с заголовком «Войдите в Steam ещё раз»; новый проп `onPlayAgain: () => void` → `startSession(view.appId)` и переход на новую сессию.

- [ ] **Step 1: Тесты** (фейковый RPC-клиент, как в существующих тестах сайта)
  - `steamQrLogin.test.tsx` → `"shows QR and statuses"`: `waiting` с `qrUrl` → есть `svg` и «Ждём сканирования»; `scanned` → «Подтвердите вход в приложении Steam»; `done` → «Готово» и вызван `onDone`.
  - `"expired offers a new code"`: «Время вышло», клик «Показать новый код» → второй `steamLogin.start`.
  - `"failed shows the reason"`: `reason: "Сначала отвяжите текущий Steam"` на экране.
  - `library.test.tsx` → `"connect steam opens the QR login"` (кнопка «Подключить Steam», нет вызова `linkSteam`).
  - `profile.test.tsx` → `"steam link opens the QR login"`.
  - `session.test.tsx` → `"steam login failure shows QR and plays again after done"`: `failed` с `failReason: "Войдите в Steam"` → «Войдите в Steam ещё раз»; после `done` вызван `session.start` с `appId` сессии.
- [ ] **Step 2:** Тесты падают.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** `bun test` в `apps/web`, `bun run check`, `bun run lint` — зелёно.
- [ ] **Step 5:** Commit `feat(web): Steam QR login in library, profile and session screen`.

---

### Task 8: Деплой, документация, приёмка

**Files:**
- Modify: `deploy/README.md` (раздел «Вход в Steam по QR»: как работает; после `build-steam-client.sh` вручную пройти QR на тестовом аккаунте и установить игру; признак поломки — предупреждение агента `Seeded Steam login was not accepted`; отзыв — Steam → Steam Guard → «Устройства» → «GameCrate»), `docs/backlog.md` (ничего не убирать; проверить, что пункт об этапах на месте)
- Modify: `docs/superpowers/specs/2026-10-23-steam-qr-login-design.md` (статус «реализовано», отклонения реализации, если были)

- [ ] **Step 1:** `bun run check && bun run lint && bun run test --force` в корне — зелёно.
- [ ] **Step 2:** README и спека; commit `docs: Steam QR login deploy notes`.
- [ ] **Step 3:** Деплой на brofrong (`deploy/deploy.sh`), предварительно убедившись, что нет контейнеров с метками `cg.session`/`cg.install`; после — `cg-api`, `cg-orchestrator`, `cg-agent` healthy, миграция `steam_logins` применена, в логах оркестратора нет ошибок `SteamLoginRunner`.
- [ ] **Step 4: Приёмка владельцем** (ведёт контроллер):
  1. Новый пользователь сайта со своим Steam → «Подключить Steam» → QR → «Готово» → библиотека загрузилась.
  2. «Играть» на игре, которой нет в общей библиотеке → установка с его аккаунта → игра без окна входа Steam.
  3. Выход → в RustFS новая версия профиля; повторный запуск — без QR.
  4. Отзыв устройства «GameCrate» в Steam → установка другой игры → экран «Войдите в Steam ещё раз» → QR → игра ставится.
  5. Логи `cg-api`, `cg-orchestrator`, `cg-agent` за время приёмки не содержат токена (поиск по началу JWT `eyJ`).
