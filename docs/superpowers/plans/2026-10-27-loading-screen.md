# Экран загрузки до появления игры — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** после «Играть» игрок видит экран загрузки B с этапами установки и запуска; трансляция
показывается, только когда окно игры появилось на сервере или игрок нажал «Показать экран».

**Architecture:**
- Образ сессии получает скрипт `cg-session-stage <appid>`: печатает текущий этап по логу входа
  Steam, процессам и окнам X11.
- Агент опрашивает его и шлёт новые отчёты `SessionStage`/`InstallStage`.
- Оркестратор пишет этап в `sessions.stage` / `install_jobs.stage`.
- API отдаёт этапы в `SessionView`.
- Сайт рисует экран загрузки поверх уже подключённой трансляции.

**Tech Stack:** Bun, Effect 4.0.5, Drizzle 1.0 RC (Postgres), React + Tailwind (shadcn), bash в
образе сессии (`xdotool`, `pgrep` уже есть).

**Spec:** `docs/superpowers/specs/2026-10-27-loading-screen-design.md`

## Global Constraints

- Этапы запуска, значения: `"computer" | "steam" | "login" | "prepare" | "loading" | "visible"`.
  Подписи на сайте:
  - `computer` — «Готовим компьютер»;
  - `steam` — «Запускаем Steam»;
  - `login` — «Входим в аккаунт»;
  - `prepare` — «Готовим игру»;
  - `loading` — «Загружаем игру».

  `visible` — не строка списка, а конец экрана загрузки. Очередь (`queued`) — строка «Ждём
  свободный сервер».
- Этапы установки, значения: `"preparing" | "login" | "downloading" | "moving"`. Подписи:
  - `preparing` — «Готовим установщик»;
  - `login` — «Входим в Steam»;
  - `downloading` — «Скачиваем игру · N %»;
  - `moving` — «Переносим игру в библиотеку».

  После установки — одна строка «Игра установлена» с галочкой.
- Этап двигается только вперёд: и в агенте, и при записи в БД.
- Признак «игра видна» — окно X11 класса `steam_app_<appid>` (так помечает окна Proton) или окно,
  чей `_NET_WM_PID` — потомок процесса `reaper … AppId=<appid>`. Видимое, не меньше 64×64.
  Окружение (`DISPLAY`, `XAUTHORITY`) брать из процесса клиента Steam (`ubuntu12_32/steam`), а не
  из `plasmashell`: признак не должен зависеть от KDE.
- В argv любой команды агента не должно быть строки `AppId=<число>`: её ищет
  `pgrep -f "AppId=<id>( |$)"` проверки игры.
- Игровое время и переход в `playing` не меняются (спека §4.5).
- Кнопка «Показать экран» видна всегда. Подсказка «Похоже, игра ждёт вас на экране» — через
  3 минуты на этапе `loading`.
- Подсказку «Если появилось окно входа Steam — отсканируйте QR-код в мобильном приложении Steam»
  перенести с трансляции на экран загрузки, к кнопке.
- Картинки: обложка `https://cdn.cloudflare.steamstatic.com/steam/apps/<appId>/library_600x900.jpg`,
  фон — `heroUrl(appId)` из `apps/web/src/lib/gameHero.ts`. Нет картинки — тёмный фон бренда
  `#05060f`.
- Цвета полоски — градиент бренда `#3cc2ff → #3a6cff → #5b2fff`.
- Миграции: `cd packages/db && bunx drizzle-kit generate --name <имя>`. Свой SQL — только через
  `--custom`. Руками `snapshot.json` не править.
- Сервер brofrong: правила из `deploy/README.md`. Без sudo, чужое не трогать, деплой — только без
  живых `cg.session`/`cg.install`. Тестовые запуски — от аккаунта владельца, с его разрешения.
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Агент перезапустился посреди запуска.** Подхваченная сессия снова опрашивает этап и доходит до
  `visible`, экран не висит. Тест — Task 4, `adopted session resumes stage polling`.
- **Сессии, начатые до деплоя (`stage` = null), в `playing`.** Сайт показывает трансляцию, а не
  вечную загрузку. Тест — Task 6, `playing without a stage shows the stream`.
