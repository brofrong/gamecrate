# Десктоп-приложение GameCrate (шаг 1) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Приложение Tauri 2 для Windows/macOS/Linux, которое открывает сайт GameCrate в своём окне, живёт в трее с уведомлениями очереди, перехватывает системные сочетания в игре, входит через Google системным браузером и обновляется само; сборки — GitHub Actions по тегу `desktop-v*`, раздача — с нашего сайта.

**Architecture:** `apps/desktop` — Rust-оболочка без своего фронтенда: окно грузит `PUBLIC_URL`, удалённой странице открыт только узкий набор наших команд (capability `remote.urls`). Сайт узнаёт, что он в приложении, по мосту Tauri (`apps/web/src/lib/desktop.ts`) и только тогда меняет поведение. API получает обмен одноразового токена входа и раздачу сборок из бакета `cg-desktop` в `cg-rustfs`.

**Tech Stack:** Tauri 2 (Rust, плагины single-instance, deep-link, notification, opener, updater), существующие Bun + Effect 4 + better-auth 1.7.10 (`one-time-token`) + React 19/TanStack Router, `Bun.S3Client`, GitHub Actions (`tauri-apps/tauri-action`), GitLab push mirror, gitleaks.

**Spec:** `docs/superpowers/specs/2026-11-16-desktop-app-design.md`

## Global Constraints

- Браузерный путь сайта не меняется: всё новое в `apps/web` — под `isDesktop()`; существующие тесты `apps/web` проходят без правок.
- Нативные команды доступны только origin `PUBLIC_URL` (prod `https://game.brofrong.ru`); удалённой странице не открываем плагины fs/shell/http и никакие команды, кроме: `notify`, `set_status`, `enter_game_fullscreen`, `exit_game_fullscreen`, `open_external`, `app_info`.
- Лендинга в приложении нет: `/` → `/app`; гость → `/login` (уже делает `app.tsx`).
- Версии зависимостей пинуются точно (как во всём репо): `Cargo.toml` — `=X.Y.Z`, `package.json` — без `^`.
- Теги: `desktop-vX.Y.Z` — приложение, `vX.Y.Z` — сервер; друг друга не запускают.
- Без подписи кода; подпись обновлений — новый ключ updater Tauri.
- Секреты (ключ updater, ключ загрузки S3, токен push mirror) — только Bitwarden (папка `AI agents`, id `a783fb91-3cb3-482d-a471-a455ae5748f6`) и секреты GitHub/GitLab; в репо, логи, memory не попадают; в команды подставляются без вывода.
- Публичное зеркало включается только после отчёта gitleaks по всей истории и «ок» владельца. Деплой на главный сервер — только с согласия владельца.
- Минимальные ОС: Windows 10+, macOS 11+, Ubuntu 22.04+.
- Тексты интерфейса — по-русски, в тоне сайта.

## Review Focus

1. **Окно спрятано в трей во время очереди** — heartbeat не должен замирать (WebView2/WKWebView троттлят скрытые окна): игрок с окном в трее 5 минут остаётся в очереди. Тест — ручная проверка в задаче 3 и задаче 5 (шаг «очередь в трее»).
2. **Чужая страница в окне** (ссылка из описания игры, редирект OAuth на чужой домен) не получает доступ к командам и не остаётся в окне — уходит в системный браузер. Тест — `nav::is_internal` в задаче 1 и проверка capability в задаче 5.
3. **Повторный или просроченный токен входа** из `gamecrate://auth` → не входит, показывает «Ссылка входа устарела — войдите ещё раз». Тест — задача 7.
4. **Второй запуск / клик по `gamecrate://` при уже открытом приложении** — не второе окно, а фокус первого и переход по ссылке. Тест — `deep_link::target` в задаче 7 + ручная проверка.
5. **Обновление нашлось во время игры или очереди** — не перезапускать и не спрашивать, пока статус не `idle`. Тест — `update_prompt_allowed` в задаче 8.

---

### Task 1: Оболочка `apps/desktop` — окно с сайтом

**Files:**
- Create: `apps/desktop/package.json` (скрипты `dev`, `build`, `test` = `cargo test --manifest-path src-tauri/Cargo.toml`; devDependency `@tauri-apps/cli` точной версии)
- Create: `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,src/main.rs,src/lib.rs,src/nav.rs,icons/*}`
- Create: `apps/desktop/offline/index.html` (заглушка «Нет связи с сервером — Повторить»)
- Create: `apps/desktop/README.md` (dev-запуск, переменная `GAMECRATE_URL`)
- Modify: корневой `package.json`/`turbo.json` — только если `apps/desktop` иначе ломает `bun run check|lint|test` (cargo в CI GitLab нет: `test` desktop в turbo не включаем или делаем no-op без cargo)

**Interfaces:**
- Produces: `nav::is_internal(url: &Url, public: &Url) -> bool` (тот же scheme+host+port); `const PUBLIC_URL: &str` = `option_env!("GAMECRATE_URL").unwrap_or("https://game.brofrong.ru")`; окно `main` (label `"main"`).

