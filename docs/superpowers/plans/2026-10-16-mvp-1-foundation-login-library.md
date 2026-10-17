# MVP-1: фундамент, вход через Steam, библиотека — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь открывает https://game.brofrong.ru, входит через Steam и видит свою библиотеку с оценкой ProtonDB; админ входит через Pocket ID и попадает на (пока пустую) админку.

**Architecture:** Монорепа Bun + Turborepo. Один процесс `apps/api` (Effect 4 HTTP-сервер на Bun) отдаёт Better Auth (`/api/auth/*`), Effect RPC по WebSocket (`/rpc`) и собранную SPA `apps/web`. Данные — PostgreSQL через Drizzle 1.0 RC (Effect-драйвер для кода приложения, обычный драйвер для Better Auth). Развёртывание — свой docker compose-проект на `brofrong` за существующим Caddy (ingressi).

**Tech Stack:** Bun 1.4 (`bun test`, `bun check`, `bun lint`, `bun fmt`), Turborepo 2.11, effect 4.0.5 (`effect/rpc`, `effect/http`, `effect/sql`), @effect/platform-bun 4.0.5, @effect/sql-pg 4.0.5, drizzle-orm/drizzle-kit 1.0.0-rc.4, better-auth 1.7.10 + better-auth-steam 0.2.3, React 19.3, @tanstack/react-router 1.170, @effect/atom-react 4.0.5, Tailwind 4.3, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-16-cloud-gaming-mvp-design.md`

**Место в MVP.** Спека разбита на четыре плана, каждый даёт работающий результат:
1. **Этот план** — фундамент, вход, библиотека, деплой.
2. Сессии — образ сессии (из `spike/`), агент воркера, оркестратор, прокси сигналинга, плеер, учёт времени, простой/отключение, настройки.
3. Хранилище и профили — RustFS-профили, ожидание облака Steam, overlayfs над gamestore по NFS, installer с прогрессом.
4. Админка и планировщик — воркеры по токену, живые сессии и ресурсы, стоимость игр, адаптивный битрейт и индикатор сети.

## Global Constraints

- Версии пинуются точно: `effect`, `@effect/platform-bun`, `@effect/platform-browser`, `@effect/sql-pg`, `@effect/atom-react` = `4.0.5`; `drizzle-orm`, `drizzle-kit` = `1.0.0-rc.4`; `better-auth` = `1.7.10`; `better-auth-steam` = `0.2.3`.
- Инструменты только Bun: `bun test`, `bun check` (типы), `bun lint`, `bun fmt`. Turbo-задачи: `check`, `lint`, `test`, `build`.
- Язык интерфейса — русский.
- Секреты только в `.env` (в `.gitignore`), никогда в коде, плане, логах: `STEAM_API_KEY`, `BETTER_AUTH_SECRET`, `POCKET_ID_CLIENT_SECRET`, `DATABASE_URL`.
- Публичный адрес: `https://game.brofrong.ru` (`PUBLIC_URL`). Pocket ID: `https://sso.brofrong.ru` (`POCKET_ID_URL`). Группа админов: `cloud_gaming_admins` (`POCKET_ID_ADMIN_GROUP`).
- На `brofrong`: compose-проект `cloud-gaming`, свой Postgres (`postgres:18`), подключение к внешней сети `proxy`. Чужие контейнеры, хост и перезагрузки не трогать.
- Ничего, специфичного для машины, в коде: адреса, порты, пути — из конфигурации (`effect` `Config`).
- Пароли Steam не видим и не храним; вход только через Steam OpenID.

## Review Focus

