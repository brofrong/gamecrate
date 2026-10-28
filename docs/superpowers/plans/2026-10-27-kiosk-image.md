# План 4: образ-киоск, быстрый запуск и подготовка к другим игрокам — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** образ сессии без KDE (Selkies base + labwc) на драйвере 550, окно игры через ≤ 40 с
после «Играть», слот освобождается только после остановки контейнера, правила изоляции для
нового сервера, проверенная установка с чужого аккаунта Steam.

**Architecture:**
- Сначала пробы на brofrong (киоск, ускорения) с остановкой у владельца; реализация ускорений
  пишется дополнением к плану по итогам проб (Task 8).
- Код, который пересекается с веткой экрана загрузки (БД, `SessionRunner`, образ, замер), — только
  после её слияния в `main` (Task 4).
- Образ меняется так, чтобы агенту не пришлось меняться: тот же контракт (переменные, скрипты,
  пути, флаги контейнера).
- Переключение прода — перетегом образа, откат — обратным перетегом.

**Tech Stack:** Bun, Effect 4.0.5, Drizzle 1.0 RC (Postgres), bash, Docker 29, Selkies 2.0
(`ghcr.io/selkies-project/selkies/base`, ubuntu26.04), labwc + Xwayland, iptables.

**Spec:** `docs/superpowers/specs/2026-10-27-kiosk-image-design.md`

## Global Constraints

- Цель скорости: медиана 3 повторных запусков до этапа `visible` ≤ 40 с для Can of Wormholes
  (1295320) и 20 Minutes Till Dawn (1966900) на brofrong. Владелец 2026-10-28: пока не
  обязательна — замер записывается как есть (Task 8, Task 9).
- Драйвер brofrong 550.163.01 не меняется. Признак здорового захвата в логе контейнера:
  `Zero-copy capture ... encoded in place on NVENC`. Нет его на новой базе — стоп, к владельцу.
- Контракт образа не меняется: `CG_APP_ID`, `CG_MODE=install`, `SELKIES_WEBRTC_UDP_MUX_PORT`,
  `SELKIES_WEBRTC_PUBLIC_IP`, `PASSWD`; скрипты `cg-launch`, `cg-profile-pack`,
  `cg-steam-shutdown`, `cg-session-stage` (из ветки экрана загрузки), `cg-nm-stub`; пути
  `/home/ubuntu/.local/share/Steam` и `…/steamapps`; флаги `desktopSpec` в
  `apps/agent/src/SessionSupervisor.ts:138`.
- Все `SELKIES_*`/`DISPLAY_SIZE*` из нынешнего `images/session/Dockerfile` сохраняются (имена
  проверить в новой базе); разрешение 1920x1080 фиксировано.
- Новый образ — тег `cg-session:550.163.01-kiosk`; `cg-session:550.163.01` подменяется только по
  слову владельца, прежний сохраняется как `cg-session:550.163.01-kde`.
- Сервер brofrong: без sudo, без правок хоста, без перезагрузки, без `docker * prune`; чужие
  контейнеры/тома/сети/образы, тома `cg-home-*` и `cg-spike-home` не трогать; временные
  контейнеры — только с явным `--entrypoint`.
- Любой запуск с GPU на brofrong (проба, замер, смоук): перед ним
  `docker ps -a --filter label=cg.session --filter status=running` и то же для `cg.install`
  пусто, и время согласовано с владельцем в чате. Замеры от аккаунта игрока — только с его
  разрешения.
- Деплой — только по `deploy/README.md`, без живых `cg.session`/`cg.install`; после — сессия
  стартует, иначе сразу откат.
- Не читать/не печатать/не коммитить `.env`, `.env.*` (кроме `.env.example`), `spike/.env`. Токен и
  имя аккаунта Steam — никуда (логи, вывод проб, БД, общие шаблоны). DEBUG на `cg-orchestrator` не
  включать.
- Миграции: `cd packages/db && bunx drizzle-kit generate --name <имя>`; свой SQL — только через
  `--custom`; `snapshot.json` руками не править.
- Коммиты на русском, заканчиваются `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Ничего не пушить и не сливать в `main` без слова владельца. Чужие `.DS_Store` не коммитить.

## Review Focus

- **Агент переподключился, а только что назначенная сессия ещё не в его списке.** Её слот не
  освобождается (окно `RECONCILE_GRACE_MS`). Тест — Task 5, `just scheduled session keeps its
  slot on reconnect`.
- **Строки `ended`/`failed`, существовавшие до миграции,** не держат слоты после деплоя. Проверка —
  Task 5, шаг backfill-миграции, и запрос после деплоя в Task 9.
- **Окно Steam, ждущее игрока** («Unable to Sync», вход по QR, лаунчер игры), в киоске видно во весь
  экран и нажимается мышью. Проверка — Task 7, смоук, и Task 9, ручная проверка владельцем.
- **Геймпад в киоске:** `LD_PRELOAD` процесса Steam содержит интерпозер Selkies. Проверка — Task 2
  и Task 7 (`/proc/<steam>/environ`), Task 9 — владелец с геймпадом.
- **IPv6 на новом сервере:** правила только v4 оставили бы дыру. Тест — Task 1,
  `rules cover ipv6 when the network has an ipv6 subnet`.
- **Новый игрок без файлов префикса в профиле** (первая сессия сразу после установки): шаблон
  должен работать и без `user.reg`/`steamuser` игрока. Тест — Task 8.1, `ensure builds in the
  install scratch…` (умолчания остаются в шаблоне); проверка — Task 10, шаг 2.
- **Сессия той же игры жива, пока собирается шаблон:** lower нельзя менять под её overlay. Тест —
  Task 8.1, `ensure defers the swap while a container of the app exists`.
- **Агент перезапустился, пока добивал зависший контейнер:** контейнер с сохранённым профилем не
  должен стать «вечным» `profile-unsaved`. Тест — Task 8.2, `agent start removes a stopped session
  container whose profile was saved`.

---

### Task 1: Сетевая изоляция для нового сервера

От ветки экрана загрузки не зависит, делается сразу.

**Files:**
- Create: `deploy/session-isolation.sh` — печатает правила `iptables-restore`/`ip6tables-restore`
  для `cg-sessions` (не применяет сам).
- Create: `deploy/check-session-isolation.sh` — проверка без sudo временными контейнерами.
- Create: `deploy/test/sessionIsolation.test.ts`
- Modify: `deploy/README.md` — заменить абзац «**Не сделано** … сетевая изоляция» разделом
  «Сетевая изоляция контейнеров сессий (новый сервер)».

**Interfaces:**
- Produces: `deploy/session-isolation.sh print --subnet <cidr> --bridge <ifname> --api-ip <ip>
  [--subnet6 <cidr>]` → stdout: фрагмент `*filter` для `DOCKER-USER` и `INPUT`, `COMMIT`; при
  `--subnet6` — второй фрагмент с префиксом строки `# ip6tables`. Неверный аргумент — код 2.
  `deploy/session-isolation.sh detect [ssh-хост]` — печатает `--subnet/--bridge/--api-ip/--subnet6`
  для `print`, читая `docker network inspect cg-sessions` и `docker inspect cg-api`.
- Produces: `deploy/check-session-isolation.sh [ssh-хост]` → таблица `цель | ожидается | факт`,
  код 0 — всё как ожидается, 1 — есть открытое, что должно быть закрыто.

Поведение правил (из спеки §4.4): из подсети `cg-sessions` — интернет открыт; закрыты адреса хоста
(цепочка `INPUT` с входом с моста), RFC1918, `169.254.0.0/16`, `100.64.0.0/10`, другие контейнеры
моста (`-i br -o br`), кроме `cg-api` → `:8080` контейнеров сессий; ответы (`ESTABLISHED,RELATED`)
открыты.

- [ ] **Step 1: Падающие тесты** (`bun:test`, `Bun.spawnSync(["bash", script, ...])`, как
  `apps/agent/test/cgLaunch.test.ts`):
  - `prints DOCKER-USER rules for the session subnet` — вывод содержит
    `-A DOCKER-USER -i br-test -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`, по строке
    `-A DOCKER-USER -i br-test -d <net> -j DROP` для `10.0.0.0/8`, `172.16.0.0/12`,
    `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, и `COMMIT`;
  - `allows only cg-api to reach session port 8080 across the bridge` — есть
    `-A DOCKER-USER -i br-test -o br-test -s 172.29.0.5 -p tcp --dport 8080 -j RETURN` раньше
    `-A DOCKER-USER -i br-test -o br-test -j DROP`;
  - `blocks session access to host addresses` — есть
    `-A INPUT -i br-test -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT` раньше
    `-A INPUT -i br-test -j DROP`;
  - `rules cover ipv6 when the network has an ipv6 subnet` — с `--subnet6 fd00:cg::/64` есть
    фрагмент `# ip6tables` с `-d fc00::/7 -j DROP` и `-d fe80::/10 -j DROP`; без `--subnet6` —
    нет;
  - `rejects a malformed subnet with exit 2` — `--subnet 1.2.3` → код 2, stdout пуст.
