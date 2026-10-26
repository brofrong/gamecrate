# Запуск игры быстрее — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Запуск уже установленной игры занимает ≤ 60 с (медиана трёх запусков на brofrong)
вместо 142 с.

**Architecture:** одноразовые overlay-слои клиента Steam монтируются с `volatile`, тогда
copy-up рантайма pressure-vessel идёт без fsync. Если контейнер остаётся остановленным со слоями
(`profile-unsaved`), агент после остановки:
- делает `sync` файловой системы scratch;
- снимает метку ядра `work/incompat`, иначе тома нельзя смонтировать повторно.

Свежесть кэша `appinfo.vdf` и ожидание сети в этом плане только измеряются и исследуются. Механизм
кэша получит отдельный план по итогам замера (спека §4.2).

**Tech Stack:** Bun, Effect 4.0.5, Docker Engine API (local volume driver, `type=overlay`),
Linux 6.12 overlayfs, bash.

**Spec:** `docs/superpowers/specs/2026-10-26-faster-session-start-design.md`

## Global Constraints

- `volatile` — у слоёв сессии `client` и `apps` и у слоя установщика `client`. У слоя
  установщика `apps` **нет**.
- Метка ядра: `<workdir>/work/incompat` (внутри — `volatile`). Её снимает только помощник от root
  (`work/work` — root, права 000).
- Контейнер `profile-unsaved` после остановки агентом снова запускается `docker start` без ручных
  шагов, как в `deploy/README.md` §«Профиль не сохранён».
- Цель замера: от вставки строки `sessions` (`queued`) до `play_segments.started_at`, медиана трёх
  запусков. Игрок с профилем и входом, слот свободен, установок нет.
- В скриптах замера время — `date +%s%N` и арифметика shell/awk; `bc` на brofrong нет.
- brofrong: без sudo, без изменения настроек хоста и перезагрузки, без `docker * prune`. Чужие
  контейнеры, тома, сети и образы не трогать. Временные контейнеры — только с явным
  `--entrypoint`. Деплой — только когда нет контейнеров `cg.session`/`cg.install`.
- Не читать и не печатать `.env`. Токен и имя аккаунта Steam не попадают в вывод скриптов.
  Логи Steam, скопированные с контейнера, удаляются в конце замера.
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Агент упал между остановкой контейнера `profile-unsaved` и снятием метки. После перезапуска
  агента `docker start` такого контейнера всё равно должен работать: при старте агент снимает
  метку у всех остановленных `cg.session`. Тест — Task 3, Step 1, `startup unmarks stopped
  session containers`.
- Снятие метки не удалось (помощник вышел с ошибкой). Сессия всё равно завершается
  `Stopped{profileSaved:false}`, контейнер и слои остаются, в логе предупреждение. Тест — Task 3,
  Step 1, `failed unmark keeps the container and still reports Stopped`.
- Сбой после стрима (`fail` с `keep`) — тот же путь, метка снимается. Тест — Task 3, Step 1,
  `failure after stream ready unmarks kept layers`.
- Слои установщика `apps` не получили `volatile` по ошибке через общий код. Тест — Task 2, Step 1,
  `installLayers: volatile client, durable apps`.
- Уборка осиротевших слоёв с меткой `incompat` внутри: `rm -rf` от root удаляет и её. Это
  проверяется на brofrong в Task 4, Step 3.

---

### Task 1: Проверка поведения `volatile` на brofrong (без кода продукта)

Нужно подтвердить три допущения, на которых стоят Task 2–3. Если хоть одно не подтвердится —
остановиться и вернуться к владельцу с фактами, Task 2–3 не начинать.