1. **Приватный профиль Steam** (`GetOwnedGames` отвечает `{"response":{}}`) — пользователь видит экран «Откройте „Сведения об играх“» с инструкцией, а не пустую библиотеку и не ошибку. Тест: Task 5 `syncLibrary returns LibraryPrivate for empty response`, Task 6 `library renders private profile screen`.
2. **ProtonDB не знает игру (404) или недоступен** — библиотека всё равно загружается, плашка «Нет данных». Тест: Task 4 `fetchTier maps 404 to pending`, `fetchTier maps network error to pending`.
3. **Steam недоступен или ключ неверный (403/5xx)** — `library.refresh` возвращает типизированную `SteamUnavailable`, а `library.list` продолжает отдавать закэшированную библиотеку. Тест: Task 5 `refresh failure keeps cached library`.
4. **Большая библиотека (1500+ игр)** — синхронизация пачками, запросы к ProtonDB с ограничением параллельности и не блокируют ответ. Тест: Task 5 `syncLibrary upserts 1500 games`.
5. **Не-админ лезет в админку** (Steam-пользователь или пользователь Pocket ID вне группы) — RPC `admin.*` отвечает `Forbidden`, страница `/admin` показывает «Нет доступа». Тест: Task 3 `admin rpc rejects player`, `pocket id user without group gets role player`.

---

## Файловая структура

```
package.json, turbo.json, tsconfig.base.json, .gitignore, .env.example, bunfig.toml
packages/db/        drizzle.config.ts, src/schema/{auth,library}.ts, src/schema/index.ts,
                    src/Db.ts (Effect-слой БД), src/migrate.ts, migrations/, test/testDb.ts
packages/rpc/       src/{auth,library,admin}.ts (RpcGroup + схемы), src/index.ts
apps/api/           src/main.ts, src/config.ts, src/http.ts (роутер), src/auth/{auth,currentUser}.ts,
                    src/steam/{SteamApi,ProtonDb,tiers}.ts, src/library/{LibraryRepo,LibraryService,rpc}.ts,
                    src/admin/rpc.ts, test/**
apps/web/           src/index.html, src/main.tsx, src/rpc.ts, src/auth.ts, src/routes/**, src/components/**,
                    build.ts, dev.ts
deploy/             compose.yaml, compose.dev.yaml, Dockerfile, deploy.sh
spike/              (уже есть, остаётся как справочник; spike/.env в .gitignore)
```

---

### Task 1: Монорепа и инструменты

**Files:**
- Create: `package.json`, `turbo.json`, `tsconfig.base.json`, `bunfig.toml`, `.gitignore`, `.env.example`, `packages/*/package.json`, `apps/*/package.json` (пустые пакеты `@cg/db`, `@cg/rpc`, `@cg/api`, `@cg/web`)
- Test: `packages/rpc/test/smoke.test.ts`

**Interfaces:**
- Produces: имена пакетов `@cg/db`, `@cg/rpc`, `@cg/api`, `@cg/web`; turbo-задачи `check`, `lint`, `test`, `build`, `dev`.

- [ ] **Step 1:** `git init`; `.gitignore`: `node_modules`, `dist`, `.env`, `spike/.env`, `.turbo`, `*.tgz`, `spike/nv/`.
- [ ] **Step 2:** Корневой `package.json`: `"private": true`, `"workspaces": ["apps/*", "packages/*"]`, `"packageManager": "bun@1.4.4"`, скрипты `check|lint|test|build|dev` → `turbo run <task>`, `fmt` → `bun fmt`. `turbo.json`: `build` с `dependsOn: ["^build"]`, `outputs: ["dist/**"]`; `test`, `check`, `lint` без кэша вывода; `dev` — `persistent`, `cache: false`.
- [ ] **Step 3:** `tsconfig.base.json`: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `moduleResolution: "bundler"`, `jsx: "react-jsx"`, `types: ["bun"]`. Каждый пакет: `tsconfig.json` extends base, скрипты `check: "bun check"`, `lint: "bun lint src"`, `test: "bun test"`.
- [ ] **Step 4:** `.env.example` со всеми переменными из Global Constraints и `PORT=3000` (значения-заглушки).
- [ ] **Step 5: тест** `packages/rpc/test/smoke.test.ts`: `test("workspace runs", () => expect(1 + 1).toBe(2))`.
- [ ] **Step 6:** `bun install && bun run test && bun run check && bun run lint` — Expected: всё зелёное.
- [ ] **Step 7:** Commit `chore: monorepo skeleton (bun + turbo)`. В тот же коммит добавить уже существующие `docs/` и `spike/` (без `spike/.env`, `spike/nv/`).

