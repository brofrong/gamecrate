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
