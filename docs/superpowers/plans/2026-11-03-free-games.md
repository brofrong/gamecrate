# Бесплатные игры (свои сборки вне Steam, первая — Ship of Harkinian) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Любой вошедший игрок видит в библиотеке `/app` свои игры (первая — Ocarina of Time через
Ship of Harkinian) с меткой «бесплатно» и запускает их через обычный экран загрузки, без Steam.
Сохранения живут в его профиле.

**Architecture:** Описание каждой своей игры лежит в репозитории: `games/<slug>/game.json`, скрипты
сборки и картинки сайта. api при старте читает эти описания и пишет их в `games` и новую таблицу
`own_games`; флаг «открыта» хранится в БД. Скрипт `deploy/add-game.sh` собирает пакет игры на
воркере, в `<GAMES_DIR>/<slug>/<version>/`. Агент сообщает найденные пакеты полем
`WorkerStats.ownGames`. `eligibleWorkers` пускает свою игру только на воркер с её активной
версией. Своя игра никогда не уходит в установку Steam. `StartSession.ownGame` говорит агенту
смонтировать пакет в `/opt/cg-game` (только чтение), а `cg-launch` в том же образе `cg-session`
запускает `cg-game-exit /opt/cg-game/run` вместо Steam. Сайт отличает свои игры по номеру:
`isOwnAppId(appId)`, все такие номера не меньше 1 900 000 000.

**Tech Stack:** Bun, Effect 4, drizzle-orm 1.0 rc + Postgres, React 19, bash (скрипты образа и
деплоя), Docker, CMake/Ninja (сборка SoH), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-03-free-games-design.md`

## Global Constraints

**Номера и пути**
- «Вид игры» из спеки §1.1 — это строка в `own_games` плюс диапазон номеров, а не колонка `kind`
  в `games` (решение плана: одна правда вместо двух, сайту хватает `isOwnAppId`).
- Номера своих игр: `OWN_APP_ID_MIN = 1_900_000_000`, проверка
  `own_games.app_id >= 1900000000`. SoH: `appId = 1900000001`, `slug = "soh"`.
- `slug` соответствует `^[a-z0-9][a-z0-9-]{0,31}$`, версия пакета —
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Без `,`, `:` и пробелов: они идут в bind
  `источник:цель:ro`.
- Пакет на воркере: `<GAMES_DIR>/<slug>/<version>/`. Внутри исполняемый `run` и бинарник игры
  (поле `binary` описания). На brofrong `GAMES_DIR = ${CG_DATA_DIR}/games`, то есть
  `/raid/cloud-gaming/games`. В сессии пакет монтируется только для чтения в `/opt/cg-game`.
  Запуск — `/opt/cg-game/run`, метка контейнера `cg.own-game = <slug>/<version>`.
- Картинки сайта отдаются по `/own-games/<appId>/<file>`. Имена файлов: `header.jpg` (920×430),
  `hero.jpg` (1920×620), `cover.jpg` (600×900) и скриншоты из `site.screenshots`, 1920×1080.
- SoH: `SHIP_HOME=$HOME/.local/share/soh`. ROM — N64 NTSC-U 1.2, CRC32C `15736A58`, SHA-1
  `41b3bdc48d98c48529219919015a1af22f5057c2`, на маке по пути
  `/Users/dmitiigorshkov/.t3/userdata/attachments/d4a92eab-c290-4c85-981a-4b10a6e5699b-87b28311-31f7-4f4a-a176-3ed4b9aea0be-z64.z64`.
  Upstream — `https://github.com/HarbourMasters/Shipwright`, тег `9.3.1`. Другой тег — только по
  итогам Task 1, с записью там.

**Тексты**
- Чип: «Играть бесплатно». Метка на плитке: «бесплатно» (тон `ok`, как «готова»).
- Этапы экрана загрузки: «Готовим компьютер», «Запускаем игру».
- Страница игры: «Фанатский ПК-порт», «Управление».
- Админка: «Свои сборки», «своя сборка», «Открыта игрокам», «Нет ни на одном воркере».
- Агент: `failReasons.ownGameMissing = "Игры нет на этом сервере"`.

**Анти-цели**
- Файлов Nintendo (`*.z64`, `*.n64`, `*.v64`, `*.o2r`, каталог `roms/`) нет в git и в образах.
  Это закрывают `.gitignore` и `.dockerignore` (Task 3). ROM на воркере лежит только во временном
  каталоге и удаляется ловушкой `trap`.
- Steam-путь не меняется. Существующие тесты сессий, планировщика и библиотеки проходят без правки
  их ожиданий. Правка вспомогательных функций тестов, например `appId` у `insertSession`, допустима.

**Тесты и проверки**
- БД-тесты из worktree запускаются так:
  `bun test --env-file=/Users/dmitiigorshkov/work/imt-cloud-gaming/.env`. Файл `.env` не открывать
  и не выводить.
- В корне перед каждым коммитом: `bun run check --force`, `bun run lint`.
- 6 тестов `stageNorms` падают и на main, это старая поломка. Их не чинить и за новые не считать.

**Работа в репозитории**
- Ветка `feat/free-games` в worktree `~/work/imt-cloud-gaming-stream`. Основной checkout делят
  другие сессии.
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- В origin не пушить.

**brofrong**
- Не перезагружать, конфиг хоста не менять.
- Живые сессии игроков не останавливать.
- Деплой только когда нет контейнеров `cg.session`, `cg.install`, `cg.template`.
- Мердж в main и деплой — только после «да» владельца.

## Review Focus

1. **Steam-профиль игрока закрыт.** Сейчас `libraryView` отдаёт `Private` без игр, и свои игры
   пропали бы. Ожидание: свои игры видны и под заметкой про закрытый профиль. Тесты:
   `private Steam profile still lists own games` (Task 9) и
   `private profile shows own games under the notice` (Task 11).
2. **Скрытая своя игра.** Прямой заход на `/app/game/<id>` даёт «не найдена», `session.start` —
   `NotOwned`. Сессия в очереди у игры, которую скрыли позже, остаётся в очереди и не уходит в
   установку Steam. Тесты: `unpublished own game is not found and not startable` (Task 9) и
   `own game hidden while queued stays queued, never installs` (Task 8).
3. **Новая версия в описании, а на воркере ещё старая.** Ожидание: игра «недоступна» до сборки
   новой версии. Сессии не падают, установка не запускается. Тесты:
   `stale package version is not eligible` (Task 4) и
   `own game without a package waits, never installs` (Task 8).