---

### Task 2: База данных

**Files:**
- Create: `packages/db/src/schema/auth.ts`, `packages/db/src/schema/library.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/Db.ts`, `packages/db/src/migrate.ts`, `packages/db/drizzle.config.ts`, `packages/db/test/testDb.ts`, `deploy/compose.dev.yaml`
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces:
  - Таблицы Better Auth `user`, `session`, `account`, `verification` (поля — как требует Better Auth 1.7 + плагин Steam). Дополнительно в `user`: `steamId text unique null` (плагин), `role text not null default 'player'` (`'player' | 'admin'`).
  - `games`: `appId integer pk`, `name text`, `protonTier text not null default 'pending'`, `protonCheckedAt timestamptz null`, `updatedAt timestamptz`.
  - `userGames`: `userId text fk user.id on delete cascade`, `appId integer fk games.appId`, `playtimeMinutes integer not null default 0`, `syncedAt timestamptz`; pk `(userId, appId)`.
  - `user.librarySyncedAt timestamptz null`, `user.libraryPrivate boolean not null default false`.
  - Effect-сервис `Db` — Drizzle Effect-БД (`drizzle-orm/effect-postgres`) поверх `@effect/sql-pg`; `Db.layer: Layer<Db, ConfigError | SqlError, never>` из `DATABASE_URL`.
  - `runMigrations: Effect<void, MigrationError, Db>` (`drizzle-orm/effect-postgres/migrator`, папка `packages/db/migrations`).
  - `testDb.ts`: `DbTest: Layer<Db>` — создаёт временную БД `cg_test_<random>` на `TEST_DATABASE_URL`, прогоняет миграции, удаляет БД при закрытии scope.

- [ ] **Step 1:** `deploy/compose.dev.yaml`: сервис `postgres` (`postgres:18`, порт `127.0.0.1:5433:5432`, пароль из `.env`). Добавить в `.env.example` `TEST_DATABASE_URL=postgres://cg:cg@127.0.0.1:5433/postgres`.
- [ ] **Step 2: тест** `schema.test.ts`:
  ```ts
  it("inserts user with default role player", () => run(Effect.gen(function* () {
    const db = yield* Db
    yield* db.insert(user).values({ id: "u1", name: "n", email: "u1@steam.invalid", emailVerified: false })
    const [row] = yield* db.select().from(user)
    expect(row.role).toBe("player"); expect(row.libraryPrivate).toBe(false)
  })))
  it("userGames cascade on user delete", ...) // вставить user+game+userGame, удалить user → userGames пусто
  ```
  `run` = `Effect.runPromise(Effect.scoped(eff.pipe(Effect.provide(DbTest))))`.
- [ ] **Step 3:** `docker compose -f deploy/compose.dev.yaml up -d && bun test packages/db` — Expected: FAIL (нет схемы).
- [ ] **Step 4:** Написать схему, `Db`, `migrate.ts`, `drizzle.config.ts`; `bunx drizzle-kit generate` → `packages/db/migrations/0000_*.sql`.
- [ ] **Step 5:** `bun test packages/db` — Expected: PASS.
- [ ] **Step 6:** Commit `feat(db): schema for auth and library`.

---

### Task 3: Сервер API, авторизация, роли

