# Время на экране загрузки и правки входа Steam по QR — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Посеянный вход Steam переживает деплой (зашифрован в БД), отвязка Steam стирает вход,
старые попытки входа чистятся, понятнее ошибка после сканирования; экран загрузки показывает
норму и прошедшее время этапов, общий таймер, а «Показать экран» — только при 2× нормы (на
«Входим в аккаунт» — сразу).

**Architecture:** Оркестратор пишет моменты смены этапов (сессий и установок) в отдельные
таблицы отметок; api считает по ним нормы (медианы) с кэшем и отдаёт в `SessionView.timing`
серверные моменты + `serverNow`; веб считает таймеры по серверному времени с поправкой на часы
браузера. `SteamLoginSeeds` сохраняет интерфейс, но хранит посевы в Postgres, шифруя
AES-256-GCM ключом `SEED_KEY`.

**Tech Stack:** Bun, Effect 4, drizzle-orm 1.0 rc + Postgres, React 19, `node:crypto`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-29-launch-timers-design.md`

## Global Constraints

- Тексты: общий таймер `Запуск идёт 1:05 · обычно ~1:40` (у установки — `Установка идёт 2:10`,
  без нормы); текущий этап `<подпись> · обычно ~30 с · 0:12`; пройденный `<подпись> · 0:08`;
  скачивание `Скачиваем · 42 % · 1:12`; подсказка при 2× — `Дольше обычного — загляните на
  экран`; ошибка после сканирования — `Вход не подтверждён в приложении Steam, попробуйте ещё раз`.
- Формат: меньше минуты — норма `~30 с`, прошедшее `0:12`; от минуты — `~1:40` / `1:05`; норма
  округляется до 5 с.
- Норма этапа: медиана последних 50 замеров этапа этой игры, если замеров ≥ 5; иначе медиана
  последних 50 замеров по всем играм, если ≥ 5; иначе `STAGE_MS`. Общая норма запуска —
  `visible − computer` тем же правилом. Установка — только по всем играм; у `downloading` нормы нет.
- «Показать экран»: только при готовом стриме; на этапе `login` — сразу; иначе — когда текущий
  этап идёт дольше 2× своей нормы; раз показана — остаётся до конца экрана загрузки.
- Посев: в БД нет `accountName`/`refreshToken` в открытом виде; `SEED_KEY` — base64 ровно 32
  байт, обязательная переменная оркестратора (как `PROFILE_KEY`); `SEED_TTL` 24 ч.
- Старые попытки: `steam_logins` в `done`/`expired`/`failed`/`cancelled` старше 30 дней удаляются.
- Тесты: БД-тесты из worktree — `bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env`
  (файл не открывать и не выводить); `bun run check --force`, `bun run lint` в корне.
- Коммиты: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; ветка `feat/launch-timers`.

## Review Focus

1. Перезагрузка страницы на середине этапа — таймер продолжает с серверного момента (Task 5).
2. Часы браузера спешат на 2 минуты — таймеры не уходят в минус/плюс 2 минуты (`serverNow`) (Task 5).
3. Один зависший запуск на 20 минут среди пяти обычных — норма остаётся обычной (медиана), а
   запуск, упавший посреди этапа, в выборку не идёт (Task 4).
4. Этап пропущен агентом (например, `login` у уже вошедшего Steam) — длительность предыдущего
   этапа считается до следующего пришедшего, у пропущенного замера нет (Task 4).
5. Перезапуск оркестратора между входом по QR и стартом — посев на месте и уходит в
   `StartSession` (Task 1).

---

### Task 1: Посев входа Steam в БД, зашифрованный

**Files:**
- Modify: `packages/db/src/schema/gamestore.ts` (таблица рядом с `steamLogins`) + миграция `bunx drizzle-kit generate --name steam_login_seeds`
- Modify: `apps/orchestrator/src/SteamLoginSeeds.ts`, `apps/orchestrator/src/config.ts`, `apps/orchestrator/src/main.ts` (слой)
- Modify: `deploy/compose.yaml` (`SEED_KEY: ${SEED_KEY:?SEED_KEY is required}` у `orchestrator`), `deploy/deploy.sh` (`append_secret SEED_KEY base64_32 "base64 ровно 32 байт" "openssl rand -base64 32"`), `deploy/README.md` (переменная и что хранится)
- Test: `apps/orchestrator/test/steamLoginSeeds.test.ts` (и места, где слой создаётся в других тестах)

**Interfaces:**
- Produces: таблица `steam_login_seeds` (`user_id` PK → `user.id` on delete cascade, `steam_id text`, `sealed text` — base64 `iv(12) ‖ tag(16) ‖ ciphertext` JSON `{accountName, refreshToken}`, `put_at timestamptz`, `expires_at timestamptz`). `OrchestratorConfig.seedKey: Redacted<string>` (`SEED_KEY`, проверка base64 32 байта). `SteamLoginSeedsShape` — те же `put`/`get`/`clear`/`clearOlderThan`, но с требованием `Db` в слое; `get` удаляет и не отдаёт просроченную строку; не расшифровывается (другой ключ, порча) — `logWarning` без содержимого, строка удаляется, `null`.

- [ ] **Step 1: Tests:** `survives a new layer instance` (put в одном экземпляре слоя → get в новом возвращает тот же вход), `stores no plaintext` (после put строка `sealed` не содержит ни `accountName`, ни `refreshToken`; `steam_id` есть), `expired seed is gone` (TestClock +24 ч → `null`, строки нет), `clearOlderThan` (прежний тест, теперь на БД), `wrong key → null and row removed`.
- [ ] **Step 2: Run** `cd apps/orchestrator && bun test --env-file=… test/steamLoginSeeds.test.ts` — FAIL.
- [ ] **Step 3: Implement** (AES-256-GCM, `node:crypto`; ключ — `Buffer.from(base64)`; время — `Clock`).
- [ ] **Step 4: Run** весь `apps/orchestrator`, `bun run check --force`, `bun run lint`, `bun test deploy/test` — PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): посев входа Steam хранится в БД зашифрованным`.