4. **Агент перезапустился посреди сессии своей игры.** Подхваченная сессия должна остаться своей
   по метке `cg.own-game`: остановка без закрытия Steam и ожидания облака. Тест:
   `adopted own-game session stops without Steam steps` (Task 7).
5. **Игрок вышел из SoH сам.** Ожидание: сессия заканчивается с `end: "quit"`, а не `unknown`.
   Живость считается по процессу обёртки `cg-game-exit`, а не самой игры, иначе код выхода не
   успевает записаться. Тест: `own game exit is read from the wrapper` (Task 7).

---

### Task 1: Спайк SoH на brofrong — сборка, запуск в окружении сессии, итоги

Это разведка, кода приложения здесь нет. Итог — черновики `games/soh/*` и раздел «Итоги Task 1» в
конце этого файла. От этих итогов зависят Task 3, 6 и 11. Всё делается во временных контейнерах
на brofrong (пример — `bbport-spike`, см. память bbport). Прод-слот на UDP 59000 не занимать,
спайк — на UDP 59001.

- [ ] **Step 1: Образ-сборщик.** Создать `games/soh/builder.Dockerfile` по образцу
  `bbport-builder:spike`:
  - `ARG SESSION_IMAGE`, `FROM ${SESSION_IMAGE}`;
  - `USER root`, `dpkg -r --force-depends steam-launcher`, убрать apt-источник Steam;
  - `apt-get install gcc g++ cmake ninja-build git` и пакеты из `games/soh/apt.txt` (копия
    `linux-build-deps/apt.txt` тега `9.3.1`);
  - в конце `USER 1000`.

  Собрать его на brofrong:
  `docker build --build-arg SESSION_IMAGE=cg-session:550.163.01 -t cg-game-builder-soh:spike`.
- [ ] **Step 2: Скрипт сборки.** Написать `games/soh/build.sh <input-dir> <out-dir>`, который
  запускается внутри сборщика.
  - Сборка:
    1. `git clone --depth 1 --recursive --branch 9.3.1`;
    2. `cmake -H. -Bbuild-cmake -GNinja -DCMAKE_BUILD_TYPE=Release`;
    3. цели `soh` и `GenerateSohOtr`;
    4. `<input-dir>/rom` → `roms/` и цель `ExtractAssets`.
  - Результат в `<out-dir>`: бинарник, `soh.o2r`, `oot.o2r`, остальные файлы, без которых SoH не
    стартует (например `gamecontrollerdb.txt`), `run`, `shipofharkinian.json`.
  - Нет `oot.o2r` — `exit 1`.

  Прогнать на brofrong. ROM копируется во временный каталог через `scp`, после прогона удалить.
- [ ] **Step 3: Нехватка библиотек в `cg-session`.** Выполнить
  `docker run --rm -v <out>:/opt/cg-game:ro --entrypoint ldd cg-session:550.163.01 /opt/cg-game/<бинарник>`.
  Записать, каких `.so` нет. Скопировать их из сборщика в `<out>/lib` (`cp -L` по
  `ldconfig -p`) и повторять, пока `LD_LIBRARY_PATH=/opt/cg-game/lib ldd` не покажет пусто.
- [ ] **Step 4: `run` и настройки.** Написать `games/soh/run`:
  - `export SHIP_HOME="$HOME/.local/share/soh"`, `mkdir -p`;
  - если в `SHIP_HOME` нет `shipofharkinian.json`, скопировать туда `/opt/cg-game/shipofharkinian.json`;
  - `LD_LIBRARY_PATH=/opt/cg-game/lib`, `SDL_AUDIO_DRIVER=pulseaudio`;
  - `exec /opt/cg-game/<бинарник>`.

  Проверить в контейнере `cg-session:550.163.01`:
  - пакет смонтирован в `/opt/cg-game:ro`;
  - Selkies на 59001;
  - запуск идёт из `cg-session-exec` с окружением labwc.

  Найти и записать:
  - видео: X11 (Xwayland) или `SDL_VIDEO_DRIVER=wayland`, что из них стабильно на NVIDIA 550;
  - ключи `shipofharkinian.json`, с которыми первый запуск сразу идёт на весь экран без меню
    SoH;
  - находит ли SoH `oot.o2r`/`soh.o2r` в `/opt/cg-game`, когда `SHIP_HOME` указывает в другое
    место, и что SoH пишет в `SHIP_HOME` (не должно быть `.o2r` и больших файлов);
  - видна ли игра потомком обёртки в `xdotool search --pid` (для X11) или через `lswt` (для
    Wayland; если `lswt` нет в apt 26.04 — что есть вместо).
- [ ] **Step 5: Ввод, звук, сохранение.** Через стрим спайка: открыть страницу Selkies на маке
  через `ssh -L 8080:<ip контейнера>:8080 brofrong` в headless Chrome по CDP, как
  `/tmp/gc-shot/input.ts`.
  - Проверить, что SoH видит геймпад Selkies, клавиатуру и звук.
  - Записать раскладку клавиатуры SoH по умолчанию (действие → клавиша) из
    `shipofharkinian.json` или исходников.
  - Сохраниться, выйти из меню SoH (`cg-game-exit` пишет `code 0`), перезапустить контейнер с тем
    же домом и проверить, что сохранение на месте.
  - Снять три кадра 1920×1080: титульный экран, Хайрульское поле, бой или меню. Сохранить на маке
    в `/tmp/soh-shots/`.
- [ ] **Step 6: Записать итоги** в раздел «Итоги Task 1» в конце этого файла:
  - тег и версия пакета (`9.3.1-1`);
  - видео-драйвер и переменные `run`;
  - ключи полного экрана;
  - список библиотек в `lib/`;
  - способ проверки окна для `cg-session-stage --own`;
  - раскладка по умолчанию;
  - что лежит в `SHIP_HOME`.

  Удалить спайк-контейнер и ROM с brofrong, закоммитить черновики `games/soh/{builder.Dockerfile,apt.txt,build.sh,run,shipofharkinian.json}`
  и план.

```bash
git add games/soh docs/superpowers/plans/2026-11-03-free-games.md
git commit -m "spike(soh): сборка и запуск Ship of Harkinian в окружении сессии — итоги"
```

### Task 2: Контракт — номера, описание игры, пакеты в `@cg/rpc`

