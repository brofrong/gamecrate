# Образ сессии `cg-session:<версия драйвера>`

Образ-киоск: Selkies 2.0 `base` (`ghcr.io/selkies-project/selkies/base:2.0.0-ubuntu26.04`,
закреплён по digest; без рабочего стола) + вложенный композитор labwc + Steam. Видео — WebRTC по
одному UDP-порту, NVENC H.264, захват Wayland zero-copy. В трансляции — только окна Steam и игры:
нет рабочего стола, панели, меню, терминала, файлового менеджера, браузера; горячие клавиши
композитора (Alt+F4, Alt+Tab, меню фона) выключены; буфер обмена, передача файлов и печать Selkies
выключены. Игра запускается сама при старте сессии (автостарт labwc).

Прежний образ — KDE Plasma на `selkies-egl-desktop:26.04` (в истории git до плана 4); пока он —
рабочий `cg-session:550.163.01`. Когда киоск заменит рабочий тег (Task 9, по слову владельца), прежний
сохранится как `cg-session:550.163.01-kde` для отката; `cg-session-exec` его поддерживает. Проба,
из которой взят рецепт, — `spike/kiosk/` и спека плана 4, «Результаты» → «Проба киоска».

## Файлы

- `Dockerfile` — база по digest; Steam (`steam-launcher` из репозитория Valve), `proot`/`proot-bwrap`,
  `python3-gi` для `cg-nm-stub`, `libfakechroot`; без `xterm` (зависимость `steam-launcher`, удаляется);
  32-битные библиотеки NVIDIA версии драйвера хоста (Steam 32-битный, toolkit их не прокидывает);
  постоянные настройки Selkies (`ENV`), `cg-launch` + автостарт labwc, скрипты профиля; каталоги
  `~/.local/share/Steam/steamapps` и `~/.steam` (с родителями) заранее, владелец `ubuntu`; `PATH` с
  `/usr/games`.
- `cg-launch` — `steam -silent -applaunch "$CG_APP_ID"`; пустой `CG_APP_ID` — ничего не делает,
  не число — ошибка (exit 1). Непустой `CG_GAME` (план «свои игры») — своя игра вместо Steam:
  `exec /usr/local/bin/cg-game-exit "$CG_GAME"` (`CG_GAME_EXIT` — другой путь обёртки, тесты); не
  исполняемый файл — ошибка (exit 1); проверяется раньше `CG_APP_ID`, тем же замком. `CG_MODE=install`
  (установщик) — `steam -silent` без игры, `CG_APP_ID`/`CG_GAME` не нужны. Запускает Steam/игру не
  больше одного раза за жизнь контейнера: замок
  `mkdir /tmp/cg-launch.lock` (`/tmp` — слой контейнера, не том `/home/ubuntu`; `CG_LAUNCH_LOCK` —
  другой путь, для тестов); если композитор перезапустится и автостарт сработает снова —
  `[cg-launch] already launched …, skipping`.
- `labwc/autostart` → `/etc/xdg/labwc/autostart`: поднимает сессионную шину D-Bus по фиксированному
  адресу `unix:path=${XDG_RUNTIME_DIR}/bus` (`dbus-daemon --session --fork`; в базе её никто не
  поднимает, а Steam и `cg-steam-shutdown` её ищут; если шина уже отвечает — например, labwc
  перезапустился, — берёт её) и запускает `cg-launch` в
  окружении сессии labwc — там `LD_PRELOAD` интерпозера ввода Selkies (иначе Steam не видит
  геймпад, спека §7.3), `DISPLAY=:0` (Xwayland), `WAYLAND_DISPLAY=wayland-0`. Служба
  `/etc/service/wayland` базы запускает labwc напрямую, без systemd user, поэтому
  `/etc/xdg/autostart/*.desktop` здесь не работает.
- `labwc/rc.xml` → `/etc/xdg/labwc/rc.xml` (заменяет штатный): без рамок, зазора и панели задач;
  правило окна при первом показе — `Maximize` (1920x1080 в 0,0) для всех окон, кроме служебных
  типов `_NET_WM_WINDOW_TYPE` (диалоги, utility, меню, подсказки… — через `If`/`else`); окна без
  типа считаются обычными. Свойства «во весь экран» у labwc 0.9.7 нет (`fullscreenForced` он молча
  пропускал), `ignoreConfigureRequest` убран: развёрнутому окну labwc геометрию менять не даёт сам,
  а у плавающих X-координаты теперь совпадают с местом в кадре. Одна безвредная привязка
  клавиши и фокус по клику — пустые `<keyboard>`/`<mouse>` labwc 0.9.7 отвергает и грузит
  встроенные Alt+F4/Alt+Tab/меню. Оба файла — в `/etc/xdg`, не в `~/.config` (тот — профиль игрока).