- **Steam перезапустился, и `cg-session-stage` вернул более ранний этап.** Этап не откатывается ни
  в отчётах, ни в БД. Тесты — Task 4 `stage never goes back`, Task 2 `setStage ignores an earlier
  stage`.
- **Скрипт `cg-session-stage` упал или нет X11.** Агент пишет предупреждение и продолжает опрос,
  сессия не падает. Тест — Task 4, `stage check failure keeps polling`.
- **iframe трансляции не пересоздаётся** при снятии экрана загрузки и при «Показать экран». Тест —
  Task 6, `loading overlay keeps the same iframe`.

---

### Task 1: Контракт: отчёты, `SessionView`, столбцы БД

**Files:**
- Modify: `packages/rpc/src/agent.ts` (`AgentReport`), `packages/rpc/src/session.ts`
  (`SessionView`, новые схемы этапов)
- Modify: `packages/db/src/schema/sessions.ts`, `packages/db/src/schema/gamestore.ts`
- Create: миграции `packages/db/migrations/<ts>_loading_stages/` (generate) и
  `<ts>_sessions_notify_stage/` (`--custom`)
- Test: `packages/db/test/sessions.test.ts`, `packages/rpc` — тест декодирования, если в пакете есть
  тесты; иначе в `apps/orchestrator/test/agentHub.test.ts`

**Interfaces:**
- Produces:
  - `export const SessionStage = Schema.Literals(["computer","steam","login","prepare","loading","visible"])`;
  - `export const InstallStage = Schema.Literals(["preparing","login","downloading","moving"])`
    в `packages/rpc/src/session.ts`, с типами того же имени;
  - `AgentReport` + `TaggedStruct("SessionStage", { sessionId: String, stage: SessionStage })` и
    `TaggedStruct("InstallStage", { jobId: String, stage: InstallStage })`;
  - `SessionView` + `stage: NullOr(SessionStage)`, `installStage: NullOr(InstallStage)`,
    `hadInstall: Boolean`;
  - столбцы `sessions.stage` (`text`, enum значений `SessionStage`, null) и `install_jobs.stage`
    (`text`, enum `InstallStage`, null).

- [ ] **Step 1: Падающий тест БД**
  `packages/db/test/sessions.test.ts`, тест `stage change emits session_changed`: по образцу
  `heartbeat-only update does not notify, a state change does`.
  - `update sessions set stage = 'login'` → одно уведомление `session_changed`;
  - повторный `update` с тем же `stage` → ни одного.

- [ ] **Step 2: Убедиться, что падает**
  Run: `cd packages/db && bun run test test/sessions.test.ts`
  Expected: FAIL — нет столбца `stage`.

- [ ] **Step 3: Реализовать**
  - Схемы и столбцы, как в Interfaces.
  - `bunx drizzle-kit generate --name loading_stages`.
  - `bunx drizzle-kit generate --custom --name sessions_notify_stage`: пересоздать
    `session_changed_update_trigger` с тем же `WHEN`, что в
    `20261017141200_sessions_notify_changes`, плюс `OR OLD.stage IS DISTINCT FROM NEW.stage`.
    `install_jobs` уведомляет на любой `UPDATE` — там менять нечего.
  - Поправить все `switch (report._tag)`, которые теперь не исчерпывающие:
    - `apps/orchestrator/src/SessionRunner.ts`: `InstallStage` → `Effect.void`, `SessionStage` —
      Task 2;
    - `InstallDispatcher`: `SessionStage` → `Effect.void`.
  - Поправить хелперы `view()` во всех тестах сайта и API, где есть `satisfies SessionView`:
    `stage: null, installStage: null, hadInstall: false`.

- [ ] **Step 4: Проверить**
  Run:
  - `cd packages/db && bun run test`;
  - `bun run check` (корень, turbo).

  Expected: PASS, без ошибок типов.

- [ ] **Step 5: Коммит** `feat(db,rpc): этапы запуска и установки в отчётах агента и SessionView`

### Task 2: Оркестратор и API хранят и отдают этапы