- [ ] **Step 1: Тесты `nav.rs`** — `#[cfg(test)]`: `https://game.brofrong.ru/app` → true; `https://game.brofrong.ru/api/auth/callback/google` → true; `https://accounts.google.com/...` → false; `http://game.brofrong.ru/` → false (другая схема); `https://game.brofrong.ru.evil.com/` → false; `https://store.steampowered.com/app/1` → false.
- [ ] **Step 2:** `cargo test` в `apps/desktop/src-tauri` — FAIL (нет `is_internal`).
- [ ] **Step 3: Реализация.** `nav::is_internal`; в `lib.rs` — окно `main` на `WebviewUrl::External(PUBLIC_URL + "/app")`, 1280×800, мин. 960×600, заголовок «GameCrate»; `on_navigation`: внутренние — разрешить, прочие `http(s)` — `tauri-plugin-opener` в системный браузер и запретить; UA = стандартный + ` GameCrateDesktop/<версия из Cargo>`; плагин single-instance (второй запуск — показать и сфокусировать `main`); если страница не загрузилась (ошибка навигации/нет сети) — показать `offline/index.html` (бандл-ассет), кнопка «Повторить» снова грузит `PUBLIC_URL/app`. Иконки — из логотипа бренда (`apps/web/src/assets`), `tauri icon`.
- [ ] **Step 4:** `cargo test` — PASS; `bun run --cwd apps/desktop dev` на Mac: окно открывает `/app`, гость попадает на `/login`, вход по коду на почту работает, RPC `/rpc` подключается (если 403 «Forbidden origin» — записать, какой Origin шлёт webview, и добавить его в `ALLOWED_ORIGINS`), ссылка Steam в описании игры открывается в браузере, второй запуск фокусирует окно, при выключенном Wi-Fi — заглушка и «Повторить» после включения.
- [ ] **Step 5:** На Mac запустить сессию на brofrong в окне: идёт ли стрим в WKWebView, работают ли клавиши/мышь/Pointer Lock, звук. Записать итог в раздел «Итоги проверки» в конце этого плана.
- [ ] **Step 6:** Commit `feat(desktop): оболочка Tauri — окно с сайтом, внешние ссылки в браузер, заглушка без сети`.

### Task 2: Сборка на GitHub — gitleaks, зеркало, workflow

**Files:**
- Create: `.github/workflows/desktop.yml`
- Create: `.gitleaks.toml` (только если нужны allowlist для ложных срабатываний — каждое с комментарием)
- Modify: `apps/desktop/README.md` (релиз: тег `desktop-vX.Y.Z` в GitLab)

**Interfaces:**
- Consumes: `apps/desktop` из задачи 1.
- Produces: на тег `desktop-v*` в GitHub — артефакты Actions: macOS universal `.dmg` + `.app.tar.gz`(+`.sig` с задачи 8), Windows NSIS `.exe`(+`.sig`), Linux `.AppImage`(+`.sig`) и `.deb`. Загрузку на сайт добавляет задача 8.