1. После монтирования с `volatile` в `<work>/work/incompat/volatile` появляется метка.
2. Остановка контейнера размонтирует его тома `local`.
3. После удаления метки `docker start` того же контейнера монтирует тома снова.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-faster-session-start-design.md` — новый раздел
  «Результаты» в конце.

- [ ] **Step 1: Подготовить стенд в своём каталоге**

На brofrong, всё с префиксом `cgvolcheck`:
- каталог `/home/brofrong/cgvolcheck/{lower,upper,work}`, в `lower` — файл `a`;
- том `docker volume create --driver local --opt type=overlay --opt device=overlay --opt o=lowerdir=…/lower,upperdir=…/upper,workdir=…/work,volatile --label cg.check=volatile cgvolcheck`;
- контейнер `docker create --name cgvolcheck --network none --entrypoint sh -v cgvolcheck:/mnt <SESSION_IMAGE> -c 'cat /mnt/a >/mnt/b; sleep 2'`.

`SESSION_IMAGE` взять из `docker inspect cg-agent` (переменная окружения), не из `.env`.

- [ ] **Step 2: Прогнать три проверки**

- `docker start -a cgvolcheck`.
- После выхода:
  - `grep cgvolcheck /proc/mounts` → пусто (том размонтирован);
  - `ls -la` метки — через `docker run --rm --user 0 --network none --entrypoint ls -v /home/brofrong/cgvolcheck:/c <SESSION_IMAGE> -la /c/work/work/incompat` → есть `volatile`.
- `docker start -a cgvolcheck` → ожидается ошибка монтирования.
- `rm -rf /c/work/work/incompat` тем же помощником от root, затем `docker start -a cgvolcheck` →
  успех.

- [ ] **Step 3: Убрать стенд и проверить уборку**

- `docker rm cgvolcheck`;
- `docker volume rm cgvolcheck`;
- помощником от root `rm -rf /c/upper /c/work /c/lower`;
- `rmdir /home/brofrong/cgvolcheck`.

Проверить, что не осталось ничего с `cgvolcheck` в `docker ps -a` и `docker volume ls`.

- [ ] **Step 4: Записать результат в спеку и закоммитить**

Раздел «Результаты» → «Проверка `volatile` (Task 1)»: три факта, текст ошибки повторного
монтирования.

```bash
git add docs/superpowers/specs/2026-10-26-faster-session-start-design.md
git commit -m "docs: проверка overlay volatile на brofrong"
```

### Task 2: `volatile` на одноразовых слоях

**Files:**
- Modify: `apps/agent/src/DockerClient.ts` (`OverlayVolumeSpec`, `volumeBody`)
- Modify: `apps/agent/src/Overlay.ts` (`Layer`, `layers`, `sessionLayers`, `installLayers`,
  `prepare`, комментарий в шапке)
- Test: `apps/agent/test/overlay.test.ts`, `apps/agent/test/dockerClient.test.ts`,
  `apps/agent/test/installer.test.ts` (ожидания `createVolume`)

**Interfaces:**
- Produces:
  - `OverlayVolumeSpec.overlay.volatile: boolean`;
  - `Layer.volatile: boolean`;
  - `layers(config, { roots, prefix, id, labels, volatile: { client: boolean; apps: boolean } })`.
- Task 3 читает `Layer.volatile` и `Layer.work`.

- [ ] **Step 1: Написать падающие тесты**

В `overlay.test.ts`:
- `createVolume body carries overlay options`: при `volatile: false` строка `o` прежняя.
- Новый тест `createVolume body adds volatile`: при `volatile: true`
  `o === "lowerdir=/lib/steamapps,upperdir=/scratch/s1/apps/upper,workdir=/scratch/s1/apps/work,volatile"`.
- `prepare makes upper/work dirs and labelled overlay volumes`: у обоих томов сессии
  `overlay.volatile === true`.
- Новый тест `installLayers: volatile client, durable apps`: у `installLayers(config, "j1")`
  `client.volatile === true`, `apps.volatile === false`.

Поправить ожидания `createVolume` в `dockerClient.test.ts` и `installer.test.ts` под новое поле.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd apps/agent && bun test test/overlay.test.ts`
Expected: FAIL — нет поля `volatile`, в `o` нет `,volatile`.

- [ ] **Step 3: Реализовать**

- `volumeBody` дописывает `,volatile` к `o`, когда `spec.overlay.volatile`.
- `layers` берёт флаг слоя из `options.volatile[name]`, `prepare` передаёт `layer.volatile` в
  `createVolume`.
- `sessionLayers`: `{ client: true, apps: true }`; `installLayers`: `{ client: true, apps: false }`.
- Комментарий у `installLayers`: почему `apps` без `volatile` — upper `rename`-ом уходит в общую
  библиотеку, после сбоя хоста без fsync там была бы битая игра.

- [ ] **Step 4: Проверить**

Run: `cd apps/agent && bun test && bun check && bun lint src`
Expected: все тесты PASS, проверки без ошибок.

- [ ] **Step 5: Коммит**

```bash
git add apps/agent/src/DockerClient.ts apps/agent/src/Overlay.ts apps/agent/test
git commit -m "feat(agent): одноразовые слои клиента Steam монтируются с volatile"
```

### Task 3: Снятие метки `volatile` у оставленных контейнеров

