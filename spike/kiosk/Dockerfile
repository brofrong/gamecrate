# check=skip=SecretsUsedInArgOrEnv
# Проба (план 4, «образ-киоск», задача 2, throwaway) — НЕ прод, не деплоить.
#
# Отвечает на §6.1 спеки (docs/superpowers/specs/2026-10-27-kiosk-image-design.md): работает ли
# Selkies-база БЕЗ рабочего стола (вместо нынешнего selkies-egl-desktop с KDE Plasma) + свой
# labwc как сессионный композитор. Тег сборки: cg-session:550.163.01-kiosk-probe.
#
# Базовый образ закреплён по digest (шаг 1 задачи 2): та же семья и версия Selkies 2.0, что и
# нынешний прод `ghcr.io/selkies-project/selkies-egl-desktop:26.04` (её слои уже на сервере —
# `docker pull` показал только «Already exists»), но без KDE Plasma и без Steam внутри.
# НЕ latest-ubuntu26.04 (решение контролёра): latest плавает, а 2.0.0 — зафиксированная версия,
# совпадающая с прод-образом.
FROM ghcr.io/selkies-project/selkies/base@sha256:191428b47ee11e6670547a5012a2a939c1b4df257a0a5293c226ab337c8a4723
ARG NV_VER=550.163.01
USER root

# Steam и нужные пакеты. Проверено шагом 1 (temp-контейнеры без GPU, --entrypoint): в этой базе
# УЖЕ есть всё остальное из списка брифа — i386 (мультиарх включён, libc6:i386 стоит),
# python3-dbus, системная шина (служба s6 /etc/service/dbus), xdotool, x11-utils (xwininfo),
# curl, procps (ps/pgrep), dbus-x11 (dbus-launch). Не хватает только Steam: multiverse уже в
# /etc/apt/sources.list.d/ubuntu.sources, ставим steam-installer (как в Ubuntu/Debian, а не
# steam-launcher — того кандидата в этом релизе нет, в отличие от набора пакетов
# selkies-egl-desktop:26.04).
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends steam-installer \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Клиент Steam 32-битный, а NVIDIA Container Toolkit прокидывает только 64-битные библиотеки
# (как в images/session/Dockerfile). Версия должна совпадать с драйвером хоста.
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

# Автозапуск игры: в этой базе нет KDE и нет systemd user — /etc/xdg/autostart/*.desktop (как в
# images/session) никто не обрабатывает. Вместо этого — собственный автостарт сессионного
# композитора labwc (/etc/xdg/labwc/autostart), см. комментарий в labwc-autostart. Запускается
# внутри сессии labwc, где есть LD_PRELOAD интерпозера ввода Selkies (иначе Steam не видит
# геймпад) и DISPLAY Xwayland.
COPY --chmod=0755 cg-launch /usr/local/bin/cg-launch
COPY --chmod=0755 labwc-autostart /etc/xdg/labwc/autostart

# Конфиг labwc: без декораций, без меню, без панелей, окна во весь экран (подробности и
# оговорки — комментарий в labwc-rc.xml). /etc/xdg/labwc/, не ~/.config — там профиль игрока.
COPY --chmod=0644 labwc-rc.xml /etc/xdg/labwc/rc.xml

# Заглушка NetworkManager (как в images/session/Dockerfile): без неё Steam перед каждым входом
# ждёт сеть 20 с. Системная шина у этой базы уже есть (служба /etc/service/dbus) — добавлять не
# нужно (проверено шагом 1).
COPY --chmod=0755 cg-nm-stub /usr/local/bin/cg-nm-stub
COPY --chmod=0644 cg-nm-stub.conf /etc/dbus-1/system.d/cg-nm-stub.conf
COPY --chown=1000:1000 --chmod=0755 cg-nm-stub.run /etc/service/cg-nm-stub/run
COPY --chown=1000:1000 --chmod=0755 cg-nm-stub.finish /etc/service/cg-nm-stub/finish

# Каталоги дома заранее, владелец ubuntu (как в images/session/Dockerfile — иначе Docker создаёт
# недостающие точки монтирования от root, и Steam молча выходит).
RUN install -d -o 1000 -g 1000 \
      /home/ubuntu/.local \
      /home/ubuntu/.local/share \
      /home/ubuntu/.local/share/Steam \
      /home/ubuntu/.local/share/Steam/steamapps \
      /home/ubuntu/.steam

# Найдено шагом 1/2 (сравнение docker inspect этой базы с selkies-egl-desktop:26.04): настоящий
# бинарник steam-installer — /usr/games/steam (ставит клиент при первом запуске), а не /usr/bin,
# и PATH этой базы (в отличие от selkies-egl-desktop:26.04) каталог /usr/games не включает —
# `exec steam ...` в cg-launch не нашёл бы его. Дописываем PATH тем же хвостом, что у
# selkies-egl-desktop:26.04.
ENV PATH="${PATH}:/usr/local/games:/usr/games"

# Постоянные настройки Selkies — те же имена и значения, что в images/session/Dockerfile (шаг 1:
# сравнение `docker inspect` этой базы с selkies-egl-desktop:26.04 не показало переименований
# среди переменных, которые использует нынешний образ; это один и тот же Selkies 2.0).
# SELKIES_WAYLAND_COMPOSITOR=labwc — явно, а не автоопределение (по умолчанию в базе и так пусто
# → labwc, т.к. он единственный установленный композитор и других переменных автоопределения
# нет, но явное значение документирует намерение).
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

# Разрешение зафиксировано (как в images/session/Dockerfile) — см. тот файл за объяснением.
ENV SELKIES_MANUAL_WIDTH=1920 \
    SELKIES_MANUAL_HEIGHT=1080

# Усиление из спеки §4.1: передача файлов и буфер обмена Selkies — выключить, если версия их
# умеет. Умеет (найдено шагом 1, `selkies --help` + settings.py этой базы) и по умолчанию ВКЛЮЧЕНО
# (enable_clipboard default "true", file_transfers default "upload,download",
# printing_enabled default True) — явно выключаем все три.
ENV SELKIES_ENABLE_CLIPBOARD=false \
    SELKIES_FILE_TRANSFERS=none \
    SELKIES_PRINTING_ENABLED=false

USER 1000