**Files:**
- Create: `apps/api/src/config.ts`, `apps/api/src/main.ts`, `apps/api/src/http.ts`, `apps/api/src/auth/auth.ts`, `apps/api/src/auth/currentUser.ts`, `apps/api/src/admin/rpc.ts`, `packages/rpc/src/auth.ts`, `packages/rpc/src/admin.ts`
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `Db`, таблица `user` (Task 2).
- Produces:
  - `AppConfig` (Effect `Config`): `port`, `publicUrl`, `databaseUrl`, `steamApiKey: Redacted`, `authSecret: Redacted`, `pocketIdUrl`, `pocketIdClientId`, `pocketIdClientSecret: Redacted`, `pocketIdAdminGroup`, `webDistDir`.
  - `makeAuth(config): BetterAuth` — Better Auth с drizzle-адаптером (`drizzle-orm/bun-sql` поверх `DATABASE_URL`), плагином `steamOpenID({ apiKey })` и плагином `genericOAuth` с провайдером `pocket-id` (`discoveryUrl: ${POCKET_ID_URL}/.well-known/openid-configuration`, scopes `openid profile email groups`). Роль при входе через Pocket ID: `'admin'`, если `groups` содержит `POCKET_ID_ADMIN_GROUP`, иначе `'player'`; обновляется при каждом входе. Steam-пользователи всегда `'player'`.
  - `pocketIdRole(groups: ReadonlyArray<string> | undefined, adminGroup: string): "admin" | "player"`.
  - Effect-сервис `CurrentUser` → `{ id: string; role: "player" | "admin"; steamId: string | null }`.
  - RPC-мидлвары `AuthMiddleware` (берёт сессию Better Auth по cookie запроса апгрейда WS; нет сессии → `Unauthorized`) и `AdminMiddleware` (роль не `admin` → `Forbidden`). Ошибки `Unauthorized`, `Forbidden` — `Schema.TaggedError` в `packages/rpc/src/auth.ts`.
  - RPC `auth.me` → `{ id, name, image, role, steamId }`; RPC `admin.ping` (с `AdminMiddleware`) → `"pong"`.
  - Роутер `http.ts`: `GET /healthz` → `200 ok`; `/api/auth/*` → `auth.handler`; `/rpc` → Effect RPC по WebSocket (`RpcServer` + `RpcSerialization.layerNdjson`/json); остальное — статика из `webDistDir` с фолбэком на `index.html`.

- [ ] **Step 1: тесты** `auth.test.ts`:
  ```ts
  it("pocket id user without group gets role player", () => {
    expect(pocketIdRole(["users"], "cloud_gaming_admins")).toBe("player")
    expect(pocketIdRole(undefined, "cloud_gaming_admins")).toBe("player")
  })
  it("pocket id user in group gets role admin", () =>
    expect(pocketIdRole(["cloud_gaming_admins"], "cloud_gaming_admins")).toBe("admin"))
  it("admin rpc rejects player", ...)   // RpcTest-клиент с CurrentUser{role:"player"} → admin.ping падает Forbidden
  it("admin rpc accepts admin", ...)    // role:"admin" → "pong"
  it("rpc without session is Unauthorized", ...)
  it("GET /healthz returns 200", ...)   // через HttpRouter тестовый клиент
  ```
- [ ] **Step 2:** `bun test apps/api/test/auth.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Реализовать файлы из списка. `main.ts`: прогнать `runMigrations`, затем `BunHttpServer.layer({ port })`, `BunRuntime.runMain`.
- [ ] **Step 4:** `bun test apps/api` — Expected: PASS.
- [ ] **Step 5:** Ручная проверка локально: `.env` с реальным `STEAM_API_KEY`, `PUBLIC_URL=http://localhost:3000`; `bun run --cwd apps/api dev`; `curl -s localhost:3000/healthz` → `ok`; `POST /api/auth/steam/login` возвращает URL `steamcommunity.com/openid/login`.
- [ ] **Step 6:** Commit `feat(api): server, better-auth (steam + pocket id), rpc auth middleware`.

---

### Task 4: Клиенты Steam Web API и ProtonDB

**Files:**
- Create: `apps/api/src/steam/SteamApi.ts`, `apps/api/src/steam/ProtonDb.ts`, `packages/rpc/src/library.ts` (схема тира и ошибок)
- Test: `apps/api/test/steam.test.ts`, `apps/api/test/protondb.test.ts`