**Files:**
- Modify: `apps/orchestrator/src/SessionRepo.ts`, `SessionRunner.ts`, `InstallRepo.ts`,
  `InstallDispatcher.ts`
- Modify: `apps/api/src/session/SessionRepo.ts` (`sessionWithGame`, `toView`)
- Test: `apps/orchestrator/test/runner.test.ts`, `apps/orchestrator/test/install.test.ts`,
  `apps/api/test/session.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `SessionRepo.setStage(workerId: string, sessionId: string, stage: SessionStage): Effect<void, …, Db>`;
  - `InstallRepo.recordStage(workerId: string, jobId: string, stage: InstallStage): Effect<void, …, Db>`;
  - `SessionView.stage` / `installStage` / `hadInstall`, заполненные API.

- [ ] **Step 1: Падающие тесты**
  - `runner.test.ts`, `SessionStage report stores the stage of an active session on its worker`:
    - отчёт `login` → `sessions.stage = 'login'`;
    - отчёт от другого `workerId` или для `ended`-сессии → не меняет.
  - `runner.test.ts`, `setStage ignores an earlier stage`: после `loading` отчёт `login` оставляет
    `loading`. Порядок — индекс в `SessionStage`.
  - `install.test.ts`, `InstallStage report stores the stage of a running job`: `downloading`
    сохраняется только для `running`-задачи этого воркера.
  - `apps/api/test/session.test.ts`, `view carries stage, install stage only while installing, and
    hadInstall`:
    - `installing` + `install_jobs.stage='downloading'` → `installStage: "downloading"`;
    - в `starting` → `installStage: null`, `hadInstall: true`, `stage` — из строки.

- [ ] **Step 2: Убедиться, что падают**
  Run: `cd apps/orchestrator && bun run test` и `cd apps/api && bun run test test/session.test.ts`
  Expected: FAIL — нет `setStage`/`recordStage`, нет полей в view.

- [ ] **Step 3: Реализовать**
  - `setStage` — `UPDATE … WHERE id, worker_id, isActive`. Вперёд-только — в SQL: `stage is null
    or` индекс нового больше индекса текущего (`array_position(ARRAY[...], stage)`).
  - `recordStage` — по образцу `recordProgress`, вперёд-только так же.
  - `toView`:
    - `installStage` — только в `installing`, как `installPercentOf`;
    - `hadInstall` — `row.installJobId !== null`.

- [ ] **Step 4: Проверить**
  Run: `cd apps/orchestrator && bun run test && cd ../api && bun run test && cd ../.. && bun run check && bun run lint`
  Expected: PASS.

- [ ] **Step 5: Коммит** `feat(orchestrator,api): хранить и отдавать этап запуска и установки`

### Task 3: Скрипт образа `cg-session-stage`

**Files:**
- Create: `images/session/cg-session-stage`
- Modify: `images/session/Dockerfile` (COPY в `/usr/local/bin`, `--chmod=0755`),
  `images/session/.dockerignore`, `images/session/README.md` (раздел «Файлы»)
- Test: `apps/agent/test/sessionStage.test.ts` (по образцу `apps/agent/test/cgLaunch.test.ts`:
  фейковые `pgrep`, `xdotool`, `xwininfo` в `PATH`, фейковый `HOME`)

**Interfaces:**
- Produces: `cg-session-stage <appid>`. Печатает одно слово из `steam|login|prepare|loading|visible`
  и выходит с 0; не число — 2. Порядок проверок — от последнего этапа к первому:
  1. `visible`: есть процесс `reaper` с `AppId=<appid>` и видимое окно ≥ 64×64:
     - `xdotool search --onlyvisible --class "^steam_app_<appid>$"`;
     - или `xdotool search --onlyvisible --pid <pid>` для потомков `reaper`.

     Окружение X11 — из `/proc/<pid клиента Steam>/environ`. Клиента нет — проверку окон
     пропустить.
  2. `loading`: есть процесс, чья командная строка начинается с `<буква>:\common\`. Так Proton
     запускает exe игры, например `S:\common\1966900\MinutesTillDawn.exe`. Служебные exe Proton
     (`\\?\S:\common\Proton…`, `C:\windows\…`) сюда не попадают.
  3. `prepare`: есть `reaper` с `AppId=<appid>`.
  4. `login`: в `~/.local/share/Steam/logs/steamui_login.txt` есть строка `SetLoginState`.
  5. Иначе `steam`.

  `AppId=<appid>` собирается внутри скрипта: argv скрипта — только число.

- [ ] **Step 1: Падающие тесты**
  `sessionStage.test.ts`, по одному на этап, плюс два особых:
  - `prints steam before the login log exists`;
  - `prints login once SetLoginState is logged`;
  - `prints prepare when reaper for the app runs`;
  - `prints loading when the game exe runs, not Proton's own exe`: фейковый `pgrep` отдаёт
    `\\?\S:\common\Proton - Experimental\files\share\wine\xalia.exe` → не `loading`; затем
    `S:\common\1966900\Game.exe` → `loading`;
  - `prints visible for a steam_app_<appid> window`;
  - `prints visible for a window of a reaper descendant` (нативная игра);
  - `ignores windows smaller than 64x64`;
  - `rejects a non-numeric appid with exit 2`.