### Task 2: Отвязка стирает вход, чистка старых попыток, ошибка после сканирования

**Files:**
- Modify: `apps/api/src/auth/hooks.ts` (ветка `STEAM_PROVIDER_ID` после `/unlink-account`)
- Modify: `apps/orchestrator/src/SteamLoginRunner.ts`, `apps/orchestrator/src/SteamLoginRepo.ts`, `packages/rpc/src/steamLogin.ts`
- Test: `apps/api/test/linking.test.ts` (или где проверяется unlink Steam), `apps/orchestrator/test/steamLogin.test.ts`

**Interfaces:**
- Produces: `steamLoginReasons.notConfirmed = "Вход не подтверждён в приложении Steam, попробуйте ещё раз"`; `SteamLoginRepo.pruneFinished(before: Date): Effect<number>` (удаляет конечные состояния с `updated_at < before`), вызывается раннером при старте и раз в 24 ч с `now − 30 дней`.

- [ ] **Step 1: Tests:** api › `unlinking Steam marks the login reset` (после unlink у пользователя `steam_id` null и `steam_login_reset_at` не null); оркестратор › `Ended after Scanned fails with notConfirmed` и `Ended before Scanned keeps steamError` (то же для `SteamQrError`); `pruneFinished removes only old finished attempts` (старая `done` удалена, старая `waiting` и свежая `failed` остались).
- [ ] **Step 2: Run** нужные файлы — FAIL.
- [ ] **Step 3: Implement** (флаг «отсканировано» — по событию `Scanned` внутри `runAttempt`).
- [ ] **Step 4: Run** `apps/api`, `apps/orchestrator`, `apps/web` целиком (веб показывает причину как есть), check, lint — PASS.
- [ ] **Step 5: Commit** `feat: вход Steam по QR — отвязка стирает вход, чистка попыток, ошибка после сканирования`.

### Task 3: Отметки этапов в оркестраторе

**Files:**
- Modify: `packages/db/src/schema/sessions.ts`, `packages/db/src/schema/gamestore.ts` + миграция `--name stage_marks`
- Modify: `apps/orchestrator/src/SessionRepo.ts` (`setStage`), `apps/orchestrator/src/InstallRepo.ts` (`recordStage`)
- Test: `apps/orchestrator/test/runner.test.ts` или `install.test.ts` (где сейчас проверяются этапы)

**Interfaces:**
- Produces: `session_stage_marks(session_id → sessions.id cascade, stage text, at timestamptz, PK (session_id, stage))`, индекс по `(stage, at desc)`; `install_stage_marks(job_id → install_jobs.id cascade, stage, at, PK (job_id, stage))`, тот же индекс. Отметка пишется в той же транзакции, только если `update` этапа реально изменил строку (`returning`), `at = now` оркестратора, `on conflict do nothing`.

