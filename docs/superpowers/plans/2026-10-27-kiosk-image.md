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
  (1295320) и 20 Minutes Till Dawn (1966900) на brofrong.
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

После одобрения владельцем предложения из Task 3 — дописать в этот план задачи 8.x тем же навыком
(`superpowers:writing-plans`): файлы, интерфейсы и тесты для выбранных вариантов (например,
окружение pressure-vessel в образе; шаблон префикса: кто пишет — агент, single-flight на
`(appid, версия Proton)`, каталог рядом и `rename`, никаких данных игрока, сессия в библиотеку не
пишет). Дополнение — отдельным коммитом в этот файл, потом реализация. Без одобрения владельца
Task 8 не начинать.

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
- [ ] **Step 4:** сессия владельца стартует; если нет — сразу откат:
  `docker tag cg-session:550.163.01-kde cg-session:550.163.01` и прежний шаблон (если менялся —
  `build-steam-client.sh` с прежним образом).
- [ ] **Step 5:** (разрешение владельца) `./deploy/measure-session-start.sh <userId> 1295320 3` и
  `… 1966900 3` → медиана `visible` по каждой; в «Результаты».
- [ ] **Step 6:** ручная проверка владельцем в браузере: нет рабочего стола; картинка 60 fps;
  клавиатура, мышь, геймпад, звук; облачные сохранения (`Upload complete` в `cloud_log.txt`);
  повторный запуск — сохранения на месте; окно Steam, если появится, нажимается.
- [ ] **Step 7: Коммит** `docs: замер и проверка образа-киоска на brofrong`

### Task 10: Установка для нового игрока на тестовом аккаунте

Когда владелец заведёт бесплатный аккаунт Steam и второй аккаунт сайта (вход по email).

- [ ] **Step 1:** выбрать с владельцем небольшую бесплатную игру, которой нет в библиотеке
  (`ls <LIBRARY_DIR>/steamapps/appmanifest_<appid>.acf` — нет), игрок добавляет её в свой Steam.
- [ ] **Step 2:** вход в Steam по QR на сайте → «Играть» → установка → игра запускается →
  повторный запуск без QR.
- [ ] **Step 3:** `docker logs cg-agent 2>&1 | grep -c "Seeded Steam login was not accepted"` → `0`
  за время проверки; в логах агента и оркестратора нет имени тестового аккаунта (`grep -c`,
  значение не печатать).
- [ ] **Step 4:** результат — в «Результаты» спеки; если упало — `superpowers:systematic-debugging`,
  исправление с тестом в этой ветке.
- [ ] **Step 5: Коммит** `docs: проверка установки с аккаунта нового игрока`
