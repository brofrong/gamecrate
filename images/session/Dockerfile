# check=skip=SecretsUsedInArgOrEnv
# (SELKIES_ENABLE_BASIC_AUTH=false — не секрет, а выключатель)
# Образ сессии — киоск: Selkies 2.0 base (WebRTC + NVENC, Wayland zero-copy, без рабочего стола) +
# вложенный композитор labwc + Steam; игра стартует сама (cg-launch из автостарта labwc).
# Собирается на воркере под версию драйвера хоста: deploy/build-session-image.sh [хост] [суффикс] →
# cg-session:<NV_VER>[-<суффикс>]. Прежний образ на KDE Plasma (selkies-egl-desktop:26.04) — в
# истории git; при замене рабочего тега этим образом (Task 9) прежний сохраняется на воркере как
# cg-session:<NV_VER>-kde для отката.
# Контекст сборки: этот каталог + nv/x — распакованный NVIDIA-Linux-x86_64-<NV_VER>.run (--extract-only).
#
# Контракт окружения контейнера (задаёт агент):
#   CG_APP_ID                     appid игры для автозапуска (пусто — cg-launch ничего не запускает)
#   CG_MODE=install               установщик: только клиент Steam, без игры
#   SELKIES_WEBRTC_UDP_MUX_PORT   UDP-порт слота (публикуется наружу 1:1)
#   SELKIES_WEBRTC_PUBLIC_IP      публичный IP воркера
#   PASSWD                        пароль ubuntu, случайный (при no-new-privileges не применяется)
# Дом пользователя — слой контейнера; ~/.local/share/Steam (клиент Steam) и
# ~/.local/share/Steam/steamapps (библиотека) — overlay-тома сессии; профиль (вход Steam, сохранения)
# агент кладёт в созданный контейнер до старта и снимает cg-profile-pack при остановке.
# На Debian в контейнер пробрасывается GBM-бэкенд NVIDIA (libnvidia-allocator), см. README.md.
#
# База закреплена по digest: ghcr.io/selkies-project/selkies/base:2.0.0-ubuntu26.04 — тот же
# Selkies 2.0, что в selkies-egl-desktop:26.04, но без KDE Plasma (служб рабочего стола в ней нет
# вовсе) и без Steam. Проба на brofrong (драйвер 550): docs/superpowers/specs/2026-10-27-kiosk-image-design.md,
# «Результаты» → «Проба киоска».
FROM ghcr.io/selkies-project/selkies/base@sha256:191428b47ee11e6670547a5012a2a939c1b4df257a0a5293c226ab337c8a4723
ARG NV_VER=550.163.01
USER root

# Steam из репозитория Valve (steam-launcher, как в selkies-egl-desktop:26.04): Debian
# steam-installer из multiverse перед первым запуском висит на диалоге zenity и ставит клиент в
# ~/.steam/debian-installation, а не в ~/.local/share/Steam. Ключ apt (публичный) и строка
# источника — vendor/ (взяты из selkies-egl-desktop:26.04, README.md «Файлы»).
COPY --chmod=0644 vendor/steam.gpg /usr/share/keyrings/steam.gpg
COPY --chmod=0644 vendor/steam-stable.list /etc/apt/sources.list.d/steam-stable.list

# proot + proot-bwrap — замена bwrap для pressure-vessel и steamwebhelper без user namespaces
# (в контейнере их нет). proot из apt этой базы (5.4.0) не годится: proot-bwrap требует ≥ 5.5.0
# (старые оставляют свой временный файл в AT_EXECFN, и многофункциональные coreutils Ubuntu 25.10+
# не узнают себя) — поэтому proot 5.5.0 тоже из vendor/. proot-bwrap ищет proot рядом с собой.
COPY --chmod=0755 vendor/proot vendor/proot-bwrap /usr/local/bin/