- [ ] **Step 2:** `bun test deploy/test/sessionIsolation.test.ts` → FAIL (скрипта нет).
- [ ] **Step 3:** `deploy/session-isolation.sh` (bash, `set -euo pipefail`, шапка по-русски как у
  `deploy/build-steam-client.sh`: что делает, что владелец делает руками с sudo, как сохранить
  после перезагрузки — `iptables-persistent`/`netfilter-persistent save` на Debian/Ubuntu).
- [ ] **Step 4:** `bun test deploy/test/sessionIsolation.test.ts && bash -n deploy/session-isolation.sh` → PASS.
- [ ] **Step 5:** `deploy/check-session-isolation.sh`: по ssh, образ `SESSION_IMAGE` (по умолчанию
  `cg-session:550.163.01`), два временных контейнера в `cg-sessions` с
  `--entrypoint sleep … infinity`, метка `cg.isolation-check`, без GPU; из первого `curl -m 3`
  (TCP) к: шлюзу моста `:22`, LAN-адресу хоста (`ip route get 1.1.1.1` на хосте, `src`) `:22`,
  шлюзу LAN хоста `:80`, второму контейнеру `:8080` (во втором `python3 -m http.server 8080`),
  `cg-api:3000`, и `https://store.steampowered.com` (ожидается открыт). Контейнеры удаляются
  в `trap`. Ничего, кроме своих контейнеров с меткой, не трогает.
- [ ] **Step 6:** `bash -n deploy/check-session-isolation.sh`; запуск `./deploy/check-session-isolation.sh`
  на brofrong (GPU не нужен, слот не занимает) → таблица, код 1 (правил на brofrong нет —
  ожидаемо), контейнеров `cg.isolation-check` после выхода нет.
- [ ] **Step 7:** раздел README: зачем, `detect` → `print` → проверить глазами → применить с sudo
  (`iptables-restore -n`, `ip6tables-restore -n`) → сохранить → `check-session-isolation.sh` → код 0.
  Что делать, если `cg-api` пересоздан с другим IP (повторить `detect`/`print`).
- [ ] **Step 8: Коммит** `feat(deploy): правила изоляции контейнеров сессий для нового сервера и проверка`

### Task 2: Проба киоска на brofrong (throwaway)

Цель — ответить «да/нет» на §6.1 спеки до того, как писать образ. Файлы пробы — в
`spike/kiosk/` (помечены как проба), итог — раздел «Результаты» спеки.

**Files:**
- Create: `spike/kiosk/Dockerfile`, `spike/kiosk/README.md` (одна строка: проба плана 4, не прод)
- Modify: `docs/superpowers/specs/2026-10-27-kiosk-image-design.md` — раздел «Результаты»,
  подраздел «Проба киоска»

**Interfaces:**
- Produces (в «Результатах», для Task 7): закреплённый digest базы; работает ли zero-copy на 550;
  список пакетов, которых не хватило (Steam, i386, `python3-dbus`, системная шина, `xdotool`,
  `x11-utils`, `curl`, `procps`); где labwc читает конфиг и автостарт (`/etc/xdg/labwc/…` или
  другое — не `~/.config`: `.config` уходит в профиль игрока); как включён «без рабочего стола»
  (`START_LXQT=false` или иное имя в этой версии) и `SELKIES_WAYLAND_COMPOSITOR`; какие
  `SELKIES_*` переименованы; есть ли в этой версии передача файлов/буфер обмена и как
  выключаются; секунды от `docker run` до окна Steam у пробы и у `cg-session:550.163.01`.

- [ ] **Step 1:** `docker pull ghcr.io/selkies-project/selkies/base:latest-ubuntu26.04` на brofrong,
  записать digest; прочитать в образе (временный контейнер `--entrypoint cat`/`ls`, без GPU)
  `/etc/container-entrypoint.sh`, `/etc/selkies-entrypoint.sh`, `/etc/service/*/run`.
- [ ] **Step 2:** `spike/kiosk/Dockerfile`: `FROM …@<digest>`, 32-битные библиотеки NVIDIA и
  `ENV` Selkies как в `images/session/Dockerfile`, Steam, нужные пакеты, `cg-launch` +
  автостарт labwc, `cg-nm-stub` (+ системная шина, если её нет), конфиг labwc: без декораций,
  меню и панелей, окна во весь экран. Сборка на brofrong в `~/cg-kiosk-probe` (контекст —
  `spike/kiosk` + `images/session/*` + `nv/x/32` из `~/cg-session-image`), тег
  `cg-session:550.163.01-kiosk-probe`.
- [ ] **Step 3:** (слот свободен, время согласовано) временный контейнер с флагами `desktopSpec`
  (`--runtime nvidia --gpus all --shm-size 2g --security-opt no-new-privileges:true
  --tmpfs /dev/input:mode=1777,size=64k,nosuid,nodev,noexec`, GBM-проброс), `--network cg-sessions`,
  `-p 59001:59001/udp`, `SELKIES_WEBRTC_UDP_MUX_PORT=59001`, `CG_MODE=install`, пустой дом, имя
  `cg-kiosk-probe`, явный `--entrypoint` — entrypoint базы. Проверить и записать:
  - лог: `Zero-copy capture ... encoded in place on NVENC`;
  - `docker exec … dbus-send --system … NetworkManager … State` → `uint32 70`;
  - Steam стартовал, окно входа Steam видно: `xdotool search --onlyvisible --class steam` с
    окружением из процесса Steam;
  - `/proc/<steam>/environ`: `LD_PRELOAD` с интерпозером Selkies, `DISPLAY` Xwayland и
    `XAUTHORITY` (их берёт `cg-session-stage`; оконный менеджер с EWMH ему не нужен);
  - трансляция в браузере владельца (`ssh -L` на `:8080` контейнера, как в
    `images/session/README.md`, «Ручная проверка»): нет рабочего стола и панели, окно Steam во
    весь экран, мышь и клавиатура работают;
  - то же время до окна Steam у `cg-session:550.163.01` (тот же запуск, другой образ).
- [ ] **Step 4:** (только если владелец согласится) вход по QR в стриме пробы и `steam -applaunch 1966900`
  через окружение Steam — игра запускается, окно `steam_app_1966900` видно. Иначе — проверяется в
  Task 9.
- [ ] **Step 5:** убрать контейнер пробы; образ пробы оставить до Task 7.
- [ ] **Step 6:** «Результаты» в спеке; **стоп: итог владельцу**. Нет zero-copy или Steam не
  работает — дальше не идти, к владельцу с вариантами.
- [ ] **Step 7: Коммит** `spike(kiosk): проба Selkies base + labwc на драйвере 550`

### Task 3: Пробы ускорения на brofrong

Метод — как Task 6 в `2026-10-26-faster-session-start-design.md` («Ожидание сети»): живая сессия
владельца, внутри контейнера без root — `cg-steam-shutdown`, правка верхнего слоя, `steam -silent
-applaunch <appid>` с нужным окружением (из процесса сессии). Сессию держать живой: фиктивный
процесс с `AppId=<appid>` в командной строке на время перезапусков и обновление
`client_seen_at`/`last_input_at` тестовой строки. Этап и время — `cg-session-stage <appid>` раз в
секунду (если ветка экрана загрузки ещё не слита — скопировать скрипт в контейнер `docker cp`).

**Files:**
- Modify: `docs/superpowers/specs/2026-10-27-kiosk-image-design.md` — «Результаты», подраздел
  «Пробы ускорения»

**Interfaces:**
- Produces (для Task 8): по каждому варианту — секунды `prepare` (reaper → exe) и `loading` (exe →
  окно), 3 повтора, медиана; какие файлы префикса содержат SteamID64 или имя аккаунта (только пути
  и число совпадений, `grep -rlF`, значения не печатать); что пишет Proton в лог (`PROTON_LOG=1`)
  при готовом префиксе своей версии; куда pressure-vessel пишет копию runtime и сколько.

- [ ] **Step 1:** (разрешение владельца, слот свободен) сессия 20 Minutes Till Dawn от владельца;
  записать время этапов первого запуска агентом (база).