- [ ] **Step 2: Убедиться, что падают**
  Run: `cd apps/agent && bun test test/sessionStage.test.ts`
  Expected: FAIL — скрипта нет.

- [ ] **Step 3: Написать скрипт** (bash, `set -u`, шапка-комментарий по-русски, как у
  `cg-steam-shutdown`).

- [ ] **Step 4: Проверить**
  Run: `cd apps/agent && bun test test/sessionStage.test.ts && bash -n ../../images/session/cg-session-stage`
  Expected: PASS.

- [ ] **Step 5: Коммит** `feat(session-image): cg-session-stage — текущий этап запуска игры`

### Task 4: Агент шлёт этапы сессии

**Files:**
- Modify: `apps/agent/src/SessionSupervisor.ts`
- Test: `apps/agent/test/supervisor.test.ts` (фейковый `exec` уже разбирает команды по `cmd[0]`)

**Interfaces:**
- Consumes: `AgentReport.SessionStage` (Task 1), `cg-session-stage` (Task 3).
- Produces:
  - `commands.stage(appId): ["/usr/local/bin/cg-session-stage", String(appId)]`;
  - `STAGE_POLL = Duration.seconds(2)`.

- [ ] **Step 1: Падающие тесты** (`supervisor.test.ts`; фейк отдаёт выход `cg-session-stage` из
  очереди `state.stages`):
  - `start reports computer, then steam after the container starts`;
  - `stage polling reports each new stage once and stops at visible`:
    - очередь `steam, login, login, prepare, loading, visible`;
    - отчёты — `login`, `prepare`, `loading`, `visible` (`steam` уже был) без повторов;
    - после `visible` вызовов `cg-session-stage` больше нет.
  - `stage never goes back`: очередь `prepare, login, loading` → отчёты `prepare`, `loading`.
  - `stage check failure keeps polling`: exec падает (`DockerError`) или выходит не с 0 →
    предупреждение `Stage check failed`, опрос продолжается, сессия живёт.
  - `adopted session resumes stage polling`: подхваченный при старте контейнер опрашивается, первый
    отчёт — текущий этап.
  - `no stage reports after Stopped`.
  - Проверить, что `commands.stage(1794680)` не совпадает с `gamePattern(1794680)`.