**Files:**
- Modify: `apps/agent/src/Overlay.ts` (новая `unmarkVolatile`)
- Modify: `apps/agent/src/SessionSupervisor.ts`:
  - `finish` — ветка `profile-unsaved`;
  - `fail` — ветка `keep`;
  - `stop` — неизвестный контейнер без меток профиля;
  - `adopt` — остановленные контейнеры при старте.
- Modify: `deploy/README.md` §«Профиль не сохранён»
- Test: `apps/agent/test/overlay.test.ts`, `apps/agent/test/supervisor.test.ts`

**Interfaces:**
- Consumes: `Layer.volatile`, `Layer.work`, `Overlays.scratch` (Task 2).
- Produces: `unmarkVolatile(overlays: Overlays): Effect<void, OverlayError, AgentConfig | DockerClient>`.

- [ ] **Step 1: Написать падающие тесты**

В `overlay.test.ts`, тест `unmarkVolatile syncs scratch and removes incompat markers with one root helper`
для `sessionLayers(config(), "s1")` при существующем `<scratch>/s1`:
- вызовы `remove/create/start/wait/remove cg-s-s1-unmark`;
- спецификация помощника: `labels: { "cg.helper": "unmark" }`, `user: "0"`,
  `binds: [`${scratch}:${scratch}`]`, `network: "none"`;
- `entrypoint`:
  `["sh", "-c", 'sync -f "$1" && shift && rm -rf -- "$@"', "unmark", `${scratch}/s1`, `${scratch}/s1/client/work/work/incompat`, `${scratch}/s1/apps/work/work/incompat`]`.

Ещё два теста в `overlay.test.ts`:
- `unmarkVolatile skips non-volatile layers` — для `installLayers` в списке только
  `…/client/work/work/incompat`;
- `unmarkVolatile without a scratch dir runs nothing` — вызовов нет.

В `supervisor.test.ts`:
- В существующих `profile ${failure} failure keeps container` и
  `profile archive over 200 MiB…`:
  - после `stop cg-session-s1 15` идут вызовы помощника `cg-s-s1-unmark`;
  - `calls.at(-1)` → `"remove cg-s-s1-unmark"`;
  - тома и `cg-s-s1-cleanup` по-прежнему не трогаются.
- `failure after stream ready unmarks kept layers` — сбой в фазе `ready` с `keep`: после
  `stop` вызовы `cg-s-s1-unmark`, контейнер не удаляется.
- `failed unmark keeps the container and still reports Stopped`:
  - помощник `cg-s-s1-unmark` выходит с кодом 1;
  - отчёты — `Stopped{profileSaved:false}`;
  - в логе предупреждение `Unmarking kept session layers failed`;
  - `remove cg-session-s1` нет.
- `startup unmarks stopped session containers`:
  - при старте `listByLabel("cg.session")` отдаёт остановленный `cg-session-old` с
    `cg.session=old`;
  - в вызовах `create cg-s-old-unmark`, контейнер не удаляется и не запускается.
- Новый тест `StopSession for an unknown container without profile labels unmarks after stop`:
  - `inspect` отдаёт запущенный `cg-session-x` только с меткой `cg.session=x`, без меток
    пользователя и базы профиля;
  - `StopSession x` → `stop cg-session-x 15`, затем вызовы `cg-s-x-unmark`;
  - отчёт — `Stopped{profileSaved:false}`.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd apps/agent && bun test test/overlay.test.ts test/supervisor.test.ts`
Expected: FAIL — нет `unmarkVolatile`, нет вызовов `cg-s-*-unmark`.

- [ ] **Step 3: Реализовать `unmarkVolatile` в `Overlay.ts`**

Устроена как `removeScratch`:
- та же проверка `ownDir`;
- только существующие каталоги `scratch`;
- один `runHelper` с `name: \`${prefix}-${id}-unmark\``, `kind: "unmark"`, `user: "0"`,
  `binds` корней;
- `sync -f` по первому существующему каталогу `scratch`: все слои сессии — на одной ФС.

Метки — `join(layer.work, "work", "incompat")` только у слоёв с `volatile`. Нет таких слоёв или
каталогов — помощник не запускается.

- [ ] **Step 4: Вызвать её в `SessionSupervisor.ts`**

Одна локальная функция `keepStopped(sessionId, overlays)`:
- зовёт `unmarkVolatile`;
- ошибку логирует `Effect.logWarning("Unmarking kept session layers failed", { sessionId, error })`
  и не пробрасывает.