- [ ] **Step 2:** вариант «среда Linux»: убрать из верхнего слоя копии runtime
  (`steamapps/common/SteamLinuxRuntime_*/var/*`, найденные в upper), перезапуск — 3 раза как есть,
  3 раза с `PRESSURE_VESSEL_COPY_RUNTIME=0`; игра работает (картинка, звук) — отметить.
- [ ] **Step 3:** вариант «шаблон префикса»: после первого запуска скопировать
  `compatdata/1966900` в `/tmp/pfx-template` без `pfx/drive_c/users/steamuser` и `pfx/user.reg`;
  проверить шаблон на SteamID64/имя аккаунта (`grep -rlF`, только пути); затем 3 раза: удалить
  `compatdata/1966900`, вернуть шаблон + файлы игрока, перезапуск, время и лог Proton.
- [ ] **Step 4:** то же для Can of Wormholes (1295320) — шаги 2–3 по одному повтору, чтобы
  убедиться, что выводы не про одну игру.
- [ ] **Step 5:** остановить сессию как сайт (`stop_requested_at`), проверить, что контейнер и
  слои убраны (`docker ps -a --filter label=cg.session`, `SCRATCH_DIR` пуст).
- [ ] **Step 6:** «Результаты» + предложение (что внедрять, ожидаемая медиана). **Стоп: владельцу.**
  Если ≤ 40 с не получается и с обоими вариантами — к владельцу с цифрами.
- [ ] **Step 7: Коммит** `docs: результаты проб ускорения запуска (план 4)`

### Task 4: Ветка экрана загрузки в `main`

Ворота перед Task 5–9.

- [ ] **Step 1:** дождаться слова владельца, что `feat/…loading-screen…` слита в `main`
  (`git log main --oneline | grep -i "cg-session-stage"`).
- [ ] **Step 2:** `git merge main` в `feat/kiosk-image`; конфликтов быть не должно (до этого ветка
  меняет только `docs/`, `deploy/`, `spike/`).
- [ ] **Step 3:** `bun test` в `apps/agent`, `apps/orchestrator`, `packages/db` → PASS.

### Task 5: Слот освобождается только после остановки контейнера

**Files:**
- Modify: `packages/db/src/schema/sessions.ts` — столбец, индекс
- Create: миграция `packages/db/migrations/<ts>_slot_released_at/` (generate) и
  `<ts>_slot_released_backfill/` (`--custom`)
- Modify: `apps/orchestrator/src/SessionRepo.ts`, `apps/orchestrator/src/Scheduler.ts:160`,
  `apps/orchestrator/src/SessionRunner.ts` (`reconcile`, отчёты `Stopped`/`Failed`)
- Test: `packages/db/test/sessions.test.ts`, `apps/orchestrator/test/runner.test.ts` (новый
  `describe("slot release")`)

**Interfaces:**
- Produces: `sessions.slotReleasedAt: timestamptz("slot_released_at")`, `null` — слот может быть
  занят; индекс `sessions_held_worker_slot_idx` unique on `(worker_id, slot)` where
  `slot_released_at is null` (вместо `sessions_active_worker_slot_idx`).
- Produces (`SessionRepo.ts`):
  - `holdsSlot` — условие `slot is not null and slot_released_at is null`;
  - `releaseSlot(workerId: string, sessionId: string, now: Date): Effect<void, …, Db>` —
    только строка этого воркера с невыпущенным слотом;
  - `releaseStaleSlots(workerId: string, runningIds: ReadonlyArray<string>, now: Date)` — строки
    воркера в `ended`/`failed` с невыпущенным слотом, которых нет в `runningIds`.

Когда слот выпускается: отчёт `Stopped` (в т. ч. `profileSaved: false` — остановленный контейнер
слот не держит) и `Failed` (агент шлёт его после удаления контейнера) от воркера сессии —
независимо от состояния строки (`step` для терминальной строки ничего не делает); в `reconcile` —
`releaseStaleSlots` после цикла по активным сессиям. Таймауты оркестратора (`agentLost`) слот не
выпускают.

- [ ] **Step 1: Падающие тесты:**
  - db: `held slot blocks the same worker slot even when the session failed` (две строки `w`/0:
    первая `failed` с `slot_released_at` null → вставка второй падает), `released slot can be
    reused` (с `slot_released_at` — проходит). Прежний тест `same worker slot cannot host two
    active sessions` остаётся;
  - runner: `lost agent: failed session keeps its slot until the agent reconnects without it` —
    `SLOTS=1`, `s-old` `playing` на `w-a`/0 с давним `agentSeenAt`, tick → `failed`; `s-new`
    `queued` → `Scheduler.tick` → `s-new` всё ещё `queued`; `Connected(w-a, running: [])` →
    `s-old.slotReleasedAt` = now; `Scheduler.tick` → `s-new` `starting` слот 0;
  - runner: `container still running after failure: slot is released by Stopped` — reconnect с
    `running: [s-old]` → отправлен `StopSession(s-old)`, `s-new` `queued`; отчёт `Stopped(s-old)` →
    слот выпущен, `s-new` размещается;
  - runner: `Failed report releases the slot`; `StopFinished releases the slot (profile not saved
    too)`;
  - runner: `Stopped from another worker does not release the slot`;
  - runner: `just scheduled session keeps its slot on reconnect` — `starting` моложе
    `RECONCILE_GRACE_MS`, reconnect без неё → `slotReleasedAt` null.
- [ ] **Step 2:** `cd packages/db && bun run test`, `cd apps/orchestrator && bun run test` → новые FAIL.
- [ ] **Step 3:** (только после Task 4: иначе разойдётся цепочка `prevIds` в `snapshot.json` с
  миграциями `20261027075844_loading_stages` и `20261027075851_sessions_notify_stage` ветки экрана
  загрузки) схема + `bunx drizzle-kit generate --name slot_released_at`. Триггер
  `session_changed_update_trigger` не трогать: выпуск слота сайту не виден. Если всё же понадобится —
  брать за основу список `WHEN` из `20261027075851_sessions_notify_stage`. Затем
  `bunx drizzle-kit generate --custom --name slot_released_backfill` с
  `update sessions set slot_released_at = coalesce(ended_at, now()) where state in ('ended','failed') and slot is not null;`
- [ ] **Step 4:** `SessionRepo` (`holdsSlot`, `releaseSlot`, `releaseStaleSlots`), `Scheduler.placeOne`
  — `taken` по `holdsSlot` вместо `isActive`, `SessionRunner` — вызовы по правилам выше.
- [ ] **Step 5:** тесты пакетов `db` и `orchestrator` → PASS; `bun check` и `bun lint src` в обоих.
- [ ] **Step 6: Коммит** `fix(orchestrator): слот свободен только после остановки контейнера`

### Task 6: Скрипты образа без Plasma

**Files:**
- Create: `images/session/cg-session-exec`
- Modify: `images/session/cg-steam-shutdown`, `deploy/build-steam-client.sh` (второй цикл)
- Test: `apps/agent/test/cgSteamShutdown.test.ts`, `apps/agent/test/cgSessionExec.test.ts`

**Interfaces:**
- Produces: `cg-session-exec <команда> [аргументы…]` — `exec` команды с переменными
  `DISPLAY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS HOME USER LD_PRELOAD XAUTHORITY
  XDG_SESSION_TYPE` из `/proc/<pid>/environ` процесса сессии: клиент Steam
  (`pgrep -f 'ubuntu12_32/steam( |$)'`), если запущен, иначе композитор (`pgrep -xo labwc`, имя
  из Task 2). Нет ни того, ни другого — stderr `[cg-session-exec] no session process`, код 1.
  `CG_PROC_DIR` (по умолчанию `/proc`) — для тестов.
- Produces: `cg-steam-shutdown` — то же поведение и коды (0/1, 30 с), окружение — из процесса
  клиента Steam, без `plasmashell`.
- Consumes: Task 2 — имя процесса композитора.

- [ ] **Step 1: Падающие тесты** (фейковые `pgrep`/`steam` в `PATH`, фейковый `CG_PROC_DIR` с
  `<pid>/environ`, как `cgLaunch.test.ts`):
  - `cg-session-exec takes the environment from the Steam client`;
  - `cg-session-exec falls back to the compositor when Steam is not running`;
  - `cg-session-exec fails with 1 without a session process`;
  - `cg-session-exec passes only the session variables` (переменная `SECRET=x` из environ не
    попадает в окружение команды);
  - `cg-steam-shutdown exits 0 when the client is not running`;
  - `cg-steam-shutdown runs steam -shutdown with the client environment and waits for exit`;
  - `cg-steam-shutdown does not need plasmashell`.
- [ ] **Step 2:** `cd apps/agent && bun test test/cgSteamShutdown.test.ts test/cgSessionExec.test.ts` → FAIL.
- [ ] **Step 3:** скрипты; второй цикл `build-steam-client.sh` — `docker exec -d … cg-session-exec steam -silent`
  вместо разбора `plasmashell`; шапки и комментарии без Plasma.