- [ ] **Step 2: Убедиться, что падают**
  Run: `cd apps/agent && bun test test/supervisor.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Реализовать**
  - `computer` — в начале `launch`, `steam` — сразу после `docker.start`.
  - Опрос — отдельный fiber в `scope` сессии, параллельно `waitReady`/`watchGame`: от старта (или
    подхвата) до `visible` или остановки.
  - Вперёд-только: `session.stage` и индекс в `SessionStage`.

- [ ] **Step 4: Проверить**
  Run: `cd apps/agent && bun test && bun check && bun lint src`
  Expected: PASS.

- [ ] **Step 5: Коммит** `feat(agent): отчёты об этапе запуска сессии`

### Task 5: Установщик шлёт этапы и плавный процент

**Files:**
- Modify: `apps/agent/src/Installer.ts`
- Test: `apps/agent/test/installer.test.ts`

**Interfaces:**
- Consumes: `AgentReport.InstallStage` (Task 1).
- Produces:
  - `downloadingBytes(dir: string): number` — сумма размеров файлов под `dir` (нет каталога — 0);
  - экспорт для теста.

- [ ] **Step 1: Проверить источник процента на brofrong** (до кода)
  - При первой настоящей установке (игру выбирает владелец, с его разрешения) раз в 2 с
    записывать:
    - `BytesDownloaded` из `appmanifest_<appid>.acf` в upper `apps` установщика;
    - размер `<INSTALL_SCRATCH_DIR>/<jobId>/apps/upper/downloading/<appid>` (`du -sb`).
  - Если `downloading` растёт плавно и не больше `BytesToDownload` — источник он. Иначе — только
    манифест, а плавность даёт полоска сайта (Task 6).
  - Записать вывод в ledger как `Ruling:`.

- [ ] **Step 2: Падающие тесты**
  - `install reports preparing, login, downloading, moving in order`:
    - `preparing` — в начале `download`;
    - `login` — перед `waitForSteamLogon`;
    - `downloading` — после входа (`STEAM_LOGON_OK`);
    - `moving` — в начале `finish`.
  - `downloadingBytes sums files under the dir and is 0 without it` (временный каталог).
  - Если по Step 1 источник — `downloading`: `progress uses downloading bytes when they are ahead of
    the manifest`. `InstallProgress.bytesDownloaded` = максимум из манифеста и каталога, не больше
    `bytesTotal`, не убывает.

- [ ] **Step 3: Убедиться, что падают**
  Run: `cd apps/agent && bun test test/installer.test.ts`
  Expected: FAIL.

- [ ] **Step 4: Реализовать** по тестам.

- [ ] **Step 5: Проверить**
  Run: `cd apps/agent && bun test && bun check && bun lint src`
  Expected: PASS.

- [ ] **Step 6: Коммит** `feat(agent): этапы установки и плавный процент скачивания`

### Task 6: Сайт — экран загрузки B

**Files:**
- Create: `apps/web/src/components/LoadingScreen.tsx`, `apps/web/src/lib/loadingSteps.ts`
- Modify: `apps/web/src/components/Player.tsx`, `apps/web/src/components/SessionStatus.tsx`
  (`queued`/`installing`/`starting` уходят в `LoadingScreen`, остальное как было)
- Test: `apps/web/test/loadingScreen.test.tsx`, `apps/web/test/session.test.tsx`

**Interfaces:**
- Consumes: `SessionView.stage`, `installStage`, `installPercent`, `hadInstall` (Task 2).
- Produces:
  - `loadingSteps(view: SessionView): ReadonlyArray<{ label: string; status: "done" | "now" | "next" }>`;
  - `loadingProgress(view: SessionView, msInStage: number): number` (0..1);
  - `showsLoading(view: SessionView, revealed: boolean): boolean`: `true` для `queued`,
    `installing`, `starting`; для `playing` — только если `stage !== null && stage !== "visible"`;
    `revealed` (нажата «Показать экран») — всегда `false`, кроме `queued`/`installing`, где
    трансляции нет;
  - `STAGE_MS`: ориентировочные длительности по замерам 2026-10-27, мс:
    - запуск: `computer 10_000`, `steam 30_000`, `login 15_000`, `prepare 30_000`, `loading 15_000`;
    - установка: `preparing 20_000`, `login 30_000`, `moving 20_000`.

  Внутри этапа доля полоски — `1 − exp(−msInStage / STAGE_MS)`, не больше 0,95. `downloading` —
  по `installPercent`.

- [ ] **Step 1: Падающие тесты**
  `loadingScreen.test.tsx`:
  - `steps for a launch at prepare`: `[done Готовим компьютер, done Запускаем Steam, done Входим в
    аккаунт, now Готовим игру, next Загружаем игру]`;
  - `queued shows Ждём свободный сервер as the current step`;
  - `install steps show the percent and collapse to Игра установлена after install`:
    - `installing` + `downloading` + 42 % → строка «Скачиваем игру · 42 %» текущая;
    - `starting` + `hadInstall` → первая строка «Игра установлена» (done), дальше этапы запуска;
  - `progress never reaches the next stage before it starts`: `loadingProgress` при огромном
    `msInStage` меньше доли следующего этапа;
  - `cancel calls onExit`;
  - `cover falls back to the brand background when the image fails`.

  `session.test.tsx`:
  - `loading overlay keeps the same iframe`: `starting` → `playing` + `stage: "loading"` →
    `playing` + `"visible"`. iframe тот же элемент, экран загрузки снят на `visible`;
  - `show screen reveals the stream and stays revealed`;
  - `playing without a stage shows the stream`;
  - `hint after 3 minutes in loading`: фейковые таймеры, подсказка «Похоже, игра ждёт вас на
    экране»;
  - QR-подсказка теперь на экране загрузки, а не над трансляцией (поправить старый тест, если он
    её ищет).

- [ ] **Step 2: Убедиться, что падают**
  Run: `cd apps/web && bun test test/loadingScreen.test.tsx test/session.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Реализовать**
  - Вид — по макету B: `.superpowers/brainstorm/68032-1793085924/content/loading-layout-v3.html`.
    - размытый фон `heroUrl`, слева обложка, справа название, список и полоска;
    - сверху «← Отменить» и «Показать экран»;
    - на узком экране обложка над списком.
  - Экран загрузки лежит поверх `StreamFrame` в том же `<main>`. iframe рендерится первым и без
    условий, как сейчас.
  - `revealed` — `useState` в `Player`. `msInStage` — от момента смены `stage`/`installStage`/
    `state` на клиенте (`useRef` со временем + тик раз в секунду).