Где зовётся:
- в `finish` и `fail` (`keep`) — после успешного `docker.stop`;
- в `stop` для контейнера без меток профиля — после `docker.stop`, слои
  `sessionLayers(config, sessionId)`;
- в `adopt` — для каждого `!container.running` с допустимым `cg.session`, рядом с
  предупреждением `Keeping stopped session container`.

- [ ] **Step 5: README**

В `deploy/README.md` §«Профиль не сохранён» после описания, что контейнер остаётся:
- слои сессии монтируются с `volatile`;
- агент после остановки сам сбрасывает их на диск и снимает метку ядра;
- если `docker start cg-session-<id>` всё же падает с ошибкой overlay про `volatile` —
  `docker restart cg-agent` (при старте агент снимает метку у всех остановленных сессий), затем
  повторить. Предупреждение о прерывании установок из п. 1 действует и здесь.

- [ ] **Step 6: Проверить**

Run: `cd apps/agent && bun test && bun check && bun lint src`
Expected: все тесты PASS, проверки без ошибок.

- [ ] **Step 7: Коммит**

```bash
git add apps/agent/src/Overlay.ts apps/agent/src/SessionSupervisor.ts apps/agent/test deploy/README.md
git commit -m "feat(agent): снимать метку volatile со слоёв оставленных контейнеров"
```

### Task 4: Скрипт замера, деплой и замер

**Files:**
- Create: `deploy/measure-session-start.sh`
- Modify: `deploy/README.md` (одна строка в списке скриптов в начале)
- Modify: `docs/superpowers/specs/2026-10-26-faster-session-start-design.md` («Результаты»)

**Скрипт** `./deploy/measure-session-start.sh <userId> <appId> [runs=3] [ssh-хост=brofrong]`
выполняется на воркере через `ssh … bash -s`, как `build-steam-client.sh`.

Перед каждым запуском — отказ, если:
- есть контейнер `cg.session` или `cg.install` (любой статус, кроме `exited`);
- у пользователя есть сессия не в `ended`/`failed`.

Каждый запуск:
1. Записывает `t0`, вставляет `sessions(id, user_id, app_id, state='queued')` через
   `docker exec cg-postgres psql -U cg -d cloud_gaming`. Id — из `/proc/sys/kernel/random/uuid`.
2. Каждые 0,5 с отмечает первое появление трёх событий:
   - `container-started` — `docker inspect` `State.Running`;
   - `steam-ui` — первая строка `steamui_login.txt` в контейнере;
   - `game-started` — строка `play_segments` с этим `session_id`.

   Таймаут — 10 мин.
3. На `game-started`:
   - копирует `~/.local/share/Steam/logs/{steamui_login,webhelper,client_networkmanager}.txt`
     во временный каталог;
   - печатает только строки по шаблону `WaitingFor|Timed out|SetLoginState`.
4. Ставит `stop_requested_at = now()` и ждёт `ended`/`failed` и исчезновения контейнера, до 5 мин.
5. Удаляет временный каталог.

В конце — таблица `run | container-started | steam-ui | game-started` в секундах и медиана
`game-started`.

Отказ, таймаут или `failed` → ненулевой код и сообщение. Сессию при этом остановить так же, через
`stop_requested_at`.

- [ ] **Step 1: Написать скрипт**

Шапка-комментарий в стиле `build-steam-client.sh`:
- что делает;
- что пишет в БД — строку `sessions` пользователя, она станет обычной завершённой сессией
  и попадёт в его историю;
- что не трогает.

- [ ] **Step 2: Проверить синтаксис**

Run: `bash -n deploy/measure-session-start.sh`
Expected: без вывода, код 0.

- [ ] **Step 3: Базовый замер на текущем проде**

Только если владелец не играет. `userId` и `appId` — те же, что в замере спеки (владелец, Can of
Wormholes 1295320): спросить у владельца разрешение на три запуска от его аккаунта.

Run: `./deploy/measure-session-start.sh <userId> 1295320 3`
Expected: три строки и медиана около 140 с.

- [ ] **Step 4: Деплой**

По `deploy/README.md` §«Шаг 4: деплой». Сначала проверить, что нет `cg.session`/`cg.install`
(кроме `exited`).

Проверка после деплоя — по §«Проверка после деплоя». Затем `docker volume inspect` тома
первой же новой сессии: в `Options.o` есть `volatile`.

- [ ] **Step 5: Замер после `volatile`**