- [ ] **Step 4:** тесты → PASS; `bash -n` всех трёх файлов.
- [ ] **Step 5: Коммит** `feat(session-image): окружение сессии из процесса Steam, без Plasma`

### Task 7: Образ-киоск

**Files:**
- Modify: `images/session/Dockerfile` (новая база и всё из Task 2), `images/session/.dockerignore`,
  `images/session/README.md` (описание, «Файлы», «Ручная проверка» нового образа)
- Create: `images/session/labwc/rc.xml`, `images/session/labwc/autostart` (путь установки — из
  Task 2)
- Delete: `images/session/cg-launch.desktop`
- Modify: `deploy/build-session-image.sh` — необязательный тег-суффикс
  (`./deploy/build-session-image.sh [ssh-хост] [суффикс]` → `cg-session:<ver>-<суффикс>`)
- Modify: `apps/agent/test/cgLaunch.test.ts` — комментарий про автостарт KDE

**Interfaces:**
- Consumes: Task 2 (digest, пакеты, пути labwc, имена переменных), Task 6 (`cg-session-exec`),
  `cg-session-stage` из `main`.
- Produces: `cg-session:550.163.01-kiosk` на brofrong с тем же контрактом (Global Constraints).

- [ ] **Step 1:** Dockerfile и конфиг labwc; `cg-launch` запускается автостартом labwc (окружение
  с интерпозером, Xwayland `DISPLAY`, сессионная шина); в образе нет терминала, файлового
  менеджера, браузера (`dpkg -l` в смоуке); передача файлов и буфер обмена Selkies выключены, если
  есть (Task 2).
- [ ] **Step 2:** `./deploy/build-session-image.sh brofrong kiosk` → образ собран; `cg-session:550.163.01`
  не изменился (`docker image inspect` id до/после).
- [ ] **Step 3: Смоук** (слот свободен, время согласовано) — как Task 2, шаг 3, но образ
  `-kiosk`: zero-copy в логе; NM-заглушка `uint32 70`; окно Steam видно `cg-session-exec xdotool
  search --onlyvisible --class steam`; `cg-session-stage 1966900` печатает `steam`/`login`;
  `LD_PRELOAD` Steam с интерпозером; `cg-steam-shutdown` → 0, клиент вышел;
  `cg-profile-pack --list` работает; в трансляции нет рабочего стола; окно Steam во весь экран и
  нажимается.
- [ ] **Step 4:** `cd apps/agent && bun test` → PASS.
- [ ] **Step 5: Коммит** `feat(session-image): образ-киоск на Selkies base + labwc вместо KDE`

### Task 8: Ускорение запуска (дополнение по итогам Task 3)

Одобрено владельцем 2026-10-28: цель 40 с пока снята (принимаем текущее время), делаем ровно две
вещи — шаблон префикса (8.1) и уборку зависшего контейнера (8.2); вариант A (pressure-vessel)
отброшен. 8.1 и 8.2 друг от друга не зависят и обе — после Task 7; образ сессии не меняется,
поэтому всё работает и с `-kde`, и с `-kiosk`.

### Task 8.1: Шаблон префикса Proton на игру

Решения (спека §4.3, «Пробы ускорения (2026-10-28)», отчёт Task 3):
- **Где лежит.** `<LIBRARY_DIR>/steamapps/compatdata/<appid>` — внутри lower тома `cg-s-<id>-apps`.
  Сессия видит его без единой правки запуска, пишет только в свой upper (copy-up), файлы игрока
  из профиля ложатся сверху тем же `putArchive`, что и сегодня. Копия в upper сессии отвергнута:
  375 МБ на каждый старт на общий NVMe — секунды и грязные страницы, то есть ровно то, на чём
  висит `sync()`. Отдельный overlay-том на `(appid, версия)` отвергнут: третий том, вложенное
  монтирование, правки `prepare`/`holdVolumes`/`unmarkVolatile`/`cleanup` и путей после
  перезапуска агента. Цена выбора: в lower один шаблон на игру (версия — в метке), а менять lower
  под живым overlay той же игры нельзя — замена только когда нет ни одного контейнера с
  `cg.app=<appid>` (иначе `deferred`, повтор при следующем поводе).
- **Ключ `(appid, версия Proton)`.** Proton — `steamapps/common/Proton - Experimental` библиотеки
  (им шли обе игры проб). Версия — первая строка его файла `version`
  (`1791989105 experimental-11.0-20261014`), она же пишется в метку шаблона
  `compatdata/<appid>/cg-template`. Метки нет или там другая строка — шаблон `stale`, его
  пересобирают. Пока не пересобран, сессии видят старый: Proton обновляет его в своём upper без
  создания префикса (`creation_sync_guard` есть, `sync()` не зовёт), так что это не хуже, чем без
  шаблона. Сам Proton в библиотеке не меняется (установщик не переносит обновления уже
  установленных приложений); если его сменили вручную — CLI для всех игр (README).
  Single-flight — по appid внутри агента (Proton один, ключ сводится к appid).
- **Как делается.** Не из сессии. Помощник из образа сессии (как у всех помощников; образ не
  меняется): без сети, без GPU, без входа в Steam и профиля, uid 1000. Слои — как у установщика:
  `installLayers(config, "pfx-<appid>")` (клиент — lower `STEAM_CLIENT_DIR`; apps — lower
  библиотека, upper в `INSTALL_SCRATCH_DIR`, на ФС библиотеки), смонтированные по тем же путям,
  что в сессии. Тогда пути Proton в `config_info`, ссылки шрифтов и диск `s:` совпадут с тем, что
  увидит сессия. Proton запускается через Steam Linux Runtime так же, как это делает Steam:
  `_v2-entry-point --verb=waitforexitandrun -- proton waitforexitandrun …`. `setup_prefix`
  создаёт префикс и делает оба своих `sync()` в помощнике, а не в сессии игрока. Готовый
  `compatdata/<appid>` переносится из upper через `rename` (одна ФС), как игра в `applyPromotion`.
  Сессия в библиотеку не пишет никогда.
- **Когда.** (1) После установки, до `InstallFinished`: ждём не больше `TEMPLATE_INSTALL_WAIT`
  (2 мин), чтобы первая же сессия игрока шла с шаблоном. Дольше — сборка продолжается в фоне, а
  сессия стартует без шаблона. (2) Лениво: после сессии, в которой был префикс
  (`compatdata/<appid>` в upper `apps`), если шаблона нет или он `stale` — уже после удаления её
  контейнера. (3) Вручную: `prefixTemplateCli.ts` (Task 9). Игры без `.exe` на глубине до 4
  пропускаются: нативным Linux-играм Proton не нужен.
- **Что внутри.** Весь префикс, который создал Proton, **включая** умолчания `pfx/user.reg` и
  `pfx/drive_c/users/steamuser` из `default_pfx`. Это отступление от формулировки «исключить
  steamuser и user.reg»: она была про префикс из сессии игрока, а этот шаблон собран без игрока
  (нет входа, нет сети, нет профиля). Без умолчаний новый игрок (первая сессия после установки —
  самый частый случай) получил бы префикс без HKCU и без `%USERPROFILE%`: при готовом
  `creation_sync_guard` Proton их не создаёт (`copy_pfx` в `setup_prefix` зовётся только без
  guard). Файлы игрока из профиля перекрывают умолчания: `user.reg` — целиком, `steamuser` — по
  файлам. Страховка: если в префиксе найден `steam_autocloud.vdf`, шаблон не переносится
  (`failed`). Следствие: `cg-profile-pack` (glob `compatdata/*/pfx`) положит в профиль умолчания и
  для игр с шаблоном, в которые игрок не играл, — килобайты на игру, не данные игрока.
- **`MachineGuid`** (`system.reg`) — общий у всех игроков игры на сервере до пересборки шаблона.
  Сегодня он новый в каждой сессии (префикс создаётся заново), так что постоянный общий не хуже; с
  аккаунтом он не связан. Свой GUID у игрока потребовал бы править `system.reg` (копия в upper) на
  каждом старте и хранить его в профиле — не делаем.
- **Без шаблона** (нет Proton или runtime в библиотеке, нет `INSTALL_SCRATCH_DIR`, мало места,
  сборка упала или отложена) — как сегодня: Proton создаёт префикс в сессии.

**Files:**
- Create: `apps/agent/src/PrefixTemplate.ts` — чтение Proton и шаблона, спецификация помощника,
  перенос, сервис `PrefixTemplates`