- [ ] **Step 1: Tests:** `setStage records a mark once` (два одинаковых отчёта → одна отметка; более ранний этап после позднего — отметки нет), `visible gets a mark`, то же для `recordStage`.
- [ ] **Step 2–4:** FAIL → implement → весь `apps/orchestrator`, check — PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): отметки времени этапов запуска и установки`.

### Task 4: Нормы и `SessionView.timing` в api

**Files:**
- Create: `apps/api/src/session/StageNorms.ts`
- Modify: `packages/rpc/src/session.ts` (`StageTiming`, `SessionTiming`, `SessionView.timing`), `apps/api/src/session/SessionRepo.ts` (`toView`), `apps/api/src/session/rpc.ts` (`sameView` без `timing.serverNow`)
- Test: `apps/api/test/stageNorms.test.ts`, `apps/api/test/session.test.ts`

**Interfaces:**
- Consumes: Task 3 таблицы.
- Produces:
  ```ts
  StageTiming = Schema.Struct({ stage: Schema.String, startedAt: Schema.String,
    endedAt: Schema.NullOr(Schema.String), normMs: Schema.NullOr(NonNegativeInt) })
  SessionTiming = Schema.Struct({ serverNow: Schema.String,
    launch: Schema.Array(StageTiming), install: Schema.Array(StageTiming),
    launchNormMs: Schema.NullOr(NonNegativeInt) })
  SessionView.timing: Schema.NullOr(SessionTiming)   // null — сессия не на экране загрузки (stage = visible или терминальное состояние)
  ```
  `launch`/`install` — отметки по времени; `endedAt` — момент следующей отметки (последняя — `null`); `normMs` — норма этапа (`null`, если правило ≥ 5 не выполнено ни для игры, ни для всех; у `downloading` всегда `null`). `StageNorms.normsFor(appId: number): Effect<{ launch: Partial<Record<SessionStage, number>>, launchTotal: number | null, install: Partial<Record<InstallStage, number>> }, never, Db>` — кэш в памяти на 60 с по `appId`.
- Норма — `percentile_cont(0.5)` по длительностям `lead(at) over (partition by session order by at) − at`, только где следующая отметка есть; 50 последних замеров этапа (по `at` отметки).

- [ ] **Step 1: Tests:** `per-game norm needs 5 samples` (у игры 4 замера `steam` — норма общая; 5 — своя), `median ignores one stuck launch`, `unfinished stage is not a sample`, `skipped stage: previous lasts until the next mark`, `global norm needs 5 samples else null`, `launchTotal is visible − computer`; `session.test.ts` › `watch view carries timing with server marks` и `timing is null after visible`; `sameView ignores serverNow` (поток не шлёт повтор только из-за `serverNow`).
- [ ] **Step 2–4:** FAIL → implement → весь `apps/api`, `apps/web` (тип `SessionView` расширен — фикстуры веба дополнить `timing: null`), check, lint — PASS.
- [ ] **Step 5: Commit** `feat(api): нормы этапов запуска и серверное время этапов в SessionView`.

### Task 5: Веб — таймеры, нормы, «Показать экран» при 2×

**Files:**
- Modify: `apps/web/src/lib/loadingSteps.ts` (форматирование, норма с запасным `STAGE_MS`, правило кнопки), `apps/web/src/components/LoadingScreen.tsx`, `apps/web/src/components/Player.tsx`
- Modify: `docs/superpowers/specs/2026-10-27-loading-screen-design.md` — одна строка-ссылка на новую спеку там, где описана «Показать экран»
- Test: `apps/web/test/loadingScreen.test.tsx`, тест `loadingSteps` (если есть отдельный — там же)

**Interfaces:**
- Consumes: Task 4 `SessionView.timing`.
- Produces: `formatNorm(ms: number): string` (`~30 с`, `~1:40`, округление до 5 с), `formatElapsed(ms: number): string` (`0:12`, `1:05`), `stageNormMs(timing, stage)` (норма или `STAGE_MS`), `revealDue(view, nowServerMs): boolean` (правило из Global Constraints, без «залипания» — его держит `Player`). Серверное «сейчас» = `Date.now() + (Date.parse(serverNow) − момент получения view)`. `LOADING_HINT_MS` и подсказка «Похоже, игра ждёт вас на экране» удаляются.

- [ ] **Step 1: Tests:** форматирование (29 999 → `~30 с`, 100 000 → `~1:40`, 12 300 → `0:12`, 65 000 → `1:05`); строки этапов: пройденный `Готовим компьютер · 0:08`, текущий `Запускаем Steam · обычно ~30 с · 0:12`, скачивание `Скачиваем · 42 % · 1:12`; заголовок `Запуск идёт 1:05 · обычно ~1:40` и `Установка идёт 2:10`; кнопка: на `steam` при 1,9× — нет, при 2,1× — есть с подсказкой; на `login` — сразу с подсказкой про QR; после смены этапа кнопка остаётся; без стрима — нет; часы браузера +120 с — те же тексты (`serverNow`); `timing: null` — прежний вид без таймеров.
- [ ] **Step 2–4:** FAIL → implement → весь `apps/web`, check, lint — PASS.
- [ ] **Step 5: Commit** `feat(web): таймеры и нормы этапов на экране загрузки, «Показать экран» при 2×`.
