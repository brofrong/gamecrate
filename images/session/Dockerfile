# check=skip=SecretsUsedInArgOrEnv
# (SELKIES_ENABLE_BASIC_AUTH=false — не секрет, а выключатель)
# Образ сессии: Selkies (WebRTC + NVENC, Wayland zero-copy) + Steam, игра стартует сама (cg-launch).
# Собирается на воркере под версию драйвера хоста: deploy/build-session-image.sh → cg-session:<NV_VER>.
# Контекст сборки: этот каталог + nv/x — распакованный NVIDIA-Linux-x86_64-<NV_VER>.run (--extract-only).
#
# Контракт окружения контейнера (задаёт агент):
#   CG_APP_ID                     appid игры для автозапуска (пусто — только рабочий стол)
#   SELKIES_WEBRTC_UDP_MUX_PORT   UDP-порт слота (публикуется наружу 1:1)
#   SELKIES_WEBRTC_PUBLIC_IP      публичный IP воркера
# Дом пользователя — слой контейнера; ~/.local/share/Steam (клиент Steam) и
# ~/.local/share/Steam/steamapps (библиотека) — overlay-тома сессии; профиль (вход Steam, сохранения)
# агент кладёт в созданный контейнер до старта и снимает cg-profile-pack при остановке.
# На Debian в контейнер пробрасывается GBM-бэкенд NVIDIA (libnvidia-allocator), см. README.md.
FROM ghcr.io/selkies-project/selkies-egl-desktop:26.04
ARG NV_VER=550.163.01
USER root

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

# Автозапуск игры внутри графической сессии KDE: только там есть LD_PRELOAD интерпозера ввода
# Selkies, без него Steam не видит геймпад.
COPY --chmod=0755 cg-launch /usr/local/bin/cg-launch
COPY --chmod=0644 cg-launch.desktop /etc/xdg/autostart/cg-launch.desktop

# Профиль: снятие (cg-profile-pack) и штатное закрытие Steam перед ним (cg-steam-shutdown) —
# агент зовёт их `docker exec`.
COPY --chmod=0755 cg-profile-pack cg-steam-shutdown /usr/local/bin/

# Каталоги дома заранее, владелец ubuntu: недостающие точки монтирования и родителей записей архива
# профиля Docker создаёт от root, и Steam молча выходит (`bin_steam.sh: ln: Permission denied`).
# install -d даёт владельца только последнему каталогу пути — родители перечислены по одному.
RUN install -d -o 1000 -g 1000 \
      /home/ubuntu/.local \
      /home/ubuntu/.local/share \
      /home/ubuntu/.local/share/Steam \
      /home/ubuntu/.local/share/Steam/steamapps \
      /home/ubuntu/.steam

# Постоянные настройки Selkies (спека §9). Слотовые SELKIES_WEBRTC_UDP_MUX_PORT и
# SELKIES_WEBRTC_PUBLIC_IP задаёт агент при создании контейнера.
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

# Разрешение рабочего стола зафиксировано: без этого Selkies подгоняет экран под окно браузера при
# каждом подключении/ресайзе/полноэкранном режиме, и Unity-игры (Vampire Survivors) падают на смене
# выходов XRandR («X Error ... BadRROutput (RRGetOutputInfo)»), проверено вручную. Браузер
# масштабирует 1920x1080 под окно сам.
ENV SELKIES_MANUAL_WIDTH=1920 \
    SELKIES_MANUAL_HEIGHT=1080

USER 1000