**Files:**
- Create: `packages/rpc/src/ownGames.ts`, `packages/rpc/test/ownGames.test.ts`
- Modify: `packages/rpc/src/index.ts` (экспорт), `packages/rpc/src/agent.ts` (`WorkerStats`,
  `StartSession`), `packages/rpc/src/library.ts` (`GameView.own`), `packages/rpc/src/admin.ts`
  (`AdminGames.own`, `admin.games.setPublished`)

**Interfaces:**
- Produces:
  - Номера и адреса картинок:
    - `OWN_APP_ID_MIN = 1_900_000_000`;
    - `isOwnAppId(appId: number): boolean`;
    - `ownGameAssetUrl(appId: number, file: string): string` → `/own-games/<appId>/<file>`.
  - Пакет:
    - `OwnGameSlug`, `OwnGameVersion` — `Schema.String` с паттернами из Global Constraints;
    - `OwnGamePackage = Schema.Struct({ slug: OwnGameSlug, version: OwnGameVersion })`.
  - Тексты страницы игры:
    - `OwnGameControl = Schema.Struct({ action: Schema.String, keyboard: Schema.String, gamepad: Schema.String })`;
    - `OwnGameSource = Schema.Struct({ label: Schema.String, url: Schema.String })`.
  - `OwnGameManifest` — поля:
    - `appId: Int`, от `OWN_APP_ID_MIN` до `2147483647`;
    - `slug`, `name`, `version`, `binary` (имя файла без `/`);
    - `upstream: { repo, ref }`;
    - `inputs: Array<{ name: OwnGameSlug, label }>`;
    - `site: { description, controls: Array<OwnGameControl>, source: OwnGameSource, screenshots: Array<String> }`,
      имена скриншотов по `^[a-z0-9-]+\.jpg$`;
    - `requirements: { minVramBytes, minRamBytes, minCpuThreads }`, неотрицательные целые.
  - `OwnGameInfo = Schema.Struct({ description, controls, source, screenshots: Schema.Array(Schema.String) })`,
    скриншоты здесь — уже адреса.
  - `WorkerStats.ownGames: Schema.optional(Schema.Array(OwnGamePackage))`.
  - `StartSession.ownGame: Schema.optional(OwnGamePackage)`. Есть — своя игра, нет — Steam, как
    сейчас.
  - `GameView.own: Schema.NullOr(OwnGameInfo)`.
  - `LibraryView.Private` получает `entries: Schema.Array(LibraryEntry)` — там только свои игры,
    см. Review Focus 1.
  - Админка:
    - `AdminOwnGame = { appId, name, slug, version, published: Boolean, workers: Array<String>, launches: Int, lastLaunchAt: NullOr(String), activeSessions: Int }`;
    - `AdminGames.own: Schema.Array(AdminOwnGame)`;
    - `Rpc admin.games.setPublished`: payload `{ appId: Int, published: Boolean }`, success
      `Schema.Literals(["ok", "notFound"])`.

- [ ] **Step 1: Тесты** в `packages/rpc/test/ownGames.test.ts`:

```ts
it("isOwnAppId splits at OWN_APP_ID_MIN", () => {
  expect(isOwnAppId(1_899_999_999)).toBe(false);
  expect(isOwnAppId(1_900_000_001)).toBe(true);
});
it("package rejects path and bind characters", () => {
  for (const version of ["../x", "a:b", "a,b", "a b", ".hidden"])
    expect(Schema.is(OwnGamePackage)({ slug: "soh", version })).toBe(false);
  expect(Schema.is(OwnGamePackage)({ slug: "soh", version: "9.3.1-1" })).toBe(true);
});
it("manifest rejects appId below the own range", () => { /* appId 570 → decode fails */ });
it("StartSession without ownGame decodes as before", () => { /* старая команда без поля */ });
it("ownGameAssetUrl", () =>
  expect(ownGameAssetUrl(1900000001, "cover.jpg")).toBe("/own-games/1900000001/cover.jpg"));
```

- [ ] **Step 2:** Запустить `bun test packages/rpc/test/ownGames.test.ts`. Ожидание: FAIL (модуля
  нет).
- [ ] **Step 3:** Реализовать `ownGames.ts` и поля в `agent.ts`, `library.ts`, `admin.ts`, обновить
  doc-комментарии этих схем.
- [ ] **Step 4:** Запустить `bun test packages/rpc` (PASS) и `bun run check --force`. Ожидание:
  ошибки типов только там, где `GameView`, `AdminGames` и `Private` собираются без новых полей:
  - `apps/api/src/library/GameService.ts` — поставить `own: null`;
  - `apps/api/src/admin/games.ts` — `own: []`;
  - `apps/api/src/library/LibraryService.ts` — `entries: []`.

  Этого хватит, чтобы проверка прошла. Настоящую логику дадут Task 9 и Task 10.
- [ ] **Step 5: Commit** — `feat(rpc): свои игры — номера, описание, пакеты, команда агенту`.

### Task 3: `games/soh`, скрипт `deploy/add-game.sh`, защита от файлов Nintendo

**Files:**
- Create: `games/soh/game.json`, `games/soh/site/{header,hero,cover,shot-1,shot-2,shot-3}.jpg`,
  `deploy/add-game.sh`, `games/README.md`
- Modify: `games/soh/*` (черновики Task 1), `.gitignore`, `.dockerignore`,
  `deploy/compose.yaml` (`GAMES_DIR` агента), `deploy/deploy.sh` (каталог `games` в `dirs`),
  `deploy/README.md`

**Interfaces:**
- Consumes: `OwnGameManifest` (Task 2), итоги Task 1.
- Produces:
  - Команда: `./deploy/add-game.sh <slug> [--host <ssh-хост>] [--input <name>=<путь>]... [--rebuild]`.
    Результат — пакет `<GAMES_DIR>/<slug>/<version>/` на хосте.
  - Контракт `build.sh` внутри сборщика:
    - `/game` — `games/<slug>` (ro);
    - `/input/<name>` — входные файлы (ro);
    - `/out` — пустой каталог (rw).