- `vendor/` — то, чего нет в `base`, взято из `ghcr.io/selkies-project/selkies-egl-desktop@sha256:92c80f75c0a6bdfabd1cbac650690e0260a1726ef0b3164d7be8ff60f55a30fa`
  (`26.04`, собран 2026-09-12; там `proot`, `proot-bwrap`, обёртки `steam`/`steamdeps` ставит
  `install.sh` из `github.com/selkies-project/proot-bwrap`, ref `main`) без изменений, чтобы новый
  воркер не тянул 9,5 ГБ десктопного образа ради нескольких файлов:
  - `steam.gpg` → `/usr/share/keyrings/` — публичный ключ apt Valve (RSA 2048, 2012), sha256
    `98e9fc5b108bba854f03021a8ac38a5cbb01c32cb723c37433967c0d5d3db763`; `steam-stable.list` → `/etc/apt/sources.list.d/` — `repo.steampowered.com/steam
    stable` (`signed-by` этим ключом). Из него ставится `steam-launcher` 1:1.0.0.87 (как в KDE-образе):
    Debian `steam-installer` висит на диалоге zenity и ставит клиент в `~/.steam/debian-installation`.
  - `proot` → `/usr/local/bin/` — proot 5.5.0 (ELF x86-64, нужен `libtalloc2`), sha256
    `5ca5290b8248cece55f89aa94dcfce104faf92f69bf111b9fb11d1907ee17b7e`. В apt базы — 5.4.0, а `proot-bwrap` требует ≥ 5.5.0 (старые оставляют свой
    временный файл в `AT_EXECFN`, и coreutils Ubuntu 25.10+ не работают). При обновлении — брать из
    свежего `selkies-egl-desktop` или собрать из `proot-me/proot` ≥ 5.5.0.
  - `proot-bwrap` → `/usr/local/bin/` — Python-скрипт (MPL-2.0, Selkies) вместо `bwrap` для
    pressure-vessel и `steamwebhelper` без user namespaces; sha256 `de6dd745726075b00a0e7cff3d3a15e08d87fc755c63ac005603c7d314953045`. Ищет `proot`
    рядом с собой; запасной режим — `libfakechroot`.
  - `steam` → `/usr/bin/steam` (оригинал уведён `dpkg-divert` в `steam.distrib`) — `BWRAP=/usr/local/bin/proot-bwrap`
    и `exec /usr/lib/steam/steam`; `steamdeps` → `/usr/bin/steamdeps` — `exit 0` (зависимости уже
    стоят, ставить их нечем: нет root и терминала).
- `cg-profile-pack` — профиль из `$HOME` в `/tmp/cg-profile.tar` (GNU tar, записи 1000:1000) по
  whitelist: `.local/share/Steam/config` (без `htmlcache`, `avatarcache`), `.local/share/Steam/local.vdf`,
  `.local/share/Steam/userdata`, `.steam/registry.vdf`, `.config`, всё в `.local/share` кроме `Steam`,
  `steamapps/compatdata/*/pfx/drive_c/users/steamuser` и `…/pfx/user.reg` (сохранения и реестр
  Proton), `steamapps/common/Steam Controller Configs`. Несуществующие пути пропускаются. Перед путями —
  записи всех каталогов-родителей (от `.local`/`.steam`): иначе при распаковке Docker создаёт их от
  root, и Steam молча выходит (`bin_steam.sh: ln: Permission denied`). `--list` — только напечатать
  записи. Агент зовёт его `docker exec` при остановке и как entrypoint помощника импорта старого тома.