**Interfaces:**
- Produces:
  - `ProtonTier = Schema.Literals(["platinum","gold","silver","bronze","borked","pending"])` в `@cg/rpc`.
  - Effect-сервис `SteamApi`: `getOwnedGames(steamId: string): Effect<OwnedGames, SteamUnavailable>`, где `OwnedGames = { _tag: "Private" } | { _tag: "Games"; games: ReadonlyArray<{ appId: number; name: string; playtimeMinutes: number }> }`. Запрос: `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=…&steamid=…&include_appinfo=1&include_played_free_games=1&format=json`. `response` без поля `games` → `Private` (Steam так отвечает на приватный профиль; `game_count: 0` с пустым `games: []` → `Games` с пустым массивом). Ключ не попадает в логи и ошибки.
  - `SteamUnavailable` — `Schema.TaggedError` с `reason: "unauthorized" | "rate_limited" | "unavailable"` (403 → unauthorized, 429 → rate_limited, прочее/сеть → unavailable).
  - Effect-сервис `ProtonDb`: `fetchTier(appId: number): Effect<ProtonTier>` — никогда не падает: `GET https://www.protondb.com/api/v1/reports/summaries/{appId}.json`, поле `tier`; 404, неизвестное значение, ошибка сети, таймаут 5 с → `"pending"`.
  - Оба — слои поверх `HttpClient` (`effect/http`), тесты подменяют `HttpClient` фейком.

- [ ] **Step 1: тесты**:
  ```ts
  it("getOwnedGames parses games", ...)        // фейк отвечает {response:{game_count:2,games:[{appid:1794680,name:"Vampire Survivors",playtime_forever:125}, …]}} → Games, [0] = {appId:1794680,name:"Vampire Survivors",playtimeMinutes:125}
  it("getOwnedGames returns Private for empty response", ...) // {response:{}} → {_tag:"Private"}
  it("getOwnedGames maps 403 to unauthorized and hides key", ...) // ошибка reason "unauthorized", String(error) не содержит ключ
  it("fetchTier reads tier", ...)               // {tier:"gold",…} → "gold"
  it("fetchTier maps 404 to pending", ...)
  it("fetchTier maps network error to pending", ...)
  it("fetchTier maps unknown tier to pending", ...) // {tier:"native"} → "pending"
  ```
- [ ] **Step 2:** `bun test apps/api/test/steam.test.ts apps/api/test/protondb.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Реализовать `SteamApi.layer`, `ProtonDb.layer`.
- [ ] **Step 4:** Тесты — Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): steam web api and protondb clients`.

---

### Task 5: Синхронизация библиотеки и RPC

**Files:**
- Create: `apps/api/src/library/LibraryRepo.ts`, `apps/api/src/library/LibraryService.ts`, `apps/api/src/library/rpc.ts`, `apps/api/src/steam/tiers.ts`; Modify: `packages/rpc/src/library.ts`, `apps/api/src/http.ts`
- Test: `apps/api/test/library.test.ts`

**Interfaces:**
- Consumes: `Db`, `SteamApi`, `ProtonDb`, `CurrentUser`, `AuthMiddleware`.
- Produces:
  - `LibraryEntry = { appId: number; name: string; playtimeMinutes: number; protonTier: ProtonTier; coverUrl: string }`, `coverUrl = https://cdn.cloudflare.steamstatic.com/steam/apps/{appId}/library_600x900_2x.jpg` (фолбэк на `header.jpg` — на фронте при ошибке загрузки).
  - `LibraryView = { _tag: "Private" } | { _tag: "Ready"; entries: ReadonlyArray<LibraryEntry>; syncedAt: string | null }`.
  - RPC `library.list` → `LibraryView` (только из БД; если `librarySyncedAt` пуст — сначала синхронно `syncLibrary`). RPC `library.refresh` → `LibraryView`, ошибка `SteamUnavailable`.
  - `LibraryService.syncLibrary(userId, steamId): Effect<"Private" | "Synced", SteamUnavailable, Db | SteamApi>` — при `Private` ставит `libraryPrivate=true`, библиотеку не трогает; при `Games` — upsert `games` (имя) и `userGames` пачками по 500 в транзакции, удаляет из `userGames` игры, которых больше нет, ставит `librarySyncedAt=now`, `libraryPrivate=false`.
  - `LibraryService.refreshTiers(appIds): Effect<void, never, Db | ProtonDb>` — только игры с `protonCheckedAt` старше 24 ч или null; параллельность 4; запускается в фоне (`Effect.forkDaemon`) после синхронизации, не задерживает ответ RPC.
  - `tiers.ts`: `tierLabel: Record<ProtonTier, string>` — точный текст: platinum «Работает идеально», gold «Работает после мелких настроек», silver «Работает с недочётами», bronze «Запускается, но играть тяжело», borked «Скорее всего не запустится», pending «Нет данных». (Экспортируется из `@cg/rpc`, использует фронт.)
  - Вызов `syncLibrary` при входе через Steam: хук Better Auth `databaseHooks.session.create.after` для пользователей со `steamId` → фоновый `syncLibrary`.