# python3-gi + gir1.2-glib-2.0 — для cg-nm-stub (без них `No module named 'gi'`); libfakechroot
# (обе архитектуры) — запасной режим proot-bwrap (им идёт steamwebhelper); libtalloc2 — для proot.
# Всё остальное, что нужно скриптам, в базе уже есть: i386, python3-dbus, системная шина (служба
# s6 dbus; dbus-daemon/dbus-send — и для сессионной шины), xdotool, x11-utils, curl, procps.
# /usr/bin/steam и /usr/bin/steamdeps уводятся dpkg-divert (как в selkies-egl-desktop:26.04) и
# заменяются обёртками из vendor/: steam — с BWRAP=/usr/local/bin/proot-bwrap, steamdeps — exit 0
# (зависимости уже стоят, ставить их некому и нечем).
# xterm приходит зависимостью steam-launcher (терминал для steamdeps, который здесь заглушка) —
# киоску терминал не нужен, удаляется с --force-depends (apt в готовом образе никто не запускает).
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
         steam-launcher steam-libs-amd64 steam-libs-i386:i386 \
         python3-gi gir1.2-glib-2.0 \
         libfakechroot:amd64 libfakechroot:i386 libtalloc2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg --purge --force-depends xterm \
    && ! command -v xterm >/dev/null && ! command -v x-terminal-emulator >/dev/null \
    && dpkg-divert --local --rename --add /usr/bin/steam \
    && dpkg-divert --local --rename --add /usr/bin/steamdeps \
    && ln -sfn bin_steam.sh /usr/lib/steam/steam \
    && /usr/local/bin/proot --version >/dev/null
COPY --chmod=0755 vendor/steam vendor/steamdeps /usr/bin/

# Клиент Steam 32-битный, а NVIDIA Container Toolkit прокидывает только 64-битные библиотеки.
# Версия должна совпадать с драйвером хоста.
COPY nv/x/32/libGLX_nvidia.so.${NV_VER} \
     nv/x/32/libEGL_nvidia.so.${NV_VER} \
     nv/x/32/libGLESv1_CM_nvidia.so.${NV_VER} \
     nv/x/32/libGLESv2_nvidia.so.${NV_VER} \
     nv/x/32/libnvidia-glcore.so.${NV_VER} \
     nv/x/32/libnvidia-glsi.so.${NV_VER} \
     nv/x/32/libnvidia-tls.so.${NV_VER} \
     nv/x/32/libnvidia-eglcore.so.${NV_VER} \
     nv/x/32/libnvidia-glvkspirv.so.${NV_VER} \
     nv/x/32/libnvidia-gpucomp.so.${NV_VER} \
     nv/x/32/libnvidia-allocator.so.${NV_VER} \
     nv/x/32/libnvidia-ml.so.${NV_VER} \
     nv/x/32/libcuda.so.${NV_VER} \
     /usr/lib/i386-linux-gnu/
COPY nv/x/32/libvdpau_nvidia.so.${NV_VER} /usr/lib/i386-linux-gnu/vdpau/
RUN ldconfig && ls -l /usr/lib/i386-linux-gnu/libGLX_nvidia.so.0

# Автозапуск игры — автостарт сессии labwc (/etc/xdg/labwc/autostart): только там есть
# LD_PRELOAD интерпозера ввода Selkies (без него Steam не видит геймпад) и DISPLAY Xwayland;
# он же поднимает сессионную шину D-Bus по фиксированному адресу ${XDG_RUNTIME_DIR}/bus
# (его же ставит cg-session-exec, когда источник — labwc). Конфиг labwc — без рамок, меню и
# горячих клавиш композитора, обычные окна разворачиваются на весь экран. Оба в /etc/xdg/labwc, не в ~/.config (там профиль игрока).
COPY --chmod=0755 cg-launch /usr/local/bin/cg-launch
COPY --chmod=0755 labwc/autostart /etc/xdg/labwc/autostart
COPY --chmod=0644 labwc/rc.xml /etc/xdg/labwc/rc.xml

# Профиль: снятие (cg-profile-pack) и штатное закрытие Steam перед ним (cg-steam-shutdown,
# через cg-session-exec — окружение процесса сессии) — агент зовёт их `docker exec`.
COPY --chmod=0755 cg-profile-pack cg-steam-shutdown cg-session-exec /usr/local/bin/

# Этап запуска игры (экран загрузки, план §4.1/§4.2) — агент зовёт его `docker exec` раз в 2 с.
COPY --chmod=0755 cg-session-stage /usr/local/bin/