- `cg-session-exec <команда>` — выполнить команду в окружении процесса сессии (`docker exec` его не
  знает): переменные `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`,
  `HOME`, `USER`, `LD_PRELOAD`, `XAUTHORITY`, `XDG_SESSION_TYPE` из `/proc/<pid>/environ` первого
  найденного: клиент Steam (`ubuntu12_32/steam`), композитор `labwc`, `plasmashell` (образ KDE).
  Для labwc `WAYLAND_DISPLAY=wayland-0`: в его `/proc/environ` — `wayland-1`, сокет внешнего
  композитора захвата Selkies (сокет `wayland-0` слушает labwc, `wayland-1` — `selkies`; проверено
  смоуком), и `DBUS_SESSION_BUS_ADDRESS=unix:path=<XDG_RUNTIME_DIR labwc>/bus` — шина автостарта
  (в окружении labwc её нет). Нет ни одного — exit 1.
- `cg-steam-shutdown` — `steam -shutdown` через `cg-session-exec` (без `DISPLAY` и т.п. —
  «Unable to open X11 display»), ждёт выхода `ubuntu12_32/steam` до 30 с. Клиент не запущен — 0;
  не вышел — 1.
- `cg-nm-stub` → `/usr/local/bin/`: заглушка `org.freedesktop.NetworkManager` на системной шине
  контейнера (python3 + dbus-python из базового образа). Отвечает «сеть есть»: одно активное
  ethernet-устройство `eth0` (`State=100`), активное соединение, `State=70`, `Connectivity=4`;
  раз в 2 с шлёт `StateChanged`/`PropertiesChanged`. Без неё Steam перед каждым входом ждёт
  NetworkManager 20 с (`[ WaitingForNetwork ] Timed out waiting for network` в
  `logs/steamui_login.txt`): службы NetworkManager в контейнере нет. Одних `State`/`Connectivity`
  мало — Steam ждёт активное устройство. Сеть контейнера заглушка не трогает.
  `cg-nm-stub.run`/`cg-nm-stub.finish` → служба s6 `/etc/service/cg-nm-stub` (от `ubuntu`, ждёт
  сокет системной шины); `cg-nm-stub.conf` → `/etc/dbus-1/system.d/`: владеть именем может
  только `ubuntu`. Проверка в живой сессии:
  `docker exec cg-session-<id> dbus-send --system --print-reply --dest=org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.DBus.Properties.Get string:org.freedesktop.NetworkManager string:State`
  → `uint32 70`.