- Create: `apps/agent/src/prefixTemplateCli.ts` — разовая сборка для списка appid
- Create: `apps/agent/test/prefixTemplate.test.ts`
- Modify: `apps/agent/src/Installer.ts` (`finish`, `parseAppManifest` → реэкспорт),
  `apps/agent/src/steam/vdf.ts` (`parseAppManifest`), `apps/agent/src/SessionSupervisor.ts`
  (`finish`), `apps/agent/src/main.ts`
- Test: `apps/agent/test/installer.test.ts`, `apps/agent/test/supervisor.test.ts`
- Modify: `deploy/README.md` — раздел «Шаблоны префикса Proton»; строка `LIBRARY_DIR` в таблице
  каталогов; приёмка MVP-3, п. 6 (`compatdata/<appid>` с `cg-template` теперь в библиотеке есть)
- Modify: `docs/superpowers/specs/2026-10-27-kiosk-image-design.md` — «Результаты», подраздел
  «Шаблон префикса: проба сборки»

**Interfaces:**
- Consumes: `installLayers`, `prepare`, `removeVolumes`, `removeScratch`, `cleanup`, `STEAM_DIR`,
  `STEAMAPPS_DIR` (`Overlay.ts`); `helperSpec`, `runHelper` (`Helper.ts`); `tokenize`
  (`steam/vdf.ts`); `FreeSpace`, `hasFreeSpace` (`DiskSpace.ts`); `parseAppManifest` — перенести
  из `Installer.ts` в `steam/vdf.ts` (иначе цикл импорта `Installer` → `PrefixTemplate` →
  `Installer`), в `Installer.ts` оставить реэкспорт для его тестов.
- Produces (`apps/agent/src/PrefixTemplate.ts`):
  - `TEMPLATE_PROTON_DIR = "Proton - Experimental"`, `TEMPLATE_MARKER = "cg-template"`,
    `TEMPLATE_INSTALL_WAIT = Duration.minutes(2)`;
  - `interface ProtonTool { readonly dirName: string; readonly build: string; readonly runtimeDirName: string }`;
  - `readProtonTool(steamapps: string): ProtonTool | undefined` — `common/<TEMPLATE_PROTON_DIR>/version`
    (первая строка) и `toolmanifest.vdf` → `require_tool_appid` → `appmanifest_<id>.acf` →
    `installdir`; чего-то нет — `undefined`;
  - `templateDir(config: AgentConfigValues, appId: number): string` —
    `<LIBRARY_DIR>/steamapps/compatdata/<appId>`;
  - `templateState(dir: string, tool: ProtonTool): "fresh" | "missing" | "stale"`;
  - `hasWindowsExe(dir: string, depth?: number): boolean` (по умолчанию 4, ссылки не разыменовываются);
  - `playerDataIn(dir: string): ReadonlyArray<string>` — относительные пути `steam_autocloud.vdf`;
  - `templateLayers(config, appId: number): Overlays` = `installLayers(config, \`pfx-${appId}\`)`
    (остатки после падения агента убирает `Installer.reconcile`: метка `cg.install`);
  - `templateBuildSpec(config, appId: number, installDir: string, tool: ProtonTool): ContainerSpec`;
  - `promoteTemplate(built: string, target: string, trash: string): void` — `mkdir -p` родителя
    `target`; есть `target` — `rename(target, trash)`; затем `rename(built, target)`;
  - `type TemplateOutcome = "fresh" | "built" | "deferred" | "skipped" | "failed"`;
  - `interface PrefixTemplatesShape { readonly ensure: (appId: number) => Effect.Effect<TemplateOutcome> }`
    — никогда не падает: сбои уходят в лог и дают `failed`;
  - `PrefixTemplates = Context.Reference<PrefixTemplatesShape>("@cg/agent/PrefixTemplates", …)` —
    по умолчанию `ensure: () => Effect.succeed("skipped")` (как `FreeSpace`/`DownloadingBytes`:
    существующие тесты супервизора и установщика не меняются);
  - `prefixTemplatesLayer: Layer.Layer<PrefixTemplates, never, AgentConfig | DockerClient>`.
- Produces: `bun apps/agent/src/prefixTemplateCli.ts <appId>…` — по очереди `ensure`, строка
  `<appId> <outcome>` на каждый, код 1, если есть `failed` или неверный appid.

Спецификация помощника `templateBuildSpec` (значения для теста; argv уточняет проба, шаг 1):
`helperSpec` с `name: cg-i-pfx-<appId>-build`, `kind: "prefix-template"`, `user: "1000"`,
`mounts: mountsFor(templateLayers(config, appId))`, env:
`HOME=/home/ubuntu`, `SteamAppId`, `SteamGameId`, `STEAM_COMPAT_APP_ID` = `<appId>`,
`STEAM_COMPAT_DATA_PATH=<STEAMAPPS_DIR>/compatdata/<appId>`,
`STEAM_COMPAT_CLIENT_INSTALL_PATH=<STEAM_DIR>`,
`STEAM_COMPAT_INSTALL_PATH=<STEAMAPPS_DIR>/common/<installDir>`,
`STEAM_COMPAT_LIBRARY_PATHS=<STEAMAPPS_DIR>`,
`STEAM_COMPAT_TOOL_PATHS=<STEAMAPPS_DIR>/common/<dirName>:<STEAMAPPS_DIR>/common/<runtimeDirName>`,
`PRESSURE_VESSEL_VARIABLE_DIR=/tmp/cg-pv` (копия runtime — в слой контейнера помощника, а не
609 МБ в upper на RAID); entrypoint:
`[<STEAMAPPS_DIR>/common/<runtimeDirName>/_v2-entry-point, --verb=waitforexitandrun, --,
<STEAMAPPS_DIR>/common/<dirName>/proton, waitforexitandrun, C:\windows\system32\cmd.exe, /c, exit, 0]`.

`ensure(appId)` по шагам (каждый «нет» — исход без Docker, кроме оговорённого):
1. Уже идёт сборка этой игры — ждать её исход (`Deferred`, сама сборка — в scope сервиса:
   таймаут установщика её не прерывает; по завершении запись из `Map` удаляется).
2. Нет `installScratchDir` → `skipped`; `readProtonTool` → `undefined` → `skipped`; нет
   `appmanifest_<appId>.acf` или `installdir` в библиотеке → `skipped`; `!hasWindowsExe(common/<installdir>)`
   → `skipped`; `templateState` = `fresh` → `fresh`; мало места на ФС `INSTALL_SCRATCH_DIR`
   (`hasFreeSpace`, `MIN_FREE_GB`) → `skipped`.
3. `cleanup(templateLayers)` (остатки прошлой попытки; не вышло → `failed`) → `prepare` →
   `runHelper(templateBuildSpec, Effect.void)` → `removeVolumes`.
4. `built = <apps upper>/compatdata/<appId>`: нет `version` или `pfx/creation_sync_guard` →
   `failed`; `playerDataIn(built)` не пуст → `failed` (лог `Prefix template has player data`,
   только пути).
5. Записать `built/cg-template` = `tool.build + "\n"`.
6. `docker.listByLabel("cg.app")`: есть контейнер с `labels["cg.app"] === String(appId)` →
   `deferred`.
7. `promoteTemplate(built, templateDir(config, appId), <INSTALL_SCRATCH_DIR>/pfx-<appId>/old)` →
   `built`.
8. Всегда в конце (и при `failed`/`deferred`) — `cleanup(templateLayers)` с логом при сбое. Логи:
   `Prefix template built` (`appId`, `build`), `… deferred: app in use`, `… skipped` (`why`),
   `… build failed` (`error`).