- [ ] **Step 4: Проверить**
  Run: `cd apps/web && bun test && cd ../.. && bun run check && bun run lint`
  Expected: PASS.

- [ ] **Step 5: Проверить глазами**
  `superpowers:run` или `bun run dev`: экран для `starting`/`installing` на 1280 и на 390 px.
  Сравнить с макетом B.

- [ ] **Step 6: Коммит** `feat(web): экран загрузки до появления игры`

### Task 7: Пересборка образа, деплой, проверка на brofrong

**Files:**
- Modify: `deploy/measure-session-start.sh` — столбец `visible`: первое появление
  `sessions.stage = 'visible'`, медиана по нему (рядом с `game`).
- Modify: `docs/superpowers/specs/2026-10-27-loading-screen-design.md` — раздел «Результаты».

- [ ] **Step 1: Скрипт замера**
  Добавить опрос `select stage from sessions where id = …` в цикл и столбец `visible`.
  Run: `bash -n deploy/measure-session-start.sh` → без вывода.

- [ ] **Step 2: Образ**
  - До пересборки: `docker tag cg-session:550.163.01 cg-session:550.163.01-prev2` на brofrong.
  - `./deploy/build-session-image.sh`.
  - Проверка — что `cg-session-stage` есть и печатает `steam` в пустом контейнере:
    `docker run --rm --network none --entrypoint /usr/local/bin/cg-session-stage cg-session:550.163.01 1966900`
    → `steam`.

- [ ] **Step 3: Деплой**
  По `deploy/README.md`, когда нет `cg.session`/`cg.install`. Миграции применятся при старте.

- [ ] **Step 4: Замер**
  Run: `./deploy/measure-session-start.sh <userId> 1966900 3` (20 Minutes Till Dawn, с
  разрешения владельца).
  Expected:
  - этапы в БД идут по порядку до `visible`;
  - `visible` позже `game` на ~30–60 с.

  Если `visible` не наступил за 10 мин — откатить: прежний образ (`-prev2`) и `main` до этой
  ветки.

- [ ] **Step 5: Проверка владельцем**
  Попросить владельца нажать «Играть» в браузере. Он должен увидеть:
  - экран B с этапами;
  - смену на игру без рабочего стола KDE;
  - работающую «Показать экран».

- [ ] **Step 6: Результаты и коммит**
  Таблица замера в «Результаты» спеки.
  `git commit -m "chore(deploy): замер до появления игры, результаты экрана загрузки"`