- `cg-session-stage` → `/usr/local/bin/`: этап запуска игры для экрана загрузки (план §4.1/§4.2):
  `cg-session-stage <appid>` печатает одно слово `steam|login|prepare|loading|visible` и exit 0;
  appid не число — exit 2. Проверки от последнего этапа к первому: `visible` — у `reaper` с
  `AppId=<appid>` есть видимое окно ≥ 64×64 (`xdotool search --onlyvisible --class
  "^steam_app_<appid>$"` для Proton или окно потомка `reaper` для нативной игры, размер —
  `xwininfo -id`; окружение X11 — из `/proc/<pid клиента Steam>/environ`, без KDE-сессии не
  нужен); `loading` — есть процесс, чья командная строка начинается с `<буква>:\common\` (так
  Proton запускает exe игры; служебные exe самого Proton и Windows не в счёт); `prepare` — есть
  `reaper` с `AppId=<appid>`; `login` — в `logs/steamui_login.txt` есть строка `SetLoginState`;
  иначе `steam`. `cg-session-stage --own` (своя игра, план «свои игры», без Steam/`reaper`) печатает
  `computer|loading|visible` и всегда exit 0: обёртка `cg-game-exit /opt/cg-game/run` находится по
  `pgrep -f` (шаблон собирается внутри скрипта, как `AppId=<appid>` выше); `visible` — у её потомка
  (игра — прямой потомок, `run` делает `exec`) есть видимое окно ≥ 64×64, окружение X11 — из
  `/proc/<pid обёртки>/environ`; `loading` — обёртка жива, окна нет; иначе `computer`. Агент зовёт
  `docker exec` раз в 2 с.
- `cg-game-exit` → `/usr/local/bin/`: обёртка процесса игры (спека «требования к железу» §4.2):
  `cg-game-exit <команда…>` запускает команду, пишет `code <n>` в `/tmp/cg-game-exit` и выходит с
  тем же статусом (смерть от сигнала — `128+n`). Steam зовёт её через `LaunchOptions` игры, которые
  агент пишет в `localconfig.vdf` контейнера до старта и убирает перед снятием профиля; агент
  читает файл, когда процесс игры пропал.
- `.dockerignore` — в контекст сборки идут только эти файлы, `labwc/`, `vendor/` и `nv/x/32/`.

## Сборка

```sh
./deploy/build-session-image.sh                  # воркер по умолчанию: brofrong → cg-session:<ver>
./deploy/build-session-image.sh brofrong kiosk   # → cg-session:<ver>-kiosk, рабочий тег не трогается
```

rsync этого каталога в `~/cg-session-image` на воркере, версия драйвера из `nvidia-smi`, скачивание
`NVIDIA-Linux-x86_64-<ver>.run` и `--extract-only` в `nv/x` (кешируется, повторно не качается),
`docker build --build-arg NV_VER=<ver> -t cg-session:<ver>[-<суффикс>]`. После обновления драйвера на
хосте образ нужно пересобрать — тег сменится сам. Суффикс — чтобы собрать новый образ рядом с
рабочим: агент берёт тот, что в `SESSION_IMAGE`.

### Шаблон клиента Steam (`STEAM_CLIENT_DIR`)

```sh
./deploy/build-steam-client.sh            # воркер по умолчанию: brofrong
```

Lower overlay `~/.local/share/Steam` сессий и установщиков — клиент Steam, скачанный этим образом
(~2,5 ГБ, без входа, без игр, пустой `steamapps/` 1000:1000). Скрипт запускает контейнер образа с пустым
домом и `CG_MODE=install` (`cg-launch` → `steam -silent`), дважды ждёт входа клиента в цикл
(`logs/connection_log.txt` и 60 с без роста каталога больше 1 МБ, без `logs/`, `htmlcache/`,
`dumps/`) и закрывает его `cg-steam-shutdown` (второй цикл — `steam -silent` через `docker exec` и
`cg-session-exec`, в окружении сессии, как в `cg-steam-shutdown`: за один цикл `steamrt64`/`appcache` распакованы не до
конца), копирует `~/.local/share/Steam` без `logs/` и заменяет каталог
переименованием. Подробности и когда пересобирать — `deploy/README.md`, «Клиент Steam: пересборка
шаблона». Образ при этом не меняется: шаблон зависит от клиента Steam, а не от драйвера.

## Контракт контейнера (задаёт агент)

| Что                           | Значение                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CG_APP_ID`                   | appid игры для автозапуска                                                                                                                                                                          |
| `SELKIES_WEBRTC_UDP_MUX_PORT` | UDP-порт слота, публикуется наружу 1:1 (`-p P:P/udp`)                                                                                                                                               |
| `SELKIES_WEBRTC_PUBLIC_IP`    | публичный IP воркера                                                                                                                                                                                |
| дом `/home/ubuntu`            | слой контейнера; профиль (вход Steam, сохранения) агент кладёт архивом в созданный контейнер до старта (`PUT /containers/{id}/archive`), при остановке снимает `cg-profile-pack`                    |
| том `cg-s-<id>-client`        | overlay (lower — чистый клиент Steam `STEAM_CLIENT_DIR`, upper — `SCRATCH_DIR/<id>/client`) на `/home/ubuntu/.local/share/Steam`                                                                    |
| том `cg-s-<id>-apps`          | overlay (lower — библиотека `LIBRARY_DIR/steamapps`, upper — `SCRATCH_DIR/<id>/apps`) на `/home/ubuntu/.local/share/Steam/steamapps`                                                                |
| метки                         | `cg.session=<sessionId>`, `cg.slot`, `cg.app`, `cg.user=<userId>`, `cg.base-version` (версия профиля, из которой собран дом; пусто — профиля не было)                                               |
| сеть                          | `cg-sessions` (bridge); веб-порт 8080 наружу не публикуется                                                                                                                                         |
| GPU                           | `--runtime nvidia --gpus all --shm-size 2g`                                                                                                                                                         |
| права                         | `--security-opt no-new-privileges:true`: setuid (`sudo-root`, `su`, `pkexec`) не поднимает права; базовый образ без него даёт `ubuntu` root (`NOPASSWD: ALL`)                                       |
| `/dev/input`                  | `--tmpfs /dev/input:mode=1777,size=64k,nosuid,nodev,noexec`: entrypoint создаёт каталог через `sudo-root`, при `no-new-privileges` — не может; без каталога интерпозер геймпадов не работает        |
| `PASSWD`                      | случайный на каждый контейнер (по умолчанию в базовом образе — `mypasswd`); при `no-new-privileges` entrypoint его не применит (`selkies: cannot change the password of ubuntu` в логе — ожидаемо)  |
| Debian                        | GBM-бэкенд: `/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.<ver>` → `/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1` и `/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so` (ro) |