- [ ] **Step 1: тесты** (`DbTest` + фейковые `SteamApi`/`ProtonDb`):
  ```ts
  it("syncLibrary returns LibraryPrivate for empty response", ...) // SteamApi→Private; library.list → {_tag:"Private"}; user.libraryPrivate=true
  it("syncLibrary upserts 1500 games", ...)     // 1500 игр → count(userGames)=1500, время < 5 с
  it("syncLibrary removes games no longer owned", ...)
  it("refresh failure keeps cached library", ...) // после успешной синхронизации SteamApi падает unavailable → library.refresh = SteamUnavailable, library.list = прежние записи
  it("refreshTiers skips fresh tiers", ...)     // protonCheckedAt = now-1h → fetchTier не вызывался
  it("list sorts by playtime desc then name", ...)
  ```
- [ ] **Step 2:** `bun test apps/api/test/library.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Реализовать репозиторий, сервис, RPC-хендлеры, хук входа; подключить группу `LibraryRpcs` в `http.ts` с `AuthMiddleware`.
- [ ] **Step 4:** `bun test apps/api` — Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): library sync with protondb tiers`.

---

### Task 6: SPA: сборка, вход, библиотека, админка-заглушка

**Files:**
- Create: `apps/web/build.ts`, `apps/web/dev.ts`, `apps/web/src/index.html`, `apps/web/src/main.tsx`, `apps/web/src/styles.css`, `apps/web/src/auth.ts`, `apps/web/src/rpc.ts`, `apps/web/src/routes/{__root,index,library,admin}.tsx`, `apps/web/src/components/{GameCard,ProtonBadge,PrivateProfile}.tsx`, `apps/web/components.json` (shadcn)
- Test: `apps/web/test/ProtonBadge.test.tsx`, `apps/web/test/library.test.tsx`

**Interfaces:**
- Consumes: RPC `auth.me`, `library.list`, `library.refresh`, `admin.ping`; `tierLabel`, `LibraryView` из `@cg/rpc`; клиенты Better Auth (`better-auth/client` + `steamOpenIDClient`, (genericOAuth не имеет клиентского плагина в 1.7.10)).
- Produces: `bun run --cwd apps/web build` → `apps/web/dist/` (index.html + ассеты); `dev.ts` — `Bun.serve` с HTML-импортом и HMR на `:5173`, проксирует `/api/*` и `/rpc` (WS) на `:3000`.

- [ ] **Step 1:** Сборка: `build.ts` вызывает `Bun.build({ entrypoints: ["src/index.html"], outdir: "dist", minify: true, plugins: [tailwind] })` (`bun-plugin-tailwind`). shadcn/ui: компоненты `button`, `card`, `badge`, `tooltip`, `skeleton` в `src/components/ui`. Тёмная тема по умолчанию.
- [ ] **Step 2: тесты** (`@testing-library/react` + `happy-dom` в `bun test`):
  ```tsx
  it("ProtonBadge shows russian label per tier", ...) // tier "gold" → текст «Работает после мелких настроек»
  it("library renders private profile screen", ...)  // LibraryView Private → текст «Откройте „Сведения об играх“» и ссылка https://steamcommunity.com/my/edit/settings
  it("library renders empty state", ...)            // Ready, entries [] → «В библиотеке пока нет игр»
  it("library play button is disabled with hint", ...) // кнопка «Играть» disabled, подсказка «Скоро»
  ```