- [ ] **Step 1: Проба сборки на brofrong** (GPU и слот не нужны; временный контейнер с явным
  `--entrypoint`, всё только чтение, кроме `/tmp` контейнера; `--rm`). Сначала на хосте:
  `grep -n "def setup_prefix\|creation_sync_guard\|os.sync()\|^CURRENT_PREFIX_VERSION"` по
  `/raid/cloud-gaming/library/steamapps/common/Proton - Experimental/proton` — подтвердить, что
  `copy_pfx` и `sync()` стоят только под `if not file_exists(self.creation_sync_guard…)`;
  `head -1 …/version`; `grep require_tool_appid …/toolmanifest.vdf` и `installdir` из
  `appmanifest_<этот id>.acf` (→ `<runtime>`) и `appmanifest_1966900.acf` (→ `<installdir>`);
  `grep -E "^(Dirty|Writeback):" /proc/meminfo`. Затем (`S=/home/ubuntu/.local/share/Steam`,
  `A=$S/steamapps`):
  ```sh
  docker run --rm --name cg-pfx-probe --label cg.probe=prefix-template --network none --user 1000 \
    --security-opt no-new-privileges:true \
    -v /raid/cloud-gaming/steam-client:$S:ro -v /raid/cloud-gaming/library/steamapps:$A:ro \
    -e HOME=/home/ubuntu -e SteamAppId=1966900 -e SteamGameId=1966900 -e STEAM_COMPAT_APP_ID=1966900 \
    -e STEAM_COMPAT_DATA_PATH=/tmp/cgp/1966900 -e STEAM_COMPAT_CLIENT_INSTALL_PATH=$S \
    -e STEAM_COMPAT_INSTALL_PATH="$A/common/<installdir>" -e STEAM_COMPAT_LIBRARY_PATHS=$A \
    -e STEAM_COMPAT_TOOL_PATHS="$A/common/Proton - Experimental:$A/common/<runtime>" \
    -e PRESSURE_VESSEL_VARIABLE_DIR=/tmp/cg-pv \
    --entrypoint bash cg-session:550.163.01 -c '<mkdir /tmp/cgp/1966900 /tmp/cg-pv; time argv
    из спецификации выше; echo rc=$?; ls -A /tmp/cgp/1966900 /tmp/cgp/1966900/pfx; head -1
    …/version; du -sh …; find … -name steam_autocloud.vdf | wc -l; ls …/pfx/drive_c/users>'
  ```
  (`STEAM_COMPAT_DATA_PATH` здесь в `/tmp`: в библиотеку только чтение; в агенте путь — тот же,
  что у сессии.) Ожидается: `rc=0`; набор как у шаблона проб (`version`, `config_info`,
  `tracked_files`, `pfx.lock`, `pfx/{creation_sync_guard, dosdevices, drive_c, system.reg,
  user.reg, userdef.reg, .update-timestamp}`); `version` = `11.0-100`; 0 файлов
  `steam_autocloud.vdf`; в `users` есть `steamuser`; время. Не вышло — попробовать
  `waitforexitandrun` → `run`, `cmd.exe …` → `wineboot.exe`; рабочий argv — в спецификацию
  `templateBuildSpec`. Не вышло никак — **стоп, к владельцу** (запасной путь: сбор из upper
  сессии после удаления её контейнера — отдельное решение). Итог (argv, время, `Dirty`, состав) —
  в «Результаты» спеки, подраздел «Шаблон префикса: проба сборки».
- [ ] **Step 2: Падающие тесты** `apps/agent/test/prefixTemplate.test.ts` (`bun:test`; библиотека,
  scratch и install-scratch — `mkdtemp`, как `installer.test.ts`; свой фейк Docker на
  `unusedDocker`: `wait cg-i-pfx-<id>-build` «играет Proton» — пишет в
  `<installScratch>/pfx-<id>/apps/upper/compatdata/<id>` файлы `version` (`11.0-100`),
  `pfx/creation_sync_guard`, `pfx/system.reg`, `pfx/user.reg`,
  `pfx/drive_c/users/steamuser/Documents/.keep`; помощник `rm` удаляет свои пути, как в
  `installer.test.ts`; в библиотеке — `common/Proton - Experimental/{version, toolmanifest.vdf}`
  (`"require_tool_appid" "1628350"`), `appmanifest_1628350.acf` (`installdir`
  `SteamLinuxRuntime_4`), `appmanifest_1966900.acf` (`installdir` `MinutesTillDawn`),
  `common/MinutesTillDawn/MinutesTillDawn.exe`):
  - `readProtonTool reads the build and the runtime from the library` →
    `{ dirName: "Proton - Experimental", build: "1791989105 experimental-11.0-20261014", runtimeDirName: "SteamLinuxRuntime_4" }`;
  - `readProtonTool without Proton or its runtime manifest is undefined`;
  - `templateState: missing without the dir or marker, stale for another build, fresh for this build`;
  - `build spec mounts the template layers at the session paths and runs Proton through the runtime offline`
    — `network: "none"`, `gpus: false`, `user: "1000"`, `labels["cg.helper"] = "prefix-template"`,
    `mounts` = `[{ volume: "cg-i-pfx-1966900-client", target: STEAM_DIR }, { volume: "cg-i-pfx-1966900-apps", target: STEAMAPPS_DIR }]`,
    env и entrypoint — ровно как в спецификации выше;
  - `ensure builds in the install scratch and renames the template into the library` → `built`;
    `<library>/steamapps/compatdata/1966900/cg-template` = `"1791989105 experimental-11.0-20261014\n"`;
    там же есть `pfx/creation_sync_guard`, `pfx/user.reg`, `pfx/drive_c/users/steamuser`
    (умолчания остаются); `<installScratch>/pfx-1966900` и `<scratch>/.install/pfx-1966900` нет;
    `listByLabel cg.app` — после `wait cg-i-pfx-1966900-build`;
  - `ensure replaces a stale template and keeps nothing of the old one` — до: метка `old-build\n`
    и файл `pfx/old-only`; после: метка новой сборки, `pfx/old-only` нет, исход `built`;
  - `ensure is single-flight per app` — два `ensure(1966900)` одновременно (`wait` закрыт
    `Deferred`), один `create cg-i-pfx-1966900-build`, оба исхода `built`;
  - `ensure defers the swap while a container of the app exists` — `listByLabel` отдаёт
    `cg-session-s1` с `cg.app=1966900` → `deferred`, `compatdata/1966900` в библиотеке нет,
    scratch убран;
  - `a container of another app does not defer the swap` — `cg.app=1295320` → `built`;
  - `template with steam_autocloud.vdf is not promoted` → `failed`, в библиотеке пусто, scratch
    убран;
  - `prefix without creation_sync_guard is not promoted` → `failed`;
  - `failed helper leaves the library untouched` (`helperExit` 1) → `failed`, слои убраны;
  - `fresh template, native game, no Proton or no INSTALL_SCRATCH_DIR: no Docker calls` — по
    исходу `fresh`/`skipped`/`skipped`/`skipped`, `dockerCalls` 0;
  - `not enough free space on the install scratch FS skips the build` (`FreeSpace` → 1 ГиБ при
    `minFreeGb` 20) → `skipped`, `dockerCalls` 0.
- [ ] **Step 3:** `cd apps/agent && bun test test/prefixTemplate.test.ts` → FAIL (модуля нет).
- [ ] **Step 4:** `apps/agent/src/PrefixTemplate.ts` — интерфейсы и `ensure` по шагам выше;
  `prefixTemplatesLayer` — `Layer.effect(PrefixTemplates, …)` со своим scope для форков сборок и
  `Map<number, Deferred<TemplateOutcome>>`. Шапка файла — по-русски, как у `Installer.ts`: что
  это, где лежит, почему lower, почему с умолчаниями, про `MachineGuid`.
- [ ] **Step 5:** `cd apps/agent && bun test test/prefixTemplate.test.ts` → PASS.
- [ ] **Step 6: Падающие тесты подключения** (фейк `PrefixTemplates` через
  `Effect.provideService(PrefixTemplates, …)` пишет `templates.ensure <appId>` в журнал вызовов
  фейка):
  - installer: `finished install asks for the prefix template before InstallFinished` — вызов
    `templates.ensure 1966900` после переноса (манифест цели уже в библиотеке), `InstallFinished`
    в отчётах после него;
  - installer: `slow template build does not hold InstallFinished longer than 2 minutes` —
    `ensure` = `Effect.never`; через 119 с `InstallFinished` нет, через 120 с есть;
  - installer: `failed install does not ask for a template`;
  - supervisor: `session that had a prefix asks for a template after its container is removed` —
    до `StopSession` создать `<scratch>/s1/apps/upper/compatdata/1794680`; в журнале
    `templates.ensure 1794680` после `remove cg-s-s1-cleanup`;
  - supervisor: `session without a prefix in its upper does not ask for a template`;
  - supervisor: `profile-unsaved session does not ask for a template` (контейнер оставлен).
- [ ] **Step 7:** `cd apps/agent && bun test test/installer.test.ts test/supervisor.test.ts` → новые FAIL.
- [ ] **Step 8:** подключение:
  - `Installer.finish` — после `applyPromotion`, до `current = undefined`/`InstallFinished`:
    `templates.ensure(job.appId)` с `Effect.timeoutOrElse({ duration: TEMPLATE_INSTALL_WAIT, orElse: () => Effect.succeed("pending") })`,
    исход — полем `prefixTemplate` в лог `Install finished`;
  - `SessionSupervisor.finish` — `protonUsed = existsSync(<apps upper>/compatdata/<appId>)` до
    остановки; после удаления контейнера и слоёв (ветка «профиль сохранён»), если `protonUsed` —
    `Effect.forkIn(templates.ensure(appId), scope)`;
  - `main.ts` — `Layer.provide(prefixTemplatesLayer)` сразу после `Layer.provide(Installer.layer)`
    (его видят и супервизор, и установщик);
  - `prefixTemplateCli.ts` — `BunRuntime.runMain`, слои `AgentConfig`, `DockerClient`,
    `prefixTemplatesLayer`; шапка: запускать в `cg-agent` (`docker exec cg-agent bun
    apps/agent/src/prefixTemplateCli.ts …`), только когда нет сессий и установок (имена
    помощника те же, что у агента).