### Установщик (агент с ролью `gamestore`)

Тот же образ и те же GPU, права, `/dev/input`, GBM, сеть `cg-sessions`, но контейнер
`cg-install-<jobId>`: `CG_MODE=install`, без `CG_APP_ID` и без UDP-порта, метки
`cg.install=<jobId>`, `cg.app`, `cg.user`; тома `cg-i-<jobId>-client` с upper в
`SCRATCH_DIR/.install/<jobId>` (NVMe) и `cg-i-<jobId>-apps` с upper в `INSTALL_SCRATCH_DIR/<jobId>`
(та же ФС, что `LIBRARY_DIR`). Профиль пользователя кладётся как у
сессии, а в `steamapps` до старта — заготовка `appmanifest_<appId>.acf` со `StateFlags 1026`
(1000:1000, 0644): Steam сам ставит игру и её зависимости. Агент читает манифест `docker exec cat`,
по `StateFlags 4` сохраняет профиль, удаляет контейнер и тома и переносит `rename` из upper в
библиотеку только новые приложения (каталог `common/<installdir>`, затем манифест).

Зашито в образ: `SELKIES_MODE=webrtc`, `SELKIES_WAYLAND=true`, `SELKIES_ENCODER=h264enc`,
`SELKIES_RATE_CONTROL_MODE=cbr`, `SELKIES_VIDEO_BITRATE=10000,2000-40000`,
`SELKIES_FRAMERATE=60,30-120`, `SELKIES_KEYFRAME_INTERVAL=2`, `SELKIES_WEBRTC_ICE_LITE=true`,
`SELKIES_ENABLE_HTTPS=false`, `SELKIES_ENABLE_BASIC_AUTH=false`, `SELKIES_UI_SHOW_SIDEBAR=false`,
`SELKIES_ENABLE_DUAL_MODE=false` (клиент не может переключить медиа на websockets/TCP),
`SELKIES_WAYLAND_X11_FALLBACK=false`, `SELKIES_MANUAL_WIDTH=1920`, `SELKIES_MANUAL_HEIGHT=1080`,
`SELKIES_WAYLAND_COMPOSITOR=labwc` (в `base` пусто → автоопределение, тоже labwc),
`SELKIES_ENABLE_CLIPBOARD=false`, `SELKIES_FILE_TRANSFERS=none`, `SELKIES_PRINTING_ENABLED=false`
(в `base` все три включены по умолчанию), `TZ=Europe/Moscow`, `PATH` с `/usr/local/games:/usr/games`.

**Разрешение зафиксировано 1920x1080.** Без этого Selkies подгоняет экран под окно браузера при
подключении (на Mac с Retina — 2560x1600, scale 2), при ресайзе и полноэкранном режиме. Vampire
Survivors (Unity, X11 через XWayland) на такой смене падает: в `Player.log`
`X Error of failed request: BadRROutput (RRGetOutputInfo)`, процесс игры завершается через 2 с после
подключения клиента. С фиксированным разрешением браузер просто масштабирует картинку, игра живёт
при подключении, переподключении и ресайзе окна.

## Ручная проверка образа-киоска на brofrong (2026-10-28, план 4, Task 7)

`./deploy/build-session-image.sh brofrong kiosk` → `cg-session:550.163.01-kiosk`, 4,75 ГБ (KDE —
9,68 ГБ); `cg-session:550.163.01` при сборке не изменился (id `96225fee6f18` до и после). Контейнер
`cg-kiosk-smoke` с флагами `desktopSpec` (GPU, GBM, `no-new-privileges`, tmpfs `/dev/input`, сеть
`cg-sessions`, `-p 59001:59001/udp`), метка `cg.probe=kiosk`, пустой дом, `CG_MODE=install`
(запуск — `spike/kiosk/gpu-run.sh`); браузер — headless Chrome на Mac через `ssh -L` на веб-порт.
Время — от `docker run`.

