# Сборщик Ship of Harkinian — тот же образ сессии (те же системные библиотеки, что увидит игра в
# /opt/cg-game) плюс компилятор и зависимости сборки SoH. Используется только для сборки пакета
# (deploy/add-game.sh), в сессии не запускается.
#   docker build --build-arg SESSION_IMAGE=cg-session:550.163.01 -f builder.Dockerfile -t cg-game-builder-soh:<версия> .
# apt.txt — копия linux-build-deps/apt.txt тега SoH, который собирает build.sh.
ARG SESSION_IMAGE
FROM ${SESSION_IMAGE}
USER root

# steam-launcher в образе сессии стоит с разорванными зависимостями (xterm удалён с
# --force-depends), и apt-get install отказывается работать, пока он есть. Источник Steam тоже
# убираем: сборщику он не нужен, а его ключ/репозиторий — лишняя точка отказа apt-get update.
COPY apt.txt /tmp/soh-apt.txt
RUN dpkg -r --force-depends steam-launcher \
    && rm -f /etc/apt/sources.list.d/steam*.list /etc/apt/sources.list.d/steam*.sources \
    && apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
         gcc g++ cmake ninja-build git ca-certificates python3 pkg-config \
         $(cat /tmp/soh-apt.txt) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/soh-apt.txt

# Entrypoint образа сессии поднимает Selkies и labwc — сборщику это не нужно: команда
# `docker run <сборщик> /game/build.sh …` выполняется как есть.
ENTRYPOINT []
CMD ["bash"]
USER 1000