- [ ] **Step 1: `games/soh/game.json`.**
  - Номер и сборка: `appId: 1900000001`, `slug: "soh"`, `version` из итогов Task 1,
    `binary` из итогов, `upstream: { repo: "https://github.com/HarbourMasters/Shipwright", ref }`.
  - Название: `name: "The Legend of Zelda: Ocarina of Time"`.
  - Входной файл: `inputs: [{ name: "rom", label: "ROM Ocarina of Time (N64 NTSC-U 1.2 или другой из списка SoH)" }]`.
  - `site.description` — 2–3 абзаца по-русски: что это за игра; что это фанатский ПК-порт с
    широким экраном и 60 FPS; что игра на английском.
  - `site.controls` — строки из итогов Task 1: действие, клавиша, кнопка геймпада.
  - `site.source`: `{ label: "Ship of Harkinian (HarbourMasters)", url: "https://www.shipofharkinian.com" }`.
  - `site.screenshots`: `["shot-1.jpg", "shot-2.jpg", "shot-3.jpg"]`.
  - `requirements`: `{ minVramBytes: 1073741824, minRamBytes: 2147483648, minCpuThreads: 2 }`.

  Картинки сделать из `/tmp/soh-shots/` через `sips` или `magick`. `header`, `hero` и `cover`
  кадрируются из титульного экрана, размеры — из Global Constraints, JPEG q85.
- [ ] **Step 2: Защита.**
  - В `.gitignore` и `.dockerignore` добавить `**/*.z64`, `**/*.n64`, `**/*.v64`, `**/*.o2r`,
    `**/roms/`.
  - Проверка: `git check-ignore -v games/soh/roms/x.z64 games/soh/oot.o2r` печатает правило для
    обоих файлов.
- [ ] **Step 3: `deploy/add-game.sh`.** Стиль `deploy.sh`: `set -euo pipefail`, русские сообщения
  `==>`, `REMOTE_HOST` по умолчанию `brofrong`. Шаги:
  1. Прочитать `games/<slug>/game.json` (`bun -e`, без схемы: `version`, `binary`, `inputs`).
     Каждый `inputs[].name` должен прийти в `--input`, иначе выйти с ошибкой и списком
     недостающих.
  2. Взять с хоста из `~/cloud-gaming/.env` только `CG_DATA_DIR` и `SESSION_IMAGE`; по умолчанию
     `/raid/cloud-gaming` и `cg-session:550.163.01`.
  3. Если `<GAMES_DIR>/<slug>/<version>` уже есть и нет `--rebuild` — выйти с сообщением.
  4. `rsync games/<slug>/` → `~/cg-games-src/<slug>/`.
  5. Входные файлы — `scp` в каталог `mktemp -d` на хосте. `trap` на выходе удаляет его на хосте
     всегда, в том числе при ошибке.
  6. Собрать `cg-game-builder-<slug>:<version>` из `builder.Dockerfile`
     (`--build-arg SESSION_IMAGE`).
  7. `docker run --rm --user 1000:1000` сборщика с `/game`, `/input`, `/out`, где
     `/out = <GAMES_DIR>/<slug>/.build-<version>`.
  8. Цикл недостающих библиотек из Task 1 Step 3, не больше 5 проходов. Остались `not found` —
     ошибка.
  9. `test -x /out/run` и `test -f /out/<binary>`.
  10. Проверить, что в пакете нет ROM:
      `find <out> -iname '*.z64' -o -iname '*.n64' -o -iname '*.v64'` должен быть пуст.
  11. `mv .build-<version> <version>`.
  12. Удалить версии `<slug>/*` кроме новой и предыдущей по `mtime`.
  13. Напечатать: «Пакет готов. Дальше: деплой (каталог игр), затем в админке «Открыта игрокам».»
- [ ] **Step 4: Окружение агента.**
  - `compose.yaml`, сервис `cg-agent`: `GAMES_DIR: ${CG_DATA_DIR:-/raid/cloud-gaming}/games`.
    Bind `CG_DATA_DIR` уже есть.
  - `deploy.sh`: каталог `${CG_DATA_DIR}/games` в массив `dirs` перед `mkdir -p`.
  - В `deploy/README.md` и `games/README.md` описать, как добавить свою игру, и правило «никаких
    файлов Nintendo в репозитории».
- [ ] **Step 5: Проверка на brofrong.** Запустить:
  `./deploy/add-game.sh soh --input rom=/Users/dmitiigorshkov/.t3/userdata/attachments/d4a92eab-c290-4c85-981a-4b10a6e5699b-87b28311-31f7-4f4a-a176-3ed4b9aea0be-z64.z64`.

  Ожидание:
  - `ls /raid/cloud-gaming/games/soh/<version>` показывает `run`, бинарник, `oot.o2r`,
    `soh.o2r`, `lib/`;
  - во временных каталогах `/tmp` хоста нет `*.z64`;
  - повторный запуск без `--rebuild` выходит с «уже есть».
- [ ] **Step 6: Commit** — `feat(games): Ship of Harkinian и скрипт add-game — сборка пакета на воркере`.

### Task 4: БД — `own_games`, синхронизация описаний, допуск по пакету

**Files:**
- Modify: `packages/db/src/schema/library.ts` (`ownGames`), `packages/db/src/placement.ts`
  (`eligibleWorkers`), `packages/db/src/index.ts`
- Create: `packages/db/src/ownGames.ts`, миграция `packages/db/migrations/<ts>_own_games`
  (`cd packages/db && bunx drizzle-kit generate --name own_games`)
- Test: `packages/db/test/ownGames.test.ts`, `packages/db/test/placement.test.ts`

**Interfaces:**
- Consumes: `OwnGameManifest`, `OwnGamePackage`, `WorkerStats.ownGames` (Task 2).
- Produces:
  - Таблица `ownGames`, `pgTable("own_games")`:
    - `appId` — PK, FK `games.appId`;
    - `slug` — text, not null, unique;
    - `version` — text, not null;
    - `published` — boolean, not null, default `false`;
    - `updatedAt`;
    - `check("own_games_app_id_range", sql\`app_id >= 1900000000\`)`.
  - Тип `OwnGameRow = { appId, slug, version, published }`.
  - `syncOwnGames(manifests: ReadonlyArray<OwnGameManifest>): Effect<void, never, Db>`:
    1. upsert `games(appId, name)`;
    2. upsert `own_games(slug, version)` без изменения `published`;
    3. `game_requirements` из `requirements` — `onConflictDoNothing` (правки админа не
       затираются).

    Всё в одной транзакции.
  - `ownGameOf(appId: number): Effect<OwnGameRow | undefined, never, Db>`.
  - `hasPackage(stats: WorkerStats | null, pkg: OwnGamePackage): boolean`.
  - `eligibleWorkers` для `isOwnAppId(appId)`:
    - строки `own_games` нет → `[]`;
    - иначе дополнительно фильтрует кандидатов по `hasPackage(workers.stats, { slug, version })`
      (в выборку добавить `stats`).

    Для Steam-игр без изменений. `gameAvailable` получает это даром.