| Что | Результат |
| --- | --- |
| `GET /api/status` 200 | 8,9 с |
| процесс `ubuntu12_32/steam` | 11,9 с; `[cg-launch] install mode: steam -silent` из автостарта labwc |
| Кодирование (после подключения браузера) | `[Wayland] Encoder: NVENC H264 4:2:0 on NVIDIA GeForce GTX 1650 SUPER`, `Zero-copy capture: output 1 1920x1080 rendered on /dev/dri/renderD128, encoded in place on NVENC`, `CBR 10000`, 60 fps |
| WebRTC | UDP mux 59001, `CandidatePair(('37.153.14.138', 59001) -> …) SUCCEEDED`, `ICE completed` |
| Окно входа Steam | 170,2 с (пустой дом — почти всё время скачивание клиента); `cg-session-exec xdotool search --onlyvisible --class steam` → одно окно «Sign in to Steam», 700x440 |
| `cg-session-stage 1966900` | `steam` до окна входа, `login` на нём |
| NetworkManager `State` | `uint32 70` |
| Окружение Steam | `LD_PRELOAD` с `selkies_input_interposer.so`, `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`, `DBUS_SESSION_BUS_ADDRESS` (тогда — от `dbus-launch`; после правки — `unix:path=/tmp/runtime-ubuntu/bus`, см. ниже), `BWRAP=/usr/local/bin/proot-bwrap`; `XAUTHORITY` нет (не нужен) |
| Сокеты Wayland | `wayland-0` слушает `labwc` (сессия), `wayland-1` — `selkies` (захват); в `/proc/<labwc>/environ` — `wayland-1`. Selkies: `Wayland app compositor 'wayland-0' … capture stays on 'wayland-1'` |
| Трансляция | только окно Steam на чёрном фоне: нет рабочего стола, панели, рамки; процессов `plasma`/`kwin`/`lxqt`/панелей/терминалов нет |
| Пакеты (`dpkg -l`) | ни терминала (`xterm` удалён, `x-terminal-emulator` нет), ни файлового менеджера, ни браузера |
| Окно во весь экран, нажимается | с правилом `fullscreenForced` (не существует в labwc) — нет: окно входа 700x440 в левом верхнем углу кадра, X сообщает 610,320. Исправлено, см. «Правка 1» ниже |
| Буфер обмена | `Rejecting clipboard read: outbound clipboard disabled` |
| `cg-steam-shutdown` | 0 за 3,1 с, клиента `ubuntu12_32/steam` нет |
| `cg-session-exec` без Steam (labwc) | `WAYLAND_DISPLAY=wayland-0`, `DISPLAY=:0`; `xdotool` работает |
| `cg-profile-pack --list` / `cg-profile-pack` | 0, 16 записей (`.steam/registry.vdf`, `.config/…`, `.local/share/…`) |
| GPU (браузер подключён, окно входа) | 301 МиБ VRAM, GPU 1 %, NVENC 15 % |

Не проверено этим смоуком: вход в аккаунт и запуск игры (нужен аккаунт игрока), геймпад, звук,
клавиатура в настоящем браузере (на пробе подтвердил владелец), окна игр во весь экран — Task 9.

### Правка 1 (2026-10-28): шина по фиксированному адресу, окна во весь экран

Тот же запуск (`cg-kiosk-smoke`, пустой дом, `CG_MODE=install`); `rc.xml` сначала проверен в живом
контейнере (`~/.config/labwc/rc.xml` + `SIGHUP` labwc), затем — образ с ним в `/etc/xdg`
(результаты ниже совпали).

| Что | Результат |
| --- | --- |
| Шина у Steam | `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/runtime-ubuntu/bus` (`dbus-daemon --session --fork --address=…` от автостарта) |
| После `cg-steam-shutdown` (0) | `cg-session-exec env` (источник labwc): `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`, та же шина; `dbus-send --session … ListNames` отвечает |
| `cg-session-exec bash -c 'steam -silent'` | клиент поднялся за 2 с, у него та же шина, `wayland-0`, `:0` |
| `xev` (окно без типа, изменяемое) | X: 1920x1080 в 0,0, `_NET_WM_STATE_MAXIMIZED_VERT/HORZ`; в кадре — на весь экран |
| Окно входа Steam (тип NORMAL, min = max 700x440) | X: 1920x1080 в 0,0, развёрнуто; Steam растягивает разметку на весь экран. Клик в трансляции по «Remember me» переключил галку, указатель X — 51,281 = точка клика |
| Окна типов dialog/utility (тестовое X-окно 300x200) | не развёрнуты: 810,440 / 842,472; в кадре — на 810,440, совпадает с X |
| Override-redirect окно (как выпадающие меню Steam) в X 400,300 | в кадре на 400,300 |
| zenity (GTK, тип NORMAL без родителя) | развёрнуто — ожидаемо по правилу |