Run: `./deploy/measure-session-start.sh <userId> 1295320 3`
Expected: медиана заметно меньше базовой (ожидание по спеке — около 80–100 с).

Проверить:
- после замера нет каталогов `<SCRATCH_DIR>/<id>` замеренных сессий;
- нет томов `cg-s-*` без контейнера.

Это уборка слоёв с меткой `incompat`. Если старт steamwebhelper (между `steam-ui` и первой
строкой `webhelper`) всё ещё > 10 с — записать это: это повод для запасного варианта спеки §4.1.

- [ ] **Step 6: Записать результаты и закоммитить**

В «Результаты» спеки: таблицы до и после, ключевые строки Steam (без имени аккаунта).

```bash
git add deploy/measure-session-start.sh deploy/README.md docs/superpowers/specs/2026-10-26-faster-session-start-design.md
git commit -m "chore(deploy): скрипт замера запуска сессии, результаты volatile"
```

### Task 5: Замер устаревания кэша `appinfo.vdf` (спека §4.2)

Только замер. Механизм свежести — отдельный план по его итогам.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-faster-session-start-design.md` («Результаты»)

- [ ] **Step 1: Пересобрать шаблон клиента**

Сервис должен простаивать (README §«Клиент Steam: пересборка шаблона») — договориться с
владельцем о времени.

Run: `./deploy/build-steam-client.sh`
Expected: скрипт завершился заменой каталога шаблона.

- [ ] **Step 2: Замер сразу после пересборки**

Run: `./deploy/measure-session-start.sh <userId> 1295320 3`
Expected: в строках `steamui_login` интервал от `WaitingForLibraryReady` до следующего
состояния ≤ 5 с.

- [ ] **Step 3: Замер через ~24 ч**

Run: `./deploy/measure-session-start.sh <userId> 1295320 3`

Записать интервал `WaitingForLibraryReady` и медиану в «Результаты». Вывод одной фразой:
- хватит ли обновления раз в сутки (интервал ≤ 5 с);
- или нужно чаще / другой способ.

- [ ] **Step 4: Коммит**

```bash
git add docs/superpowers/specs/2026-10-26-faster-session-start-design.md
git commit -m "docs: замер устаревания кэша appinfo"
```

### Task 6: Исследование ожидания сети 20 с (спека §4.3)

Не больше ~полудня работы. Можно вести параллельно с Task 2–5. Код продукта здесь не пишется.
Найденное решение (например, заглушка NetworkManager в образе сессии) оформляется отдельной
задачей после одобрения владельцем: оно меняет образ сессии.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-faster-session-start-design.md` («Результаты»)

- [ ] **Step 1: Проверить гипотезу в живой сессии**

В контейнере сессии во время запуска (`docker exec`, без root):
- есть ли системная шина D-Bus и кто на ней:
  `dbus-send --system --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.ListNames`;
- отвечает ли `org.freedesktop.NetworkManager`;
- что Steam пишет в `client_networkmanager.txt` и `steamui_login.txt` вокруг `WaitingForNetwork`.

- [ ] **Step 2: Проверить кандидатов без изменения образа**

Стенд — сессия владельца из `measure-session-start.sh`, с его разрешением. Другой стенд не
годится: Steam без GPU и Plasma не стартует.

После `game-started`:
1. `docker exec` от `ubuntu` в окружении Plasma, как в `cg-steam-shutdown`: `cg-steam-shutdown`.
2. Поднять кандидата.
3. Снова `steam -silent` (так делает второй цикл `build-steam-client.sh`).
4. Посмотреть в `steamui_login.txt`, сколько длится `WaitingForNetwork`.

Кандидаты — тем, что уже есть в образе (проверить `python3`, `gdbus`, `dbus-send`):
- заглушка `org.freedesktop.NetworkManager` на системной шине со свойствами `State=70`
  (`CONNECTED_GLOBAL`) и `Connectivity=4` (`FULL`);
- параметр запуска или переменная окружения Steam, отключающие ожидание сети, если такие
  найдутся в строках `ubuntu12_32/steamui.so`.

Остановить сессию через `stop_requested_at`, как в скрипте.

- [ ] **Step 3: Записать итог и закоммитить**

В «Результаты»: причина (доказана или нет), что сработало, сколько секунд это даёт, и
предлагаемое изменение образа. Если не получилось — почему, и пункт в `docs/backlog.md`.

```bash
git add docs/superpowers/specs/2026-10-26-faster-session-start-design.md docs/backlog.md
git commit -m "docs: исследование ожидания сети Steam"
```