- [ ] **Step 1: gitleaks по всей истории** (`gitleaks git --log-opts="--all" --report-path <scratch>/gitleaks.json`, отчёт вне репо). Показать владельцу находки (файл, коммит, тип — без значений секретов). **Стоп до «ок» владельца.** Если найден живой секрет — ротация до публикации (переписывать историю — только по решению владельца).
- [ ] **Step 2:** Попросить у владельца GitHub-аккаунт/организацию и имя репо; репо публичный, пустой. Токен GitHub (fine-grained, только этот репо, Contents: write) — `request_secret`, сохранить в Bitwarden `AI agents` как `GitHub (gamecrate mirror push)`; настроить push mirror в GitLab (проект 351, Settings → Repository → Mirroring, ветки и теги) через API GitLab токеном из Keychain `devops.gitlab-imt.token`. Проверить, что main и теги появились на GitHub.
- [ ] **Step 3: `desktop.yml`** — `on: push: tags: ['desktop-v*']` + `workflow_dispatch`; матрица: `macos-latest` (`--target universal-apple-darwin`, rustup targets `aarch64-apple-darwin,x86_64-apple-darwin`), `windows-latest` (NSIS), `ubuntu-22.04` (apt: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`); `Swatinem/rust-cache` с `workspaces: apps/desktop/src-tauri`; Bun для `@tauri-apps/cli`; `tauri-apps/tauri-action` (пин по SHA) без релиза GitHub, артефакты — `actions/upload-artifact`; `permissions: contents: read`. Шаги подписи кода — есть, закомментированы с пометкой «нет сертификатов».
- [ ] **Step 4:** Проверка: `workflow_dispatch` на ветке → три джоба зелёные, артефакты скачиваются; на Mac `.dmg` открывается (ПКМ → Открыть).
- [ ] **Step 5:** Commit `ci(desktop): сборка приложения на GitHub Actions по тегу desktop-v*`.

### Task 3: Проверка на Windows и Linux (владелец) и решение по Linux

**Files:**
- Modify: этот план — раздел «Итоги проверки»; спека — короткая записка в «Состояние на …»

- [ ] **Step 1:** Дать владельцу чек-лист (сборки из задачи 2): установка без подписи; вход по коду; запуск игры; идёт ли стрим и звук; клавиши, мышь, Pointer Lock; **окно свернуть/скрыть на 5 минут в очереди — не выпал ли** (Review Focus 1); на Windows — выполнить в консоли DevTools окна `typeof navigator.keyboard?.lock` и проверить, уходят ли Win/Alt+Tab в игру в HTML-полноэкранном режиме.
- [ ] **Step 2:** Записать итоги. Если на Linux нет стрима — **вопрос владельцу** (AskUserQuestion): Linux-сборка «только каталог», отложить Linux или Electron для Linux. Если скрытое окно троттлится — пометить задачу 5, шаг heartbeat в Rust, обязательным.
- [ ] **Step 3:** Commit `docs(desktop): итоги проверки на трёх ОС`.

### Task 4: Сайт — мост к приложению и без лендинга

**Files:**
- Create: `apps/web/src/lib/desktop.ts`
- Modify: `apps/web/src/routes/index.tsx` (в приложении — `<Navigate to="/app" replace />`), `apps/web/src/routes/login.tsx:46-52` (логотип ведёт на `/app` в приложении), `apps/web/src/routes/__root.tsx:25` («На главную» → `/app` в приложении), `apps/web/src/routes/session.$id.tsx:186`, `apps/web/src/auth.ts:93-96` (`signOut` → `homePath()`)
- Test: `apps/web/test/desktop.test.ts`, дополнить `apps/web/test/landing.test.tsx` / `login.test.tsx`

**Interfaces:**
- Produces (`desktop.ts`):
  - `isDesktop(): boolean` — есть `window.__TAURI_INTERNALS__`;
  - `homePath(): "/" | "/app"`;
  - `type DesktopStatus = { kind: "idle" } | { kind: "queued"; position: number; total: number; etaMinutes: number | null } | { kind: "starting" } | { kind: "playing" }`;
  - `desktopNotify(title: string, body: string): Promise<void>`, `desktopSetStatus(s: DesktopStatus): Promise<void>`, `desktopEnterGameFullscreen(): Promise<void>`, `desktopExitGameFullscreen(): Promise<void>`, `desktopOpenExternal(url: string): Promise<void>`, `desktopAppInfo(): Promise<{ version: string; os: "windows" | "macos" | "linux" } | null>`;
  - все — no-op/`null` вне приложения, ошибки моста проглатываются (не мешают игре), вызов — `__TAURI_INTERNALS__.invoke(<имя команды>, args)` без пакета `@tauri-apps/api` (сайт не тянет зависимость Tauri).

- [ ] **Step 1: Тесты** `desktop.test.ts`: без `__TAURI_INTERNALS__` — `isDesktop()` false, `homePath()` `"/"`, `desktopNotify` не бросает; с фейковым `__TAURI_INTERNALS__.invoke` — `desktopSetStatus({kind:"queued",position:3,total:5,etaMinutes:4})` зовёт `invoke("set_status", { status: <то же> })`; `invoke` бросает → промис резолвится. `landing.test.tsx`: в приложении `/` рендерит редирект на `/app`, в браузере — лендинг (существующие тесты).
- [ ] **Step 2:** `bun test apps/web/test/desktop.test.ts` — FAIL.
- [ ] **Step 3:** Реализовать `desktop.ts` и правки маршрутов/`signOut`.
- [ ] **Step 4:** `bun run --cwd apps/web test` и `bun run check` — PASS.
- [ ] **Step 5:** Commit `feat(web): мост к десктоп-приложению, в приложении без лендинга`.

### Task 5: Трей, уведомления, статус, крестик

**Files:**
- Create: `apps/desktop/src-tauri/src/{commands.rs,tray.rs,status.rs}`, `apps/desktop/src-tauri/capabilities/remote.json`
- Modify: `apps/desktop/src-tauri/src/lib.rs`, `apps/web/src/components/QueueWatcher.tsx` (`notifyQueueReady` → в приложении `desktopNotify`; статус очереди → `desktopSetStatus`), экран сессии (`apps/web/src/routes/session.$id.tsx` или `components/session/*` — где известны состояния сессии): `starting`/`playing`, при уходе — `idle`
- Test: `cargo test` (`status.rs`), `apps/web/test/queueWatcher.test.tsx` (дополнить)

**Interfaces:**
- Consumes: `DesktopStatus` и команды из задачи 4 (JSON `{"kind":"queued","position":3,"total":5,"etaMinutes":4}`).
- Produces (Rust): `enum Status { Idle, Queued { position: u32, total: u32, eta_minutes: Option<u32> }, Starting, Playing }` (serde `tag = "kind"`, `rename_all = "camelCase"`, `rename_all_fields = "camelCase"` — иначе поле `etaMinutes` не совпадёт); `status::tray_label(&Status) -> Option<String>`; `status::close_action(&Status, hidden_notice_shown: bool) -> CloseAction` где `enum CloseAction { Quit, HideToTray { notify: bool } }`; общее состояние `AppState { status: Mutex<Status>, hidden_notice_shown: AtomicBool }`.

- [x] **Step 1: Тесты `status.rs`:** `tray_label(Queued{3,5,Some(4)})` = `"Вы 3-й в очереди · ~4 мин"`; без ETA — `"Вы 3-й в очереди"`; `Starting` → `"Сервер готовится"`; `Playing` → `"Идёт игра"`; `Idle` → `None`. `close_action(Idle, _)` = `Quit`; `close_action(Queued{..}, false)` = `HideToTray{notify:true}`; `close_action(Playing, true)` = `HideToTray{notify:false}`. Десериализация JSON из Interfaces → `Queued{3,5,Some(4)}`.
- [x] **Step 2:** `cargo test` — FAIL.
- [x] **Step 3: Реализация.** Команды `notify`, `set_status`, `open_external` (только `https://`, иначе ошибка), `app_info`; `capabilities/remote.json`: `"remote": { "urls": ["https://game.brofrong.ru/*"] }` (из `PUBLIC_URL` сборки; dev-сборка — её адрес), `"windows": ["main"]`, permissions — только эти команды и `notification:default`, ничего из fs/shell/http. Трей: иконка, меню «Открыть GameCrate» / строка `tray_label` (disabled, скрыта при `None`) / «Выйти»; клик по иконке и по уведомлению — показать+фокус `main`. `CloseRequested` → `close_action`: `HideToTray` — `prevent_close` + `hide`, при `notify` — уведомление «GameCrate в трее — вы остаётесь в очереди» / «…игра продолжается»; «Выйти» в `Queued`/`Playing` — диалог подтверждения «Выйти из GameCrate? Вы выйдете из очереди.» / «Игра продолжится, пока не истечёт время ожидания.» (сессию приложение не завершает). Если задача 3 показала троттлинг скрытого окна — heartbeat очереди из Rust: пока `Queued` и окно скрыто, раз в 30 с `fetch` в окне через `eval` вызова существующего heartbeat (или отключение троттлинга средствами webview) — выбрать по итогам задачи 3.
- [x] **Step 4: Тесты сайта** `queueWatcher.test.tsx`: в приложении (фейковый `__TAURI_INTERNALS__`) готовность сервера зовёт `invoke("notify", …)` с `queueReadyNotification`, а не `new Notification`; позиция очереди меняется → `invoke("set_status", {status:{kind:"queued",…}})`; в браузере — как раньше.
- [ ] **Step 5:** `cargo test`, `bun run --cwd apps/web test` — PASS. Ручная проверка на Mac: очередь (занять brofrong второй сессией) → трей показывает позицию; крестик прячет окно, уведомление один раз; «Сервер готов» приходит при скрытом окне, клик открывает окно; **окно скрыто 5 минут — игрок в очереди** (Review Focus 1). Капабилити: открыть в окне внешнюю страницу нельзя (уходит в браузер) — Review Focus 2.
- [x] **Step 6:** Commit `feat(desktop): трей, уведомления очереди, крестик прячет в трей в очереди и игре`.

> **Исполнено (2026-11-16), отличия от шагов выше:** капабилити не файлом `capabilities/remote.json`, а в рантайме
> (`commands::site_capability(nav::public_base())` — адрес сайта из сборки, dev-адрес тоже работает); команды объявлены в
> `build.rs` (`AppManifest`), поэтому заглушка из бандла и любые чужие страницы не зовут ничего. `notification:default`
> странице не выдан — уведомление показывает Rust по команде `notify`. Heartbeat из Rust не делали: окну выставлен
> `background_throttling(Disabled)` (WKWebView, macOS 14+) — проверить пунктом «окно скрыто 5 минут». Место 0 в трее —
> «Вы в очереди». Статус шлют `QueueWatcher` (зеркало сервера) и экран игры (`starting`/`playing`, при уходе — `idle`).

### Task 6: Полный экран и перехват сочетаний

**Files:**
- Create: `apps/desktop/src-tauri/src/fullscreen/{mod.rs,macos.rs,windows.rs,linux.rs}`
- Modify: `apps/desktop/src-tauri/src/commands.rs`, `apps/web/src/lib/fullscreen.ts`, `apps/web/src/components/session/SessionControls.tsx` (если нужно)
- Test: `apps/web/test/fullscreen.desktop.test.ts` (новый), существующие тесты полного экрана

**Interfaces:**
- Consumes: `desktopEnterGameFullscreen`, `desktopExitGameFullscreen`, `desktopAppInfo` (задача 4).
- Produces: команды `enter_game_fullscreen` / `exit_game_fullscreen`; событие окна `game-fullscreen` (payload `bool`) при входе/выходе (в т.ч. выход ОС-средствами); на сайте `useIsFullscreen()` в приложении слушает это событие (`__TAURI_INTERNALS__` event listen) вместо `fullscreenchange`.

- [ ] **Step 1: Тесты сайта:** в приложении `enterFullscreen(root, frame)` зовёт `invoke("enter_game_fullscreen")`; на `os: "macos"`/`"linux"` **не** зовёт `root.requestFullscreen` (иначе Esc в WKWebView сразу выходит); на `"windows"` зовёт и `requestFullscreen`, и `keyboard.lock` (если задача 3 подтвердила `keyboard.lock` в WebView2; иначе как macOS); событие `game-fullscreen: false` → `useIsFullscreen()` false. Браузерные тесты не меняются.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Реализация.** `enter_game_fullscreen`: `window.set_fullscreen(true)` + платформенный перехват; `exit` — обратно. macOS: `NSApplication.presentationOptions = [.hideDock, .hideMenuBar, .disableProcessSwitching, .disableHideApplication]` на время игры (через `objc2-app-kit`), меню без Cmd+Q/Cmd+W-шорткатов в игре. Windows: если `keyboard.lock` в WebView2 работает — Rust только `set_fullscreen`; иначе `SetWindowsHookExW(WH_KEYBOARD_LL)`, пока окно в фокусе: Win/Alt+Tab/Alt+Esc не уходят в ОС, а передаются странице (`eval` с `KeyboardEvent` в фрейм стрима через существующий `selkiesBridge`). Linux: только `set_fullscreen` (+ запрет системных сочетаний, если доступен). Потеря фокуса → перехват снять; возврат фокуса в полноэкранном режиме → снова включить. Выход: удержание Esc `ESC_HOLD_MS` (существующий `watchEscape`) и кнопка меню → `exit_game_fullscreen`.
- [ ] **Step 4:** Тесты PASS. Ручная проверка на Mac: Cmd+Tab и Cmd+Q в игре не срабатывают, Esc уходит в игру, удержание Esc выходит, Dock/меню скрыты и возвращаются после выхода и при сворачивании. Windows — чек-лист владельцу (Win, Alt+Tab, Esc, удержание Esc).
- [ ] **Step 5:** Commit `feat(desktop): нативный полный экран и перехват системных сочетаний в игре`.

### Task 7: Вход через системный браузер и `gamecrate://`

**Files:**
- Modify: `apps/api/src/auth/auth.ts` (плагин `oneTimeToken` из `better-auth/plugins/one-time-token`, срок 2 мин, хранение хешем — опция плагина; если плагин не даёт хеш/одноразовость — свой маршрут в `apps/api/src/auth/desktopToken.ts` на таблице `verification`)
- Create: `apps/web/src/routes/loginDesktop.tsx` (`/login/desktop` и `/login/desktop/finish`), `apps/desktop/src-tauri/src/deep_link.rs`
- Modify: `apps/web/src/main.tsx` (маршруты), `apps/web/src/auth.ts` (клиент `oneTimeTokenClient`), `apps/web/src/components/login/LoginPanel.tsx` (в приложении провайдеры → `desktopOpenExternal(PUBLIC_URL + "/login/desktop?provider=<p>")` и экран «Продолжите вход в браузере»), `apps/desktop/src-tauri/{tauri.conf.json,src/lib.rs}` (плагин deep-link, схема `gamecrate`)
- Test: `apps/api/test/desktopLogin.test.ts`, `apps/web/test/loginDesktop.test.tsx`, `cargo test` (`deep_link.rs`)

**Interfaces:**
- Produces: `/login/desktop?provider=google|yandex` (браузер): гость → `signInWithProvider(provider, "/login/desktop?done=1")`; вошедший → генерирует токен и `location = "gamecrate://auth?token=<t>"`, на странице «Можно вернуться в GameCrate». `/login/desktop/finish?token=<t>` (окно приложения): verify → cookie сессии → `/app`; ошибка → `/login?error=DESKTOP_TOKEN` с текстом «Ссылка входа устарела — войдите ещё раз» (в `authErrorMessage`). Rust: `deep_link::target(url: &Url, public: &Url) -> Option<Url>`: `gamecrate://auth?token=T` → `public/login/desktop/finish?token=T`; `gamecrate://open?path=/app/game/1` → `public/app/game/1`; путь не с `/`, с `//`, со схемой, `auth` без токена, другой host — `None`.

- [x] **Step 1: Тесты API** `desktopLogin.test.ts` (по образцу `auth.test.ts`, настоящий better-auth на тестовой БД): вошедший генерирует токен → verify с ним ставит cookie сессии того же пользователя; второй verify тем же токеном — отказ; токен старше 2 мин — отказ; без сессии генерация — 401; в таблице нет токена в открытом виде.
- [x] **Step 2: Тесты Rust** `deep_link.rs` — все случаи из Interfaces. **Тесты сайта** `loginDesktop.test.tsx`: вошедший на `/login/desktop` → `location.assign("gamecrate://auth?token=…")`; гость → `signIn.social` с `callbackURL: "/login/desktop?done=1"`; `finish` с ошибкой verify → редирект на `/login?error=DESKTOP_TOKEN`; в приложении кнопка Google зовёт `invoke("open_external", { url: ".../login/desktop?provider=google" })`.
- [x] **Step 3:** FAIL везде.
- [x] **Step 4: Реализация** API, сайта и Rust: deep link и second-instance (из single-instance argv) → `deep_link::target` → `main.navigate(url)` + показать/фокус; на старте — тоже разобрать ссылку, если приложение запущено ею. Яндекс: сначала проверить вход прямо в окне; если пускает — в приложении только Google идёт через браузер.
- [ ] **Step 5:** Тесты PASS (`bun run --cwd apps/api test`, `apps/web`, `cargo test`). Ручная проверка на Mac (dev-сборка с `GAMECRATE_URL` стенда или prod после деплоя): Google через браузер → приложение вошло; та же ссылка `gamecrate://auth?...` второй раз → «Ссылка входа устарела»; `open gamecrate://open?path=/app/crate` при открытом приложении → то же окно.
- [x] **Step 6:** Commit `feat(auth): вход в приложение через системный браузер и одноразовый токен`.

> **Исполнено (2026-11-16), отличия от шагов выше:** плагин `oneTimeToken` (better-auth 1.7.10) дал всё нужное —
> `expiresIn: 2`, `storeToken: "hashed"`, одноразовость атомарно; свой маршрут и миграция не понадобились. Токен
> приходит в окно во **фрагменте** (`/login/desktop/finish#token=…`, не в query): страница сразу убирает его из адреса и
> меняет POST-ом. Через браузер в приложении идут **все** OAuth-кнопки (Google, Яндекс, Telegram, «Вход для команды»):
> окно и так отдаёт чужие хосты браузеру; код на почту — в окне. Вошёл ли игрок, `/login/desktop` узнаёт по 401 от
> генерации токена; `done=1` без сессии — ошибка, не цикл. Rust: `tauri-plugin-deep-link =2.6.3`, single-instance с
> фичей `deep-link`; `register_all()` только в debug на Windows/Linux; сайту права deep-link не выданы (тест ACL).
> Приложение получает ту же сессию, что браузер (выход в браузере — выход и в приложении). Шаг 5 — ручная проверка
> владельцем (чек-лист в отчёте задачи 7). Привязка соцсети в профиле из приложения (`linkSocial`) — не сделана.

### Task 8: Раздача, страница «Скачать», автообновление, загрузка из GitHub

**Files:**
- Create: `apps/api/src/download/{DesktopReleases.ts,routes.ts}`, `apps/web/src/routes/download.tsx`, `apps/web/src/lib/detectOs.ts`, `apps/desktop/scripts/manifest.ts`, `apps/desktop/src-tauri/src/update.rs`
- Modify: `apps/api/src/config.ts` (`DESKTOP_S3_ENDPOINT` по умолчанию `http://cg-rustfs:9000`, `DESKTOP_S3_BUCKET` = `cg-desktop`, `DESKTOP_S3_ACCESS_KEY`/`DESKTOP_S3_SECRET_KEY` — `Config.Redacted`, только чтение), `apps/api/src/http.ts` (маршрут до `StaticRoute`), `apps/api/src/main.ts`, `deploy/compose.main.yaml` (переменные; бакет `cg-desktop` создаётся `cg-rustfs-bucket` с `BUCKET=cg-desktop`), `deploy/README.md`, `.env.example`, `.github/workflows/desktop.yml` (джоб `publish`), `apps/desktop/src-tauri/tauri.conf.json` (updater: `pubkey`, `endpoints: ["https://game.brofrong.ru/download/desktop/latest.json"]`, `createUpdaterArtifacts: true`), `apps/web/src/main.tsx`, меню профиля и лендинг (ссылка «Скачать приложение», только в браузере)
- Test: `apps/api/test/download.test.ts`, `apps/web/test/download.test.tsx`, `apps/desktop/scripts/manifest.test.ts`, `cargo test` (`update.rs`)

**Interfaces:**
- Produces: `DesktopReleases` (Effect-сервис): `get(key: string): Effect<Option<{ body: ReadableStream; size: number; contentType: string }>>`, слой на `Bun.S3Client` (path-style, как `apps/agent/src/profile/ProfileStore.ts`) + тестовый слой на Map. Маршруты: `GET /download/desktop/latest.json` (`Cache-Control: no-cache`), `GET /download/desktop/:version/:file` (`version` = `\d+\.\d+\.\d+`, `file` = `[A-Za-z0-9._-]+`, иначе 404; `Cache-Control: public, max-age=31536000, immutable`). `manifest.ts`: `buildManifest({ version, notes, pubDate, baseUrl, files: { platform: "darwin-universal" | "windows-x86_64" | "linux-x86_64"; file: string; signature: string }[] }) → TauriManifest` (формат `latest.json` updater Tauri v2: `platforms["darwin-aarch64"]` и `["darwin-x86_64"]` оба → universal `.app.tar.gz`). Страница `/download` читает `latest.json` и кладёт ссылки по ОС. Rust: `update::prompt_allowed(&Status) -> bool` (только `Idle`).

- [ ] **Step 1: Тесты** — API: `latest.json` отдаётся из фейкового бакета с `no-cache`; файл версии — поток, `Content-Length`, immutable-кэш; `../`, `1.0`, пробелы — 404; нет объекта — 404; маршрут публичный (без cookie). `manifest.test.ts`: три платформы → ключи `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`, URL = `${baseUrl}/${version}/${file}`, подписи на месте. Сайт: `detectOs` по UA/`userAgentData` (Windows/Mac/Linux/иное → null); страница показывает большую кнопку под ОС, остальные ниже, версию, инструкции «без подписи» (тексты из спеки); в приложении ссылка «Скачать приложение» не показывается. Rust: `prompt_allowed` true только для `Idle`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Реализация** API/сайта/manifest. Updater в приложении: проверка при старте и раз в 6 ч, скачивание тихо; когда `prompt_allowed` — уведомление/диалог «Доступна версия X — Перезапустить и обновить»; при `Queued/Playing` ждать смены статуса на `Idle`.
- [ ] **Step 4: Ключи и публикация.** `tauri signer generate` → приватный ключ и пароль — Bitwarden `AI agents` (`Tauri updater (gamecrate desktop)`) и секреты GitHub `TAURI_SIGNING_PRIVATE_KEY`/`…_PASSWORD`; публичный — в `tauri.conf.json`. Пользователь RustFS с политикой write-only на `cg-desktop/*` (если RustFS не умеет — маршрут `PUT /download/desktop/:version/:file` с `DESKTOP_UPLOAD_TOKEN` в API; тогда тесты: без токена 401, с токеном — объект в бакете) → Bitwarden + секреты GitHub `DESKTOP_S3_*`; read-only ключ для API — Bitwarden + `.env` главного. Джоб `publish` (needs: build): скачать артефакты, `bun apps/desktop/scripts/manifest.ts` → `latest.json`, загрузить файлы версии, `latest.json` — последним.
- [ ] **Step 5:** Тесты PASS (`apps/api`, `apps/web`, `apps/desktop`, `cargo test`), `bun run check`, `bun run lint`.
- [ ] **Step 6:** Commit `feat: раздача десктоп-сборок, страница «Скачать» и автообновление`.

### Task 9: Первый релиз `desktop-v0.1.0` и деплой

- [ ] **Step 1:** Ветка `feat/desktop-app` → whole-branch review → merge в main (по образцу прошлых: проверить ветку и статус основного чекаута, мерж `--no-ff`) — **после «ок» владельца**; push в GitLab — по его слову.
- [ ] **Step 2: Деплой главного — с согласия владельца:** переменные `DESKTOP_S3_*` в `.env`, `cg-rustfs-bucket` с `BUCKET=cg-desktop`, пользователь RustFS для загрузки, выкатка `cg-api`.
- [ ] **Step 3:** Тег `desktop-v0.1.0` в GitLab → зеркало → GitHub собирает и публикует → `https://game.brofrong.ru/download/desktop/latest.json` отдаёт 0.1.0, страница `/download` скачивает установщики.
- [ ] **Step 4: Проверка обновления:** тег `desktop-v0.1.1` (любая видимая мелочь, например версия в меню трея) → установленное 0.1.0 само предлагает обновиться вне игры (Review Focus 5).
- [ ] **Step 5:** Записать итог в этот план («Итог исполнения»), обновить memory проекта.

---

## Итоги проверки

_(заполняется в задачах 1 и 3)_

### Задача 1 — дымовой прогон (агент, Mac, 2026-11-16)

- `cargo test` — 11 passed; `cargo clippy --all-targets -- -D warnings` и `cargo fmt --check` — чисто;
  `bun run --cwd apps/desktop test` — 7 pass.
- `GAMECRATE_URL=http://127.0.0.1:53177/ bun run --cwd apps/desktop dev` против локальной заглушки
  сайта: окно открылось, заглушка из бандла (`tauri dev` раздаёт её с `http://127.0.0.1:1430`) сразу
  ушла на `http://127.0.0.1:53177/app` (`on_page_load` Finished). Сервер увидел UA
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) GameCrateDesktop/0.1.0`.
- Настоящий сайт, вход, стрим и сценарии ниже агент не проверял — это ручной чек-лист.

### Задача 1 — проверить вручную (Mac)

Запуск: `bun install` в корне, затем `bun run --cwd apps/desktop dev` (сайт `https://game.brofrong.ru`).

- [ ] Окно «GameCrate» открывается без белой вспышки, сразу `/app`; гостя сайт уводит на `/login`.
- [ ] Вход по коду из письма проходит, после входа — библиотека `/app`.
- [ ] `/rpc` подключается (библиотека и статусы грузятся). Если в логах API `403 Forbidden origin` —
      записать Origin окна и добавить его в `ALLOWED_ORIGINS`.
- [ ] Вход через Google/Яндекс: что происходит (по плану чужие страницы уходят в браузер — вход
      через OAuth в окне в задаче 1 не работает, это ожидаемо; записать, как ведёт себя).
- [ ] Ссылка на Steam (страница игры, привязка) открывается в системном браузере, окно остаётся на месте.
- [ ] Во время сессии ссылка «Тарифы» (`/app/plans`, `target="_blank"`) открывается в браузере, экран игры не сменился.
- [ ] Загрузка страниц не открывает лишних вкладок в браузере (WKWebView спрашивает и про iframe:
      чужой iframe на странице откроется в браузере — если такое есть, записать адрес).
- [ ] Второй запуск приложения не открывает второе окно, а показывает и фокусирует первое (в т.ч. свёрнутое).
- [ ] Без сети (выключить Wi-Fi, запустить): «Нет связи с сервером» и «Повторить»; включить сеть,
      нажать «Повторить» — открывается `/app`.
- [ ] Сессия на brofrong в окне: идёт стрим в WKWebView, звук, клавиши, мышь, Pointer Lock (полноэкранный режим).
- [ ] В логах nginx/API у запросов окна UA с `GameCrateDesktop/0.1.0`.

### Задача 5 — дымовой прогон (агент, Mac, 2026-11-16)

- `cargo test` — 24 passed (в т.ч. ACL на мок-рантайме: сайт зовёт команды моста; `evil.com`, `game.brofrong.ru.evil.com`,
  `http://`, чужой порт, Steam, `tauri://localhost` и `http://tauri.localhost` — «not allowed»; плагин `opener` сайту закрыт);
  `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` — чисто; `bun run --cwd apps/web test` — 655 pass,
  1 fail (давний `SteamQrLogin > shows QR and statuses`); корневые `bun run check` и `bun run lint` — чисто.
- `GAMECRATE_URL=http://127.0.0.1:53178/ bun run --cwd apps/desktop dev` против заглушки сайта: окно ушло на `/app`, страница
  через `__TAURI_INTERNALS__` получила `app_info` = `{version:"0.1.0", os:"macos"}`, `set_status` — ok, `open_external("file://…")` —
  «нужен адрес https://», `plugin:opener|open_url` и `plugin:notification|is_permission_granted` — «not allowed».
- Трей, уведомления, диалог «Выйти» и скрытое окно агент глазами не смотрел — это ручной чек-лист ниже.

### Задача 5 — проверить вручную (Mac)

Запуск: `bun run --cwd apps/desktop dev`. В dev-режиме macOS приписывает уведомления «Терминалу» — разрешить ему уведомления;
клик по уведомлению проверять лучше на собранном `.app`.

- [ ] Очередь (занять brofrong второй сессией): в меню трея строка «Вы N-й в очереди · ~M мин» (до подсчёта места — «Вы в очереди»),
      подсказка у иконки «GameCrate — …»; при сдвиге очереди строка меняется.
- [ ] Крестик в очереди прячет окно в трей, уведомление «GameCrate в трее — вы остаётесь в очереди» — только первый раз за запуск.
- [ ] Крестик во время игры — окно в трей, «…игра продолжается» (если уведомления ещё не было).
- [ ] Крестик без сессии — приложение закрывается.
- [ ] **Окно скрыто 5 минут — игрок в очереди** (Review Focus 1): место в очереди не потеряно, позиция в трее обновляется.
      На macOS ниже 14 отключение троттлинга не работает — если место теряется, нужен heartbeat из Rust.
- [ ] «Сервер готов — возвращайтесь в игру» приходит при скрытом окне; клик по уведомлению показывает окно.
- [ ] Клик по иконке трея и «Открыть GameCrate» показывают и фокусируют окно; клик по иконке в Доке — тоже.
- [ ] «Выйти» в трее: в очереди — «Выйти из GameCrate?» / «Вы выйдете из очереди.», в игре — «Игра продолжится, пока не истечёт
      время ожидания.»; «Остаться» — ничего не меняется; без сессии — выход без вопроса.
- [ ] После конца сессии (или ухода с экрана игры) строка статуса из трея пропадает, крестик снова закрывает приложение.
- [ ] Чужая страница в окне не открывается (уходит в браузер) — Review Focus 2; команд у неё нет (проверено тестами ACL).
