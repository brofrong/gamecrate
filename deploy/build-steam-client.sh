#!/usr/bin/env bash
# Сборка шаблона клиента Steam на стенде brofrong (или другом сервере по ssh) с машины
# разработчика: обёртка над deploy/worker/build-steam-client.sh, которая отдаёт его в
# `ssh <хост> bash -s`. Что и как собирается — в комментарии того файла.
#
#   ./deploy/build-steam-client.sh [ssh-хост=brofrong]
#
# На стенде .env лежит в ~/cloud-gaming/.env (на игровых серверах — /opt/cloud-gaming/.env, там
# скрипт запускают прямо на сервере: `sudo /opt/cloud-gaming/build-steam-client.sh`). Пути,
# которых в серверном .env нет, — пути стенда, как в deploy/compose.stand.yaml (менять вместе).
# sudo не нужен: на brofrong всё делает пользователь brofrong (uid 1000).
set -euo pipefail

REMOTE_HOST="${1:-brofrong}"
SCRIPT="$(dirname "${BASH_SOURCE[0]}")/worker/build-steam-client.sh"

ssh "${REMOTE_HOST}" bash -s -- \
  --env-file cloud-gaming/.env \
  --default STEAM_CLIENT_DIR=/home/brofrong/cloud-gaming-steam/client \
  --default GBM_ALLOCATOR_PATH=/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01 \
  <"${SCRIPT}"