# Заглушка NetworkManager: без неё Steam перед каждым входом ждёт сеть 20 с (README.md). Служба
# s6 от ubuntu — как службы базового образа (их каталоги тоже принадлежат ubuntu). Системная шина
# — служба dbus базового образа.
COPY --chmod=0755 cg-nm-stub /usr/local/bin/cg-nm-stub
COPY --chmod=0644 cg-nm-stub.conf /etc/dbus-1/system.d/cg-nm-stub.conf
COPY --chown=1000:1000 --chmod=0755 cg-nm-stub.run /etc/service/cg-nm-stub/run
COPY --chown=1000:1000 --chmod=0755 cg-nm-stub.finish /etc/service/cg-nm-stub/finish

# Каталоги дома заранее, владелец ubuntu: недостающие точки монтирования и родителей записей архива
# профиля Docker создаёт от root, и Steam молча выходит (`bin_steam.sh: ln: Permission denied`).
# install -d даёт владельца только последнему каталогу пути — родители перечислены по одному.
RUN install -d -o 1000 -g 1000 \
      /home/ubuntu/.local \
      /home/ubuntu/.local/share \
      /home/ubuntu/.local/share/Steam \
      /home/ubuntu/.local/share/Steam/steamapps \
      /home/ubuntu/.steam

# PATH с тем же хвостом, что у selkies-egl-desktop:26.04 (в base его нет).
ENV PATH="${PATH}:/usr/local/games:/usr/games"

# Постоянные настройки Selkies (спека §9) — те же имена и значения, что в прежнем образе на KDE
# (переименований в base нет). Слотовые SELKIES_WEBRTC_UDP_MUX_PORT и SELKIES_WEBRTC_PUBLIC_IP
# задаёт агент при создании контейнера.
# SELKIES_WAYLAND_COMPOSITOR=labwc — явно (пусто в base → автоопределение, тоже labwc).
# SELKIES_ENABLE_DUAL_MODE=false — клиент не может переключить медиа на websockets (TCP), только WebRTC/UDP.
# SELKIES_WAYLAND_X11_FALLBACK=false — без nvidia-drm modeset=1 не уходить молча на X11 (решение R11).
# Важно: базовый образ при этом не падает, а остаётся на Wayland с программным композитингом
# (/etc/container-entrypoint.sh: «GPU: the compositor cannot reach it; compositing in software»).
# Признак здоровой сессии — в логе «Zero-copy capture ... encoded in place on NVENC».
ENV TZ=Europe/Moscow \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=all \
    DISPLAY_SIZEW=1920 \
    DISPLAY_SIZEH=1080 \
    SELKIES_MODE=webrtc \
    SELKIES_WAYLAND=true \
    SELKIES_WAYLAND_COMPOSITOR=labwc \
    SELKIES_ENCODER=h264enc \
    SELKIES_RATE_CONTROL_MODE=cbr \
    SELKIES_VIDEO_BITRATE=10000,2000-40000 \
    SELKIES_FRAMERATE=60,30-120 \
    SELKIES_KEYFRAME_INTERVAL=2 \
    SELKIES_WEBRTC_ICE_LITE=true \
    SELKIES_ENABLE_HTTPS=false \
    SELKIES_ENABLE_BASIC_AUTH=false \
    SELKIES_UI_SHOW_SIDEBAR=false \
    SELKIES_ENABLE_DUAL_MODE=false \
    SELKIES_WAYLAND_X11_FALLBACK=false

# Разрешение зафиксировано: без этого Selkies подгоняет экран под окно браузера при каждом
# подключении/ресайзе/полноэкранном режиме, и Unity-игры (Vampire Survivors) падают на смене
# выходов XRandR («X Error ... BadRROutput (RRGetOutputInfo)»), проверено вручную. Браузер
# масштабирует 1920x1080 под окно сам.
ENV SELKIES_MANUAL_WIDTH=1920 \
    SELKIES_MANUAL_HEIGHT=1080

# Усиление (спека §4.1): буфер обмена, передача файлов и печать Selkies в base по умолчанию
# включены — выключаем все три, из сессии в браузер и обратно ничего не уходит.
ENV SELKIES_ENABLE_CLIPBOARD=false \
    SELKIES_FILE_TRANSFERS=none \
    SELKIES_PRINTING_ENABLED=false

USER 1000