- [ ] **Step 1: Тесты.**

```ts
it("sync inserts own game hidden and keeps published on resync", ...);
// sync → published false; update set published true; sync с новой version → published true, version новая
it("sync does not overwrite admin requirements", ...);
it("own_games rejects appId below the range", ...); // insert app_id 570 → ошибка check
// placement.test.ts:
it("own game is eligible only on worker with its active package", ...);
// stats.ownGames [{soh, 9.3.1-1}] у w1, нет у w2 → [w1]
it("stale package version is not eligible", ...);   // у воркера 9.3.1-0, активна 9.3.1-1 → []
it("steam game ignores ownGames in stats", ...);    // 570 как раньше
```

- [ ] **Step 2:** Запустить `bun test --env-file=… packages/db`. Ожидание: FAIL.
- [ ] **Step 3:** Реализовать схему, сгенерировать миграцию, сделать `ownGames.ts` и правку
  `eligibleWorkers`.
- [ ] **Step 4:** Запустить `bun test --env-file=… packages/db`. Ожидание: PASS, включая старые
  тесты `placement.test.ts`.
- [ ] **Step 5: Commit** — `feat(db): own_games — свои игры в каталоге, допуск только на воркер с пакетом`.

### Task 5: Агент — `GAMES_DIR` и отчёт о пакетах

**Files:**
- Create: `apps/agent/src/OwnGames.ts`, `apps/agent/test/ownGames.test.ts`
- Modify: `apps/agent/src/config.ts`, `apps/agent/src/WorkerMonitor.ts`,
  `apps/agent/test/config.test.ts`, `apps/agent/test/workerMonitor.test.ts`

**Interfaces:**
- Consumes: `OwnGamePackage` (Task 2).
- Produces:
  - Конфиг: `gamesDir: Option<string>`, `Config.option(HostDir("GAMES_DIR"))`. Не совпадает и не
    вложен с `SCRATCH_DIR`/`INSTALL_SCRATCH_DIR` (добавить в `pairs`).
  - Константы: `OWN_GAME_MOUNT = "/opt/cg-game"`, `OWN_GAME_RUN = "/opt/cg-game/run"`,
    `OWN_GAME_LABEL = "cg.own-game"`.
  - `scanOwnGames(gamesDir: string): Array<OwnGamePackage>` — каталоги `<slug>/<version>`,
    чьи имена проходят схемы (`.build-*` и прочие скрытые — нет), где `run` — исполняемый файл.
    Сортировка по `slug`, затем по `version`. Нет каталога — `[]`.
  - `ownGameDir(gamesDir: string, pkg: OwnGamePackage): string`.
  - `WorkerStats.ownGames` присылается, когда `gamesDir` задан и есть роль `worker`.

- [ ] **Step 1: Тесты** (временный каталог):

```ts
it("scan lists slug/version dirs with executable run", ...);
// soh/9.3.1-1/run (0755) → [{slug:"soh",version:"9.3.1-1"}]
it("scan skips build dirs, non-executable run and bad names", ...);
// soh/.build-9.3.2, soh/x/run (0644), Bad_Slug/1/run → []
it("GAMES_DIR nested in SCRATCH_DIR is rejected", ...);
it("monitor reports ownGames only with GAMES_DIR", ...);
```

- [ ] **Step 2:** Запустить `bun test apps/agent/test/ownGames.test.ts apps/agent/test/config.test.ts apps/agent/test/workerMonitor.test.ts`.
  Ожидание: FAIL.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** Запустить ту же команду. Ожидание: PASS.
- [ ] **Step 5: Commit** — `feat(agent): GAMES_DIR — агент сообщает пакеты своих игр`.

### Task 6: Образ сессии — запуск своей игры и её этапы

**Files:**
- Modify: `images/session/cg-launch`, `images/session/cg-session-stage`, `images/session/Dockerfile`
  (`lswt` — только если Task 1 выбрал Wayland), `images/session/README.md`
- Test: `apps/agent/test/cgLaunch.test.ts`, `apps/agent/test/sessionStage.test.ts`

**Interfaces:**
- Consumes: итоги Task 1 (как искать окно).
- Produces:
  - `cg-launch`: непустой `CG_GAME` — путь к исполняемому файлу, иначе `exit 1`. Ветка идёт
    раньше проверки `CG_APP_ID`, тот же замок. Запуск — `exec /usr/local/bin/cg-game-exit "${CG_GAME}"`.
    `CG_GAME_EXIT` — другой путь обёртки для тестов. Steam не запускается.
  - `cg-session-stage --own` печатает `computer | loading | visible`:
    - процесс обёртки находится по `pgrep -f 'cg-game-exit /opt/cg-game/run( |$)'`, шаблон
      собирается внутри скрипта (как `reaper_pattern`);
    - `loading` — обёртка жива;
    - `visible` — окно ≥ 64×64 у потомка обёртки (X11: `DISPLAY` берётся из
      `/proc/<pid обёртки>/environ`, проверка как `is_visible`) или верхнее окно в `lswt`
      (Wayland, по итогам Task 1);
    - иначе `computer`.

    Числовой аргумент работает как раньше.

- [ ] **Step 1: Тесты.**

```ts
it("CG_GAME runs the game through cg-game-exit, not steam", ...);
// фейковый cg-game-exit пишет argv → "/tmp/x/run"; steam.log нет
it("CG_GAME that is not executable exits 1", ...);
it("own stage: loading while wrapper runs, visible with a big window", ...);
// фейковый /proc (CG_STAGE_PROC) + фейковые pgrep/xdotool/xwininfo, как в существующих тестах этапов
it("own stage without wrapper prints computer", ...);
```

- [ ] **Step 2:** Запустить `bun test apps/agent/test/cgLaunch.test.ts apps/agent/test/sessionStage.test.ts`.
  Ожидание: FAIL.
- [ ] **Step 3:** Реализовать, обновить шапки-комментарии обоих скриптов и README образа.
- [ ] **Step 4:** Запустить ту же команду. Ожидание: PASS, включая все старые тесты Steam-этапов.
- [ ] **Step 5: Commit** — `feat(session-image): cg-launch и cg-session-stage для своих игр`.

### Task 7: Агент — сессия своей игры от старта до остановки

**Files:**
- Modify: `apps/agent/src/SessionSupervisor.ts`, `apps/agent/src/profile/HomeProfile.ts`
  (`saveProfile`)