## Ручная проверка на brofrong (2026-10-17, риск №3 спеки, прежний образ KDE)

Bridge-сеть `cg-sessions`, копия дома спайка (вход Steam владельца, Vampire Survivors 1794680),
`-p 59001:59001/udp`, `SELKIES_WEBRTC_UDP_MUX_PORT=59001`, `CG_APP_ID=1794680`, метка
`cg.session=manual`. Спайк на время проверки остановлен (одна GPU).

| Что                                                                          | Результат                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Сборка                                                                       | `cg-session:550.163.01`, 9.68 ГБ (слои общие с базой; свой слой — библиотеки и `cg-launch`)                                                                            |
| Лог Selkies                                                                  | `Selkies 2.0.0 starting: webrtc transport, Wayland capture, encoder h264enc at 30-120 fps, fixed 1920x1080`                                                            |
| Кодирование                                                                  | `[Wayland] Encoder: NVENC H264 4:2:0 on NVIDIA GeForce GTX 1650 SUPER`, `Zero-copy capture ... encoded in place on NVENC`, `CBR 10000`, 60 fps                         |
| UDP в bridge-сети                                                            | `WebRTC UDP mux: every session's host candidates share UDP port 59001 on 172.29.0.2`                                                                                   |
| `GET http://cg-session-manual:8080/api/status` из контейнера в `cg-sessions` | 200 через ~6,5 с после `docker run`                                                                                                                                    |
| Вход в Steam                                                                 | автологин, `LogOnResponse 'OK'`                                                                                                                                        |
| `CG_APP_ID` в автостарте                                                     | виден: переменные контейнера доходят до сессии Plasma и Steam (в окружении процесса `steam` есть `CG_APP_ID=1794680` и `LD_PRELOAD=...selkies_input_interposer.so...`) |
| Время до игры                                                                | **~40 с** от `docker run` до `VampireSurvivors.exe` (спайк: 37 с); `docker exec … pgrep -f "AppId=1794680"` находит процесс                                            |
| Стрим (браузер на Mac через интернет, `ssh -L` на веб-порт)                  | картинка игры идёт; WebRTC: удалённый кандидат `host udp 37.153.14.138:59001`, H.264 1920x1080, 60 fps, потерь 0, RTT 3 мс                                             |
| Ввод                                                                         | клавиатура доходит до игры (заставка → главное меню)                                                                                                                   |
| Нагрузка (меню игры)                                                         | GPU ~6–17 %, NVENC ~15 %, ~650 МБ VRAM на всю сессию                                                                                                                   |

Заметки:

- `pgrep -f "AppId=<id>"` надо вызывать напрямую (`docker exec <c> pgrep -f ...`); через `sh -c`
  он находит и сам `sh` с этой строкой в аргументах.
- `SELKIES_WAYLAND_X11_FALLBACK=false` (в базе `true`) запрещает молчаливый уход на X11-захват, но
  контейнер при этом не падает: без `nvidia-drm modeset=1` базовый entrypoint остаётся на Wayland с
  программным композитингом (`GPU: the compositor cannot reach it; compositing in software`).
  Признак здоровой сессии — в логе `Zero-copy capture ... encoded in place on NVENC`.
- Если локальное состояние облака Steam в доме отстало от облака (например, играли на другом
  устройстве или прошлый контейнер убит посреди игры), первый `-applaunch` может остановиться на
  диалоге Steam «Unable to Sync» (Play anyway / Cancel): игра не стартует, пока пользователь не
  ответит в стриме. Встретилось в смоук-проверке 2026-10-17; повторный `-applaunch` после Cancel
  запустил игру за 4 с.
- Selkies пропускает WebSocket-апгрейд только same-origin (Origin совпадает с Host), без Origin или
  из `SELKIES_ALLOWED_ORIGINS`. Через прокси api с `Origin: https://game.brofrong.ru` и
  `Host: cg-session-<id>:8080` будет 403 — это решается в прокси (Task 7).
