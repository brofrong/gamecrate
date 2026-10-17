# Образ сессии `cg-session:<версия драйвера>`

Selkies 2.0 (`ghcr.io/selkies-project/selkies-egl-desktop:26.04`, KDE Plasma на Wayland) + Steam.
Видео — WebRTC по одному UDP-порту, NVENC H.264, захват Wayland zero-copy. Игра запускается сама
при входе в графическую сессию. Основа — рабочий конфиг спайка (`spike/`).

## Файлы

- `Dockerfile` — 32-битные библиотеки NVIDIA версии драйвера хоста (Steam 32-битный, toolkit их не
  прокидывает), постоянные настройки Selkies (`ENV`), `cg-launch` + автостарт.
- `cg-launch` — `steam -silent -applaunch "$CG_APP_ID"`; пустой `CG_APP_ID` — ничего не делает,
  не число — ошибка (exit 1). Запускает игру не больше одного раза за жизнь контейнера: замок
  `mkdir /tmp/cg-launch.lock` (`/tmp` — слой контейнера, не том `/home/ubuntu`); если Plasma
  перезапустится и автостарт сработает снова — `[cg-launch] already launched …, skipping`.
- `cg-launch.desktop` → `/etc/xdg/autostart/`: KDE запускает `cg-launch` внутри сессии Plasma,
  где есть `LD_PRELOAD` интерпозера ввода Selkies (иначе Steam не видит геймпад, спека §7.3).
- `.dockerignore` — в контекст сборки идут только эти файлы и `nv/x/32/`.

## Сборка

```sh
./deploy/build-session-image.sh            # воркер по умолчанию: brofrong
```

rsync этого каталога в `~/cg-session-image` на воркере, версия драйвера из `nvidia-smi`, скачивание
`NVIDIA-Linux-x86_64-<ver>.run` и `--extract-only` в `nv/x` (кешируется, повторно не качается),
`docker build --build-arg NV_VER=<ver> -t cg-session:<ver>`. После обновления драйвера на хосте
образ нужно пересобрать — тег сменится сам.

## Контракт контейнера (задаёт агент)

| Что                           | Значение                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CG_APP_ID`                   | appid игры для автозапуска                                                                                                                                                                          |
| `SELKIES_WEBRTC_UDP_MUX_PORT` | UDP-порт слота, публикуется наружу 1:1 (`-p P:P/udp`)                                                                                                                                               |
| `SELKIES_WEBRTC_PUBLIC_IP`    | публичный IP воркера                                                                                                                                                                                |
| том на `/home/ubuntu`         | дом пользователя: вход Steam, игры, сохранения                                                                                                                                                      |
| метка                         | `cg.session=<sessionId>`                                                                                                                                                                            |
| сеть                          | `cg-sessions` (bridge); веб-порт 8080 наружу не публикуется                                                                                                                                         |
| GPU                           | `--runtime nvidia --gpus all --shm-size 2g`                                                                                                                                                         |
| права                         | `--security-opt no-new-privileges:true`: setuid (`sudo-root`, `su`, `pkexec`) не поднимает права; базовый образ без него даёт `ubuntu` root (`NOPASSWD: ALL`)                                       |
| `/dev/input`                  | `--tmpfs /dev/input:mode=1777,size=64k,nosuid,nodev,noexec`: entrypoint создаёт каталог через `sudo-root`, при `no-new-privileges` — не может; без каталога интерпозер геймпадов не работает        |
| `PASSWD`                      | случайный на каждый контейнер (по умолчанию в базовом образе — `mypasswd`); при `no-new-privileges` entrypoint его не применит (`selkies: cannot change the password of ubuntu` в логе — ожидаемо)  |
| Debian                        | GBM-бэкенд: `/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.<ver>` → `/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1` и `/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so` (ro) |

Зашито в образ: `SELKIES_MODE=webrtc`, `SELKIES_WAYLAND=true`, `SELKIES_ENCODER=h264enc`,
`SELKIES_RATE_CONTROL_MODE=cbr`, `SELKIES_VIDEO_BITRATE=10000,2000-40000`,
`SELKIES_FRAMERATE=60,30-120`, `SELKIES_KEYFRAME_INTERVAL=2`, `SELKIES_WEBRTC_ICE_LITE=true`,
`SELKIES_ENABLE_HTTPS=false`, `SELKIES_ENABLE_BASIC_AUTH=false`, `SELKIES_UI_SHOW_SIDEBAR=false`,
`SELKIES_ENABLE_DUAL_MODE=false` (клиент не может переключить медиа на websockets/TCP),
`SELKIES_WAYLAND_X11_FALLBACK=false`, `SELKIES_MANUAL_WIDTH=1920`, `SELKIES_MANUAL_HEIGHT=1080`,
`TZ=Europe/Moscow`.

**Разрешение зафиксировано 1920x1080.** Без этого Selkies подгоняет экран под окно браузера при
подключении (на Mac с Retina — 2560x1600, scale 2), при ресайзе и полноэкранном режиме. Vampire
Survivors (Unity, X11 через XWayland) на такой смене падает: в `Player.log`
`X Error of failed request: BadRROutput (RRGetOutputInfo)`, процесс игры завершается через 2 с после
подключения клиента. С фиксированным разрешением браузер просто масштабирует картинку, игра живёт
при подключении, переподключении и ресайзе окна.

## Ручная проверка на brofrong (2026-10-17, риск №3 спеки)

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