- Test: `apps/agent/test/supervisor.test.ts`, `apps/agent/test/profileCommitter.test.ts` или тот
  тест, где проверяется `saveProfile`

**Interfaces:**
- Consumes: `StartSession.ownGame` (Task 2); `OWN_GAME_*`, `ownGameDir`, `gamesDir` (Task 5);
  контракт скриптов (Task 6).
- Produces:
  - `failReasons.ownGameMissing = "Игры нет на этом сервере"` — нет `gamesDir` или нет каталога
    пакета. Проверяется в `start` до `register`, Docker не трогается.
  - `Session.ownGame: OwnGamePackage | undefined`; `Target = Pick<Session, "name" | "appId" | "ownGame">`.
  - `sessionSpec` для своей игры:
    - `env.CG_GAME = OWN_GAME_RUN`, `CG_APP_ID` остаётся;
    - bind `${ownGameDir(...)}:${OWN_GAME_MOUNT}:ro`: у `desktopSpec` появляется необязательное
      поле `binds`, оно дописывается к GBM;
    - метка `OWN_GAME_LABEL = "<slug>/<version>"`.

    Слои Steam монтируются как сейчас (решение плана: уборка и `cg-profile-pack` не меняются).
  - `commands` для своей игры:
    - `game` → `["pgrep", "-f", "cg-game-exit /opt/cg-game/run( |$)"]`;
    - `closeGame` → `["pkill", "-TERM", "-f", "^/opt/cg-game/"]`;
    - `stage` → `[".../cg-session-stage", "--own"]`.
  - Запуск (`launch`): без `clearSteamLogin`, `seedSteamLogin`, `setLaunchOptions`, журнала
    входа. После `docker.start` этап не меняется, остаётся `computer`.
  - Наблюдение (`watchGame`): при старте игры этап `loading`, а не `prepare`. У своей игры нет
    `cloudCount`, `cloudBaseline` всегда `undefined`.
  - Остановка (`finish`):
    - без ожидания облака;
    - `saveProfile({ ..., shutdownSteam: false })` без `beforePack`.

    `saveProfile` получает необязательное `shutdownSteam?: boolean`, по умолчанию `true`;
    `false` — `cg-steam-shutdown` не вызывается.
  - Подхват: метка `cg.own-game` → `ownGame` подхваченной сессии. Битая метка — лог и
    обращение как с контейнером без меток профиля.

- [ ] **Step 1: Тесты** (фейки `apps/agent/test/fakes.ts`):

```ts
it("own game: container gets CG_GAME, read-only package bind and label", ...);
// spec.env.CG_GAME === "/opt/cg-game/run"; binds содержит "<gamesDir>/soh/9.3.1-1:/opt/cg-game:ro"
it("own game without package fails with ownGameMissing, no docker calls", ...);
it("own game launch skips Steam login seeding and launch options", ...);
it("own game stages: computer → loading → visible, never steam/login/prepare", ...);
it("own game exit is read from the wrapper", ...);
// pgrep обёртки: 0, 0, 1 → GameState { running: false, end: "quit" } при "code 0" в /tmp/cg-game-exit
it("stopping own game closes /opt/cg-game, skips cloud wait and Steam shutdown", ...);
// exec-журнал: pkill ^/opt/cg-game/; нет grep cloud_log, нет cg-steam-shutdown; Stopped.cloudSynced false
it("adopted own-game session stops without Steam steps", ...);
it("steam session commands unchanged", ...); // gamePattern AppId=…, stage <appId>
```

- [ ] **Step 2:** Запустить `bun test apps/agent`. Ожидание: FAIL только в новых тестах.
- [ ] **Step 3:** Реализовать. Ветвиться через `session.ownGame !== undefined` и не размножать
  `if` по всему файлу: помощники `gameCommands(target)` и `isOwn(session)`.
- [ ] **Step 4:** Запустить `bun test apps/agent`. Ожидание: PASS, все старые тесты без правки
  ожиданий.
- [ ] **Step 5: Commit** — `feat(agent): сессия своей игры — пакет в /opt/cg-game, без Steam`.

### Task 8: Оркестратор — своя игра без установки, команда с `ownGame`

**Files:**
- Modify: `apps/orchestrator/src/Scheduler.ts`, `apps/orchestrator/test/support.ts` (`appId?` у
  `insertSession`, `ownGames?` у `connectWorker` → `workers.stats`)
