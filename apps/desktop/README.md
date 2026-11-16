# GameCrate — десктоп-приложение

Оболочка Tauri 2 (Rust) без своего фронтенда: окно открывает сайт GameCrate (`/app`, гостя сайт
сам уводит на `/login`). Спека — `docs/superpowers/specs/2026-11-16-desktop-app-design.md`, план —
`docs/superpowers/plans/2026-11-16-desktop-app.md`.

## Что внутри

- `src-tauri/src/lib.rs` — главное окно `main`, single-instance (второй запуск будит первое окно),
  чужие ссылки — в системный браузер, User-Agent с суффиксом `GameCrateDesktop/<версия>` (пока
  только macOS, см. комментарий у `user_agent`).
- `src-tauri/src/nav.rs` — куда пускать окно: `is_internal` (та же схема, хост и порт, что у
  сайта) и `decide` (в окне / в браузер / запретить).
- `offline/` — заглушка из бандла (`frontendDist`). Это первая страница окна: проверяет, что сайт
  отвечает, и сразу уходит на него; без сети — «Нет связи с сервером» и кнопка «Повторить».
- `app-icon.svg` — исходник иконки (знак бренда на тёмном скруглённом квадрате); иконки в
  `src-tauri/icons` из него делает `bun run tauri icon app-icon.svg` (наборы `android/` и `ios/`
  после генерации удаляем — мобильных сборок нет).

## Запуск

Нужны Rust (stable) и зависимости Tauri для своей ОС: <https://tauri.app/start/prerequisites/>.

```sh
bun install                    # из корня репозитория
bun run --cwd apps/desktop dev # окно с https://game.brofrong.ru
```

Корневые `bun run dev` и `bun run build` приложение не собирают (`--filter=!@cg/desktop`): ему
нужен cargo, а серверному образу Docker и разработке сайта — нет.

### Другой адрес сайта — `GAMECRATE_URL`

Адрес зашивается в сборку при компиляции (`option_env!`, `/` в конце отбрасывается), по умолчанию
`https://game.brofrong.ru`:

```sh
GAMECRATE_URL=http://localhost:3000 bun run --cwd apps/desktop dev
```

Сменили переменную — cargo пересоберёт приложение сам (`build.rs`).

В `tauri dev` заглушку раздаёт сам CLI с `http://127.0.0.1:1430` (`devUrl` не задан), поэтому
отладочная сборка пускает в окно и этот адрес (`dev_server` в `lib.rs`). Бинарник, собранный
`tauri dev`, без запущенного CLI откроет пустое окно; обычный `cargo build` берёт заглушку из
бандла и работает сам.

## Проверки

```sh
bun run --cwd apps/desktop test       # bun: заглушка и инварианты конфига (идёт и в CI GitLab)
bun run --cwd apps/desktop test:rust  # cargo test: nav.rs (в CI GitLab cargo нет)
```

Релизная сборка: `bun run --cwd apps/desktop build` (установщики — в `src-tauri/target/release/bundle`).

## Релиз

Установщики собирает GitHub Actions (`.github/workflows/desktop.yml`) на публичном зеркале; GitLab
CI приложение не собирает.

1. Поднять `version` в `src-tauri/Cargo.toml` — единственный источник версии: в `tauri.conf.json`
   её нет, Tauri берёт из `Cargo.toml` (`package.json` — служебный пакет монорепо, `0.0.0`).
   Обновить `Cargo.lock`: `cargo update -p gamecrate-desktop --manifest-path src-tauri/Cargo.toml`.
2. Закоммитить в `main` и поставить в GitLab тег `desktop-vX.Y.Z` (например `desktop-v0.1.0`).
   Теги сервера `vX.Y.Z` сборку не запускают.
3. GitLab push mirror переносит ветки и теги на GitHub — на тег срабатывает workflow `desktop`:
   три джоба (macOS universal, Windows, Linux) без релиза GitHub.
4. Установщики — артефакты запуска на вкладке Actions: `gamecrate-macos` (`.dmg`, `.app.tar.gz`),
   `gamecrate-windows` (NSIS `.exe`), `gamecrate-linux` (`.AppImage`, `.deb`). Хранятся 30 дней.

Проверить сборку без тега: Actions → `desktop` → Run workflow на нужной ветке (в поле «Адрес
сайта» можно задать свой `GAMECRATE_URL`, пустое — прод).

Сборки **без подписи кода** (сертификатов нет; шаги подписи в workflow закомментированы):

- macOS: открыть `.dmg`, перетащить приложение в «Программы», первый запуск — ПКМ → «Открыть»
  (иначе Gatekeeper не пустит);
- Windows: SmartScreen покажет «Windows защитила ваш компьютер» — «Подробнее» → «Выполнить в любом
  случае».

## Раздача и манифест обновлений

Установщики и манифест `latest.json` (формат updater Tauri v2) лежат в бакете `cg-desktop` на
RustFS главного сервера, а наружу их отдаёт API без авторизации:

- `GET /download/desktop/latest.json` — манифест (`Cache-Control: no-cache`);
- `GET /download/desktop/<X.Y.Z>/<файл>` — файлы версии (кэш на год, `immutable`).

Ключи бакета (`DESKTOP_S3_*`) — в окружении `cg-api`, см. `deploy/README.md`. Без ключей раздача
выключена: оба адреса отвечают 404, а страница `/download` показывает «Скоро».

Страница сайта `/download` читает `latest.json`: берёт версию, ссылки и размеры из поля
`downloads` (установщики: macOS `.dmg`, Windows `-setup.exe`, Linux `.AppImage`), а если его нет —
ссылки updater из `platforms`.

### `scripts/manifest.ts`

Собирает `latest.json` из скачанных артефактов сборки (джоб публикации в `desktop.yml`):

```sh
bun apps/desktop/scripts/manifest.ts \
  --tag desktop-v0.1.0 --dir artifacts --out latest.json \
  --base-url https://game.brofrong.ru/download/desktop \
  [--notes "Что нового" | --notes-file notes.md] [--pub-date 2026-11-16T12:00:00Z]
```

- `--dir` — каталог артефактов (ищется рекурсивно, как кладёт `download-artifact`). Для каждой
  платформы нужен ровно один файл обновления (`.app.tar.gz`, `-setup.exe`, `.AppImage`) и `.sig`
  рядом; подпись попадает в манифест. Нет файла, нет `.sig` или их несколько — ненулевой код: лучше
  ничего не опубликовать, чем выпустить манифест, на который updater упадёт у всех.
- macOS — один универсальный архив, он записывается и под `darwin-aarch64`, и под `darwin-x86_64`.
- В stdout — пути файлов к загрузке (файл обновления, его `.sig`, установщик `.dmg`), по одному в
  строке, относительно `--dir`. Каждый файл кладётся в бакет как `<X.Y.Z>/<имя файла>`, а
  `latest.json` — в корень бакета, **последним**: пока манифеста нет или он старый, новая версия
  никому не видна.

Проверка: `bun run --cwd apps/desktop test`.