- [ ] **Step 9:** `cd apps/agent && bun test && bun check && bun lint src` → PASS.
- [ ] **Step 10:** README: раздел «Шаблоны префикса Proton» — что и зачем (`sync()` при создании
  префикса, цифры из «Результатов»); где (`compatdata/<appid>`, метка `cg-template`); когда
  собирается (после установки, ждём ≤ 2 мин; после сессии с префиксом; CLI); что внутри
  (умолчания Proton, игрока нет, общий `MachineGuid`); как посмотреть
  (`cat …/compatdata/*/cg-template`, `docker logs cg-agent 2>&1 | grep "Prefix template"`); как
  пересобрать после смены Proton в библиотеке (CLI для всех `appmanifest_*.acf`; только без
  сессий и установок); как выбросить битый (как в «common без манифеста»: `mv` в
  `/raid/cloud-gaming/orphans/` без живых сессий этой игры); помощник завис в `sync()` —
  `docker ps -a --filter label=cg.helper`, установка ждёт его не дольше 2 мин, уберётся при
  следующем старте агента.
- [ ] **Step 11: Коммит** `feat(agent): шаблон префикса Proton на игру в общей библиотеке`

### Task 8.2: Агент добивает контейнер сессии, чья остановка зависла

Сейчас `finish` после сохранения профиля делает `stop` → `remove`. Если процесс в D-состоянии
(`sync()`), то `stop` падает (`did not receive an exit event`), затем `Abort(stop)` → `fail` →
`remove` тоже падает (только лог) → `Failed` «Не удалось остановить игровой сервер», и слот
выпускается. Контейнер остаётся навсегда: после перезапуска агента `adopt` считает остановленный
контейнер `profile-unsaved`.

Решения:
- **Повторы.** Первая попытка — как сейчас. Не вышло — повтор каждые `CLEANUP_RETRY` (30 с) до
  `CLEANUP_GIVE_UP` (60 мин; D-процессы проб висели 15–35 мин). Режим `remove` (профиль сохранён
  или контейнер не нужен): `remove` (`rm -f` = kill + remove) → `cleanup` (тома `cg-s-<id>-*` и
  `<SCRATCH_DIR>/<id>`); успех — оба. В `finish` перед первой попыткой, как сейчас, — штатный
  `stop` с `STOP_TIMEOUT_SEC` (его сбой больше не обрывает остановку): порядок вызовов в обычном
  случае не меняется. Режим `stop` (профиль не
  сохранён или `keep`): `stop` → `keepStopped`; контейнер и слои не удаляются никогда — правило
  `profile-unsaved` не меняется.
- **Слот.** Пока идут повторы, сессия остаётся в `sessions` агента: её видят heartbeat и
  `snapshot`, и слот держится (правило Task 5: `ended`/`failed` строка в heartbeat — слот занят).
  Убрали — сессия уходит из `sessions`, ближайший heartbeat без неё выпускает слот
  (`releaseStaleSlots`). Сдались через 60 мин — то же плюс `logError("session-container-stuck")`
  (`sessionId`, `container`, `mode`), дальше решает человек (README).
- **Что видит игрок.** Итог — сразу, а не через полчаса: агент шлёт свой обычный `Stopped`
  (`profileSaved` как есть) или `Failed` (своя причина) с новым необязательным полем
  `cleanupPending: true`. Сайт показывает обычный конец сессии вместо «Сохраняем прогресс…» на
  полчаса и вместо «Не удалось остановить игровой сервер» — профиль ведь сохранён. Оркестратор на
  `cleanupPending: true` слот не выпускает (его выпустит heartbeat). Новых текстов нет;
  `failReasons.stop` больше не используется — удалить.
- **Перезапуск агента во время повторов.** Сразу после сохранения профиля агент пишет метку
  `<SCRATCH_DIR>/<id>/profile-saved` (каталог агента, uid 1000; уходит вместе со scratch). Если
  при старте у контейнера `cg.session` (запущенного или нет) есть метка, его профиль уже сохранён:
  `adopt` берёт его в `sessions` и сразу идёт в режим `remove`, затем `Stopped` (`cloudSynced:
  false`, `profileSaved: true`; для уже `ended` строки `step` ничего не делает, слот выпускается).
  Без метки — всё как сейчас.

**Files:**
- Modify: `packages/rpc/src/agent.ts:199-207` — `cleanupPending: Schema.optional(Schema.Boolean)`
  у `Stopped` и `Failed`
- Modify: `apps/orchestrator/src/SessionRunner.ts` — ветки `Stopped`/`Failed` (`releaseSlot` только
  без `cleanupPending: true`)
- Modify: `apps/agent/src/SessionSupervisor.ts` — `settle`, метка, `finish`, `fail`, `adopt`;
  `failReasons.stop` удалить
- Test: `apps/agent/test/supervisor.test.ts` (новый `describe("stuck container")`; в фейке —
  `stopFails`, `removeFails`, `removeVolumeFails`: столько ближайших вызовов падают с
  `DockerError` «tried to kill container, but did not receive an exit event»),
  `apps/orchestrator/test/runner.test.ts` (`describe("slot release")`)
- Modify: `deploy/README.md` — раздел «Контейнер сессии не остановился»; в «Профиль не сохранён» —
  одна фраза: если `stop` завис, агент повторяет его, и слот держится до остановки

**Interfaces:**
- Produces (`@cg/rpc`): `Stopped`/`Failed` с необязательным `cleanupPending?: boolean`; нет поля
  или `false` — как сегодня.
- Produces (`SessionSupervisor.ts`): `CLEANUP_RETRY = Duration.seconds(30)`,
  `CLEANUP_GIVE_UP = Duration.minutes(60)`, `PROFILE_SAVED_MARKER = "profile-saved"`,
  `profileSavedMarker(config: AgentConfigValues, sessionId: string): string` (=
  `<SCRATCH_DIR>/<id>/profile-saved`); внутренний
  `settle(session: Session, mode: "remove" | "stop", report: Extract<AgentReport, { _tag: "Stopped" | "Failed" }>): Effect<void>`
  — первая попытка удалась: `sessions.delete`, затем `report`; не удалась: `{ ...report,
  cleanupPending: true }`, повторы, затем `sessions.delete`.
- Если 8.1 уже сделана: вызов `templates.ensure` из `finish` переносится в `settle` (после
  успешного режима `remove`, только если `protonUsed`).

- [ ] **Step 1: Падающие тесты** (агент, `describe("stuck container")`; время — `h.tick`):
  - `hung stop after a saved profile: Stopped with cleanupPending, kill and remove retried every 30 s`
    — профиль v7, `stopFails` 1, `removeFails` 2; после `StopSession`: отчёт `Stopped { cloudSynced: false, profileSaved: true, cleanupPending: true }`,
    `snapshot` содержит `s1`, `existsSync(<scratch>/s1/profile-saved)`; `tick 30 s` → `Heartbeat { sessionIds: ["s1"] }`;
    ещё `tick 30 s` → в журнале `stop cg-session-s1 15` один раз, `remove cg-session-s1` три раза, затем `removeVolume cg-s-s1-client`,
    `removeVolume cg-s-s1-apps`, помощник `cg-s-s1-cleanup`; `snapshot` `[]`; следующий heartbeat —
    `sessionIds: []`; второго `Stopped` нет;
  - `layer cleanup failure keeps the session until the layers are gone` — `removeVolumeFails` 1 →
    `Stopped` с `cleanupPending: true`; через 30 с тома и scratch убраны, `snapshot` `[]`;
  - `stuck container is given up after 60 minutes` — `removeFails` = `Infinity`; через 59 мин
    `snapshot` всё ещё `[s1]`, через 60 мин `[]`, в логе `session-container-stuck`;
  - `profile-unsaved session with a hung stop retries stop only and never removes` — `putFail`,
    `stopFails` 2 → `Stopped { profileSaved: false, cleanupPending: true }`; через 60 с — `unmarked("s1")`;
    `remove cg-session-s1` в журнале нет; `snapshot` `[]`;
  - `failed session whose container cannot be removed reports Failed with cleanupPending` —
    Selkies не отвечает, `removeFails` 1; через 120 с `Failed { reason: failReasons.streamTimeout, cleanupPending: true }`;
    через 30 с — `remove cg-session-s1` и слои, `snapshot` `[]`;
  - `agent start removes a stopped session container whose profile was saved` — `existing`:
    остановленный `cg-session-s9` с метками (`cg.session` s9, `cg.user` u1, `cg.base-version` 7,
    `cg.slot` 1, `cg.app` 1794680) и файл `<scratch>/s9/profile-saved` → `removedWithLayers("s9")`,
    отчёт `Stopped { sessionId: "s9", cloudSynced: false, profileSaved: true }`, `unmark` нет;
  - `agent start removes a running session container whose profile was saved` — то же с
    `running: true`: `exec … cg-profile-pack` нет (профиль не снимается второй раз);
  - прежние `startup unmarks stopped session containers` и `stop saves profile then removes
    container and layers` проходят без правок (без метки и без сбоев — всё как было).