- [ ] **Step 3:** Тесты — Expected: FAIL.
- [ ] **Step 4:** Реализовать:
  - `/` — если не вошёл: экран с кнопкой «Войти через Steam» (`authClient.steam.login({ callbackURL: "/library" })`); если вошёл — редирект на `/library`.
  - `/library` — сетка вертикальных обложек (как в GameHub: тёмный фон, крупные обложки 600×900, название под обложкой, плашка ProtonDB, время в Steam), кнопка «Обновить» (`library.refresh`; при `SteamUnavailable` — тост «Steam сейчас недоступен, показываем сохранённую библиотеку»), аватар и «Выйти» в шапке. Кнопка «Играть» на карточке — disabled с подсказкой «Скоро» (запуск — план 2).
  - `/admin` — без сессии кнопка «Войти через Pocket ID» (`authClient.signIn.social({ provider: "pocket-id", callbackURL: "/admin" })`); роль `player` → «Нет доступа»; `admin` → заголовок «Админка» и результат `admin.ping`.
  - `rpc.ts` — Effect RPC-клиент по WebSocket на `/rpc` + атомы `@effect/atom-react` для `auth.me` и `library.list`.
- [ ] **Step 5:** `bun test apps/web` — Expected: PASS. `bun run build` — Expected: появился `apps/web/dist/index.html`.
- [ ] **Step 6:** Ручная проверка локально: `bun run dev` (api + web), вход через Steam на `http://localhost:5173` проходит, библиотека с обложками и плашками.
- [ ] **Step 7:** Commit `feat(web): steam login, library grid, admin stub`.

---

### Task 7: Деплой на brofrong за game.brofrong.ru

**Files:**
- Create: `deploy/Dockerfile`, `deploy/compose.yaml`, `deploy/deploy.sh`, `deploy/README.md`

**Interfaces:**
- Consumes: всё выше.
- Produces: на `brofrong` compose-проект `cloud-gaming` в `~/cloud-gaming`: `cg-postgres` (`postgres:18`, volume `cg-postgres-data`, только внутренняя сеть `cg`), `cg-api` (образ из `deploy/Dockerfile`, сети `cg` + внешняя `proxy`, без публикации портов наружу, `restart: unless-stopped`, healthcheck `GET /healthz`).

- [ ] **Step 1:** `deploy/Dockerfile`: стадия `oven/bun:1.4` → `bun install --frozen-lockfile` → `bun run build` (web) → финальный образ запускает `bun apps/api/src/main.ts` с `WEB_DIST_DIR=/app/apps/web/dist`.
- [ ] **Step 2:** `deploy/deploy.sh`: `rsync` репозитория (без `node_modules`, `.git`, `spike/nv`) в `brofrong:~/cloud-gaming`, затем `ssh brofrong 'cd ~/cloud-gaming && docker compose -f deploy/compose.yaml --env-file .env up -d --build'`. `.env` на сервер копируется отдельно один раз (`scp .env.production brofrong:~/cloud-gaming/.env`, права 600), скрипт его не перезаписывает.
- [ ] **Step 3: ручной шаг владельца** (описать в `deploy/README.md`):
  - в ingressi (`https://proxy.brofrong.ru`) добавить хост `game.brofrong.ru` → `http://cg-api:3000`, WebSocket включён, HTTPS (Let's Encrypt);
  - в Pocket ID (`https://sso.brofrong.ru`) создать OIDC-клиента «Cloud Gaming», callback `https://game.brofrong.ru/api/auth/callback/pocket-id`, группа `cloud_gaming_admins`, добавить в неё себя; client id/secret — в `.env` на сервере.
- [ ] **Step 4:** `./deploy/deploy.sh`; проверка: `curl -s https://game.brofrong.ru/healthz` → `ok`; `ssh brofrong 'docker ps --filter name=cg- --format "{{.Names}} {{.Status}}"'` → оба `healthy`; число остальных контейнеров на сервере не изменилось.
- [ ] **Step 5:** Приёмка с владельцем: вход через Steam на `https://game.brofrong.ru` → библиотека с Vampire Survivors и плашкой ProtonDB; вход через Pocket ID на `/admin` → «Админка», `pong`.
- [ ] **Step 6:** Commit `feat(deploy): compose deployment to brofrong`.