- Test: `apps/orchestrator/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `ownGames`, `ownGameOf` (Task 4); `StartSession.ownGame` (Task 2).
- Produces:
  - Новые условия:
    - `ownGameRow: SQL` — есть строка `own_games` для `sessions.appId`;
    - `ownGamePublished: SQL` — та же строка с `published`.
  - Условие установки: `not (appInLibrary or ownGameRow) and not appInstallCancelling`. Своя
    игра в установку не уходит никогда.
  - Условие размещения: `appInstalled or ownGamePublished`. В цикле для своей игры строка
    `own_games` читается `for share` вместо `gamestore_apps`; нет её или игра скрыта — `continue`.
  - `Placement.ownGame?: OwnGamePackage`.
  - `tick` для своей игры:
    - не читает и не чистит вход Steam;
    - шлёт `steamLogin: null`, без `steamLoginResetAt`, с `ownGame`.

- [ ] **Step 1: Тесты.**

```ts
it("own game session is placed on worker with the package with ownGame and no Steam login", ...);
// hub.sent[0]: { _tag:"StartSession", appId:1900000001, ownGame:{slug:"soh",version:"9.3.1-1"}, steamLogin:null }, нет steamLoginResetAt
it("own game without a package waits, never installs", ...);
// у воркера нет пакета → state queued, install_jobs пусто
it("own game hidden while queued stays queued, never installs", ...);
```

- [ ] **Step 2:** Запустить `bun test --env-file=… apps/orchestrator/test/scheduler.test.ts`.
  Ожидание: FAIL.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** Запустить `bun test --env-file=… apps/orchestrator`. Ожидание: PASS, все старые
  тесты.
- [ ] **Step 5: Commit** — `feat(orchestrator): своя игра — только на воркер с пакетом, без установки и входа Steam`.

### Task 9: api — каталог, доступ, библиотека, страница игры

**Files:**
- Create: `apps/api/src/library/OwnGameCatalog.ts`, `apps/api/src/library/OwnGamesRepo.ts`,
  `apps/api/test/ownGames.test.ts`
- Modify:
  - `apps/api/src/config.ts` (`ownGamesDir`);
  - `apps/api/src/main.ts` (слой каталога после миграций);
  - `apps/api/src/session/SessionRepo.ts` (`ownsGame`);
  - `apps/api/src/library/LibraryService.ts` (`coverUrl`, `libraryView`);
  - `apps/api/src/library/CloudRepo.ts` (`cloudStatuses`);
  - `apps/api/src/library/GameService.ts` (`gameView`);
  - `apps/api/src/library/rpc.ts`;
  - `apps/api/src/session/StageNorms.ts` (общий пул без своих игр);
  - тестовые слои api, где собирается `LibraryRpcHandlers`.

**Interfaces:**
- Consumes: `OwnGameManifest`, `OwnGameInfo`, `isOwnAppId`, `ownGameAssetUrl` (Task 2);
  `syncOwnGames`, `ownGames` (Task 4).
- Produces:
  - Конфиг: `ownGamesDir`, `Config.String("OWN_GAMES_DIR")`, по умолчанию
    `fileURLToPath(new URL("../../../games", import.meta.url))`.
  - `loadOwnGameManifests(dir: string): ReadonlyArray<OwnGameManifest>`:
    - читает `<dir>/*/game.json`;
    - ошибка декодирования, `slug` не равен имени каталога, повтор `appId` или `slug` — исключение
      с именем файла, api не стартует.
  - Сервис `class OwnGameCatalog extends Context.Service<OwnGameCatalog, { all: ReadonlyArray<OwnGameManifest>; byAppId(appId: number): OwnGameManifest | undefined }>`:
    - `static layer` — загрузка и `syncOwnGames`;
    - `static fromManifests(list)` — для тестов, без БД.
  - Репозиторий `OwnGamesRepo`:
    - `publishedOwnGames(): Effect<ReadonlyArray<{ appId: number; name: string }>, never, Db>`;
    - `ownPlaytimeMinutes(userId, appIds): Effect<ReadonlyMap<number, number>, never, Db>` —
      сумма закрытых `play_segments` сессий пользователя по игре, целые минуты вниз.
  - `ownsGame`: для `isOwnAppId` — открытая строка `own_games`; для Steam как раньше.
  - `coverUrl(appId)`: для своей игры `ownGameAssetUrl(appId, "cover.jpg")`. Отсюда «Недавние» и
    библиотека.
  - `cloudStatuses`: свои номера всегда `Ready`.
  - `libraryView` дописывает открытые свои игры к Steam-играм пользователя:
    - `protonTier: "pending"`;
    - `playtimeMinutes` из `ownPlaytimeMinutes`;
    - `lastPlayedAt` как у всех.

    `Private` отдаёт `entries` со своими играми (поле из Task 2).
  - `gameView` для своей игры:
    - скрытая или нет в каталоге → `GameNotFound`;
    - без `resolveDetails` и Steam-достижений: `details: null`, `achievements: { _tag: "None" }`;
    - `inLibrary: true`, `sizeBytes: null`;
    - `own` из каталога, скриншоты через `ownGameAssetUrl`;
    - `playtimeMinutes` из `ownPlaytimeMinutes`.
  - Нормы этапов: в общем пуле только `app_id < 1900000000`; у самой игры её собственные замеры.

- [ ] **Step 1: Тесты** (`apps/api/test/ownGames.test.ts` с `OwnGameCatalog.fromManifests` и
  сидом `own_games`):

```ts
it("user without Steam sees published own games in library", ...);
// library.list → Ready, entries [{appId:1900000001, cloud:{_tag:"Ready"}, coverUrl:"/own-games/1900000001/cover.jpg"}]
it("private Steam profile still lists own games", ...);
it("own playtime comes from closed play segments", ...);
it("user without Steam can start a published own game", ...);
it("unpublished own game is not found and not startable", ...);
// library.game → GameNotFound; session.start → NotOwned
it("own game page has own info and never calls Steam Store", ...);
// фейковый SteamStoreApi падает при любом вызове
it("catalog loader rejects slug mismatch and duplicate appId", ...);
```

- [ ] **Step 2:** Запустить `bun test --env-file=… apps/api/test/ownGames.test.ts`. Ожидание: FAIL.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** Запустить `bun test --env-file=… apps/api`. Ожидание: PASS, кроме 6 старых
  `stageNorms`.
- [ ] **Step 5: Commit** — `feat(api): свои игры в библиотеке и на странице игры, доступ без Steam`.

### Task 10: Админка — свои сборки

**Files:**
- Modify: `apps/api/src/admin/games.ts`, `apps/api/src/admin/rpc.ts`,
  `apps/web/src/components/admin/GamesTab.tsx`
- Test: `apps/api/test/adminGames.test.ts`, `apps/web/test/adminGames.test.tsx`

**Interfaces:**
- Consumes: `AdminOwnGame`, `admin.games.setPublished` (Task 2); `ownGames`, `hasPackage`
  (Task 4).
- Produces:
  - `listGames().own`, отсортированные по имени:
    - `workers` — id воркеров с ролью `worker`, у которых `hasPackage(stats, { slug, version })`;
    - `launches`, `lastLaunchAt`, `activeSessions` — как у Steam-игр.
  - `setPublished(appId, published): Effect<"ok" | "notFound", never, Db>`.
  - В `GamesTab` новый раздел «Свои сборки» над играми библиотеки. Строка:
    - название, метка «своя сборка», версия;
    - воркеры через запятую или «Нет ни на одном воркере»;
    - `Switch` «Открыта игрокам»;
    - кнопка требований, открывает существующую `GameRequirementsPanel` с её `appId`.

    Удаления и установки у своих сборок нет.

- [ ] **Step 1: Тесты.**

```ts
it("admin list shows own games with workers that have the active package", ...);
it("setPublished toggles and returns notFound for unknown appId", ...);
it("own game row has publish switch and no delete button", ...); // web
```

- [ ] **Step 2:** Запустить `bun test --env-file=… apps/api/test/adminGames.test.ts` и
  `bun test apps/web/test/adminGames.test.tsx`. Ожидание: FAIL.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** Запустить те же команды. Ожидание: PASS.
- [ ] **Step 5: Commit** — `feat(admin): свои сборки — где есть пакет, открыть игрокам, требования`.

### Task 11: Сайт — библиотека, чип, страница игры, экран загрузки, картинки

**Files:**
- Modify:
  - библиотека и плитки: `apps/web/src/lib/libraryFilters.ts`, `apps/web/src/components/app/FilterBar.tsx`,
    `apps/web/src/components/app/FilterSheet.tsx` (если там список статусов),
    `apps/web/src/lib/tileValue.ts`, `apps/web/src/components/app/MyGamesPage.tsx`;
  - картинки: `apps/web/src/components/app/GameCover.tsx` (`headerUrl`), `apps/web/src/lib/gameHero.ts`;
  - страница игры: `apps/web/src/components/app/game/GamePage.tsx`,
    `apps/web/src/components/app/game/FactsPanel.tsx`;
  - экран загрузки: `apps/web/src/lib/loadingSteps.ts`, `apps/web/src/components/LoadingScreen.tsx`;
  - отдача картинок: `apps/web/build.ts`, `apps/web/dev.ts`.
- Create: `apps/web/src/components/app/game/OwnGamePanel.tsx`
- Test: `apps/web/test/libraryFilters.test.ts`, `apps/web/test/tileValue.test.ts`,
  `apps/web/test/filterBar.test.tsx`, `apps/web/test/myGamesPage.test.tsx`,
  `apps/web/test/gamePage.test.tsx`, `apps/web/test/loadingScreen.test.tsx`

**Interfaces:**
- Consumes: `isOwnAppId`, `ownGameAssetUrl`, `GameView.own`, `LibraryView.Private.entries`
  (Task 2/9).
- Produces:
  - Фильтры:
    - `StatusFilter` получает `"free"`, в URL это `status=free`;
    - чип «Играть бесплатно» включён и работает как `toggleStatusChip("free")`;
    - `applyFilters` при `"free"` оставляет только `isOwnAppId`, разделы как при `"all"`;
    - `sectionFor`: своя игра всегда `"ready"`, даже без Steam-профиля.
  - `tileValue`: своя игра → `{ text: "бесплатно", tone: "ok" }`, `dimmed` её не трогает.
  - Адреса картинок: `headerUrl`, `heroUrl`, `coverUrl` (`gameHero.ts`) для своей игры дают
    `ownGameAssetUrl(appId, "header.jpg" | "hero.jpg" | "cover.jpg")`.
  - `MyGamesPage`:
    - без Steam или с закрытым профилем показывает сетку `entries`, а `ConnectSteam` или
      `PrivateProfile` — под ней;
    - пустой `entries` — как сейчас.
  - `GamePage` при `game.own !== null`:
    - вместо `MediaStrip`/`AboutPanel` — `OwnGamePanel`: скриншоты через существующий `Lightbox`,
      описание абзацами, таблица «Управление» (действие, клавиатура, геймпад), строка
      «Фанатский ПК-порт» и ссылка `source.label ↗`;
    - нет `AchievementsPanel` и `CompatPanel`;
    - `FactsPanel` без строки «Открыть в Steam ↗».
  - `loadingSteps`: для `isOwnAppId(view.appId)` только этапы
    `[["computer", "Готовим компьютер"], ["loading", "Запускаем игру"]]`.
  - `LoadingScreen`: у своей игры нет подсказки про QR Steam.
  - `build.ts`: для каждого `games/*/game.json` копирует `games/<slug>/site/*` в
    `dist/own-games/<appId>/`.
  - `dev.ts` отдаёт `/own-games/<appId>/<file>` из тех же каталогов.

- [ ] **Step 1: Тесты.**

```ts
it("free status keeps only own games and URL round-trips status=free", ...);
it("own game is ready even without Steam profile", ...);
it("own tile says бесплатно, not нужен вход в Steam", ...);
it("free chip is enabled and toggles status", ...);
it("user without Steam sees own games above Connect Steam", ...);
it("private profile shows own games under the notice", ...);
it("own game page shows controls, fan-port note and no ProtonDB/achievements", ...);
it("own game loading screen has two steps and no Steam QR hint", ...);
it("own game covers come from /own-games", ...); // headerUrl(1900000001) === "/own-games/1900000001/header.jpg"
```

- [ ] **Step 2:** Запустить `bun test apps/web`. Ожидание: FAIL в новых тестах.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** Запустить `bun test apps/web`. Ожидание: PASS. Затем `cd apps/web && bun run build`.
  Ожидание: `dist/own-games/1900000001/cover.jpg` существует.
- [ ] **Step 5: Commit** — `feat(web): бесплатные игры — чип, плитки, страница игры, экран загрузки`.

### Task 12: Выкатка и живая проверка

Мердж и деплой — только после «да» владельца. Сначала показать ему сводку и ссылки на шаги ниже.

- [ ] **Step 1:** Проверить всю ветку в корне worktree: `bun run check --force`, `bun run lint`,
  `bun test --env-file=… ` по всем пакетам. Ожидание: зелёно, кроме 6 старых `stageNorms`.
- [ ] **Step 2: Образ сессии.** Запустить `./deploy/build-session-image.sh brofrong` с тегом,
  который ждёт `SESSION_IMAGE`; суффикс и перетег — по README скрипта. Идущие сессии на старом
  образе не трогаются.
- [ ] **Step 3: Пакет.** Если версия SoH или скрипты сборки менялись после Task 3 — запустить
  `./deploy/add-game.sh soh --input rom=… --rebuild`.
- [ ] **Step 4: Мердж и деплой.** Мердж `feat/free-games` в main. Основной checkout делят другие
  сессии, поэтому проверить ветку и статус. Деплой `./deploy/deploy.sh` из чистого worktree.
  `deploy.sh` сам откажет при живых сессиях: ждать, сессии не останавливать.
- [ ] **Step 5:** В `/admin` → «Игры» → «Свои сборки»: у SoH виден воркер `brofrong`. Включить
  «Открыта игрокам».
- [ ] **Step 6: Дымовая проверка.** Тестовый аккаунт без Steam, CDP-скрипт как `/tmp/gc-shot`.
  Ожидание:
  - `/app` показывает плитку Ocarina of Time с «бесплатно», чип «Играть бесплатно» её оставляет;
  - «Играть» → экран загрузки «Готовим компьютер → Запускаем игру» → стрим с игрой.

  Остановить сессию, проверить `Stopped.profileSaved = true` в логе агента.
- [ ] **Step 7: Сообщение владельцу** со списком для его проверки (спека §6):
  - видит SoH без Steam;
  - запуск до игры;
  - геймпад и клавиатура;
  - звук;
  - сохранение → выход → новая сессия с тем же сохранением;
  - время в библиотеке.

  Обновить память `project-free-games` и строку в `MEMORY.md`.

## Итоги Task 1

_(заполняет исполнитель Task 1)_