- [ ] **Step 2: Падающие тесты** (оркестратор, `describe("slot release")`):
  - `Stopped with cleanupPending keeps the slot until a heartbeat without the session` — `SLOTS=1`,
    `s-old` `stopping` на `w-a`/0; отчёт `Stopped(s-old, profileSaved: true, cleanupPending: true)`
    → `s-old` `ended`, `slotReleasedAt` null; `s-new` `queued` → `Scheduler.tick` → `queued`;
    `Heartbeat(w-a, [s-old])` → null; `Heartbeat(w-a, [])` → `slotReleasedAt` = now;
    `Scheduler.tick` → `s-new` `starting`, слот 0;
  - `Failed with cleanupPending keeps the slot until a heartbeat without the session` — то же для
    `Failed`, `s-old` → `failed` с причиной отчёта.
- [ ] **Step 3:** `cd apps/agent && bun test test/supervisor.test.ts`,
  `cd apps/orchestrator && bun run test` → новые FAIL.
- [ ] **Step 4:** `@cg/rpc` — поле; `SessionRunner` — условие у `releaseSlot` в обеих ветках
  (комментарий: «контейнер ещё убирается — слот выпустит heartbeat без сессии»).
- [ ] **Step 5:** `SessionSupervisor`: `settle` по решениям выше (повторы — `Effect.sleep(CLEANUP_RETRY)`
  в цикле, срок — по `Clock.currentTimeMillis`); `finish`: после успешного `saveProfile` — метка
  (`writeFileSync`, сбой — только предупреждение), `docker.stop(…, STOP_TIMEOUT_SEC)` со сбоем в
  лог, затем `settle(session, "remove", Stopped…)`;
  профиль не сохранён — `settle(session, "stop", Stopped…)`. `fail`: `keep` → `settle(…, "stop", Failed…)`,
  `created` → `settle(…, "remove", Failed…)`, ветка «контейнер не наш» не меняется. `adopt`:
  метка есть → `register` (`phase: "stopping"`, `created: true`) и `forkIn(settle(…, "remove", Stopped…))`
  до проверок «остановлен/запущен». Шапку файла и комментарий `finish` поправить.
- [ ] **Step 6:** `cd apps/agent && bun test && bun check && bun lint src`;
  `cd apps/orchestrator && bun run test && bun check && bun lint src`; `cd packages/rpc && bun check`
  → PASS.
- [ ] **Step 7:** README: раздел «Контейнер сессии не остановился (`docker stop` завис)» —
  признак (`Session container cleanup failed, retrying` в логе агента, контейнер
  `cg-session-<id>` есть, а сессия уже `ended`/`failed`); что делает агент (повтор каждые 30 с,
  слот держится, игрок уже видит конец сессии; профиль сохранён — метка `profile-saved`);
  перезапуск агента такой контейнер уберёт; после `session-container-stuck` — найти процесс в D
  (`ps -eo pid,stat,wchan:32,cmd | awk '$2 ~ /D/'`), дождаться его выхода и
  `docker restart cg-agent` (метка есть — агент удалит контейнер со слоями). Предупреждение про
  установки из «Профиль не сохранён», п. 1, действует и здесь.
- [ ] **Step 8: Коммит** `fix(agent): агент добивает контейнер сессии, чья остановка зависла`

### Task 9: Переключение brofrong на киоск, замер, проверка владельцем

**Files:**
- Modify: `deploy/README.md` — раздел «Смена образа сессии: перетег и откат»; «Клиент Steam:
  пересборка шаблона» без Plasma
- Modify: `docs/superpowers/specs/2026-10-27-kiosk-image-design.md` — «Результаты», итоговый замер

- [ ] **Step 1:** (слово владельца, нет живых `cg.session`/`cg.install`) деплой ветки по
  `deploy/README.md` (оркестратор со слотом, агент — тот же контракт); запрос
  `select count(*) from sessions where state in ('ended','failed') and slot is not null and slot_released_at is null`
  → `0`.
- [ ] **Step 2:** перетег (ветка экрана загрузки к этому времени уже пересобрала
  `cg-session:550.163.01` со своим скриптом и сохранила прежний как `-prev2` — его не трогать):
  `docker tag cg-session:550.163.01 cg-session:550.163.01-kde`,
  `docker tag cg-session:550.163.01-kiosk cg-session:550.163.01`.
- [ ] **Step 3:** `./deploy/build-steam-client.sh` (сервис простаивает) — шаблон собран новым
  образом.
- [ ] **Step 4:** шаблоны префикса для уже установленных игр (Task 8.1; сервис простаивает, нет
  `cg.session`/`cg.install`):
  `ssh brofrong 'docker exec cg-agent bun apps/agent/src/prefixTemplateCli.ts 1966900 1295320 1318690 1794680 1296610 2379780'`
  → по строке `<appid> built|fresh|skipped`, нет `failed` (неустановленная игра или игра без
  `.exe` — `skipped`); `ssh brofrong 'head -1 /raid/cloud-gaming/library/steamapps/compatdata/*/cg-template'`
  — у каждой `built` та же строка, что в `…/common/Proton - Experimental/version`; время сборки
  каждой (лог `Prefix template built`) — в «Результаты».
- [ ] **Step 5:** сессия владельца стартует; если нет — сразу откат:
  `docker tag cg-session:550.163.01-kde cg-session:550.163.01` и прежний шаблон (если менялся —
  `build-steam-client.sh` с прежним образом).
- [ ] **Step 6:** (разрешение владельца) `./deploy/measure-session-start.sh <userId> 1295320 3` и
  `… 1966900 3` → медиана `visible` по каждой; в «Результаты» рядом с «Пробами ускорения»
  (ожидаемо `prepare` ~17 с на свободном хосте и без минутных хвостов на занятом). Порог 40 с
  владелец 2026-10-28 снял — записать как есть. 8.2 на сервере не воспроизводится (зависание не
  вызвать) — проверено тестами; при первом случае сверить лог с README.
- [ ] **Step 7:** ручная проверка владельцем в браузере: нет рабочего стола; картинка 60 fps;
  клавиатура, мышь, геймпад, звук; облачные сохранения (`Upload complete` в `cloud_log.txt`);
  повторный запуск — сохранения на месте; окно Steam, если появится, нажимается.
- [ ] **Step 8: Коммит** `docs: замер и проверка образа-киоска на brofrong`

### Task 10: Установка для нового игрока на тестовом аккаунте

Когда владелец заведёт бесплатный аккаунт Steam и второй аккаунт сайта (вход по email).

- [ ] **Step 1:** выбрать с владельцем небольшую бесплатную игру, которой нет в библиотеке
  (`ls <LIBRARY_DIR>/steamapps/appmanifest_<appid>.acf` — нет), игрок добавляет её в свой Steam.
- [ ] **Step 2:** вход в Steam по QR на сайте → «Играть» → установка → игра запускается →
  повторный запуск без QR. Если игра под Proton: в логе агента `Install finished` с
  `prefixTemplate: "built"` (или `pending`), есть `compatdata/<appid>/cg-template`; первая сессия
  нового игрока (своих файлов префикса в профиле нет — работают умолчания шаблона) запускает игру
  и сохраняет прогресс, повторный запуск — прогресс на месте.
- [ ] **Step 3:** `docker logs cg-agent 2>&1 | grep -c "Seeded Steam login was not accepted"` → `0`
  за время проверки; в логах агента и оркестратора нет имени тестового аккаунта (`grep -c`,
  значение не печатать).
- [ ] **Step 4:** результат — в «Результаты» спеки; если упало — `superpowers:systematic-debugging`,
  исправление с тестом в этой ветке.
- [ ] **Step 5: Коммит** `docs: проверка установки с аккаунта нового игрока`
