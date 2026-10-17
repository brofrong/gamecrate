#!/usr/bin/env bash
# Деплой на brofrong (game.brofrong.ru): rsync репозитория + docker compose up --build.
#
# .env на сервере (~/cloud-gaming/.env) создаётся и копируется отдельно, один раз,
# вручную (см. README.md). Этот скрипт его не трогает и никогда не перезаписывает.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="brofrong"
REMOTE_DIR="cloud-gaming"

echo "==> rsync ${REPO_ROOT} -> ${REMOTE_HOST}:~/${REMOTE_DIR}"
rsync -az --delete \
  --exclude ".git/" \
  --exclude "node_modules/" \
  --exclude "spike/nv/" \
  --exclude ".superpowers/" \
  --exclude "docs/" \
  --exclude ".turbo/" \
  --exclude "dist/" \
  --exclude ".DS_Store" \
  --include ".env.example" \
  --exclude ".env" \
  --exclude ".env.*" \
  "${REPO_ROOT}/" "${REMOTE_HOST}:${REMOTE_DIR}/"

echo "==> проверка .env на сервере"
ssh "${REMOTE_HOST}" "test -f ~/${REMOTE_DIR}/.env" || {
  echo "ОШИБКА: ~/${REMOTE_DIR}/.env не найден на ${REMOTE_HOST}." >&2
  echo "Скопируйте его один раз вручную: scp -p .env.production ${REMOTE_HOST}:~/${REMOTE_DIR}/.env (см. README.md)." >&2
  exit 1
}

echo "==> docker compose up -d --build"
ssh "${REMOTE_HOST}" "cd ~/${REMOTE_DIR} && docker compose -f deploy/compose.yaml --env-file .env up -d --build"

echo "==> готово"
