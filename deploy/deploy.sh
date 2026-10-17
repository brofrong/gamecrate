#!/usr/bin/env bash
# Деплой на brofrong (game.brofrong.ru): rsync репозитория + docker compose up --build.
# Сервисы: cg-api, cg-postgres, cg-orchestrator, cg-agent (см. compose.yaml).
#
# .env на сервере (~/cloud-gaming/.env) создаётся и копируется отдельно, один раз,
# вручную (см. README.md). Этот скрипт его никогда не перезаписывает и не читает значения;
# единственное изменение — дописать строку AGENT_TOKEN из локального .env.production,
# если такого ключа на сервере ещё нет.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="brofrong"
REMOTE_DIR="cloud-gaming"
LOCAL_ENV="${REPO_ROOT}/.env.production"

echo "==> rsync ${REPO_ROOT} -> ${REMOTE_HOST}:~/${REMOTE_DIR}"
rsync -az --delete \
  --exclude ".git/" \
  --exclude "node_modules/" \
  --exclude "spike/nv/" \
  --exclude "images/session/nv/" \
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

# AGENT_TOKEN: общий секрет оркестратора и агента. Значение идёт через stdin ssh — не попадает
# ни в аргументы процессов, ни в вывод.
if ssh "${REMOTE_HOST}" "grep -q '^AGENT_TOKEN=' ~/${REMOTE_DIR}/.env"; then
  echo "==> AGENT_TOKEN на сервере уже есть"
else
  if ! grep -q '^AGENT_TOKEN=.\{32,\}$' "${LOCAL_ENV}" 2>/dev/null; then
    echo "ОШИБКА: в ~/${REMOTE_DIR}/.env на сервере нет AGENT_TOKEN, а в ${LOCAL_ENV} нет значения" >&2
    echo "не короче 32 символов. Сгенерировать (см. README.md):" >&2
    echo "  grep -q '^AGENT_TOKEN=' .env.production || printf 'AGENT_TOKEN=%s\\n' \"\$(openssl rand -hex 32)\" >> .env.production" >&2
    exit 1
  fi
  echo "==> дописываем AGENT_TOKEN в ~/${REMOTE_DIR}/.env на сервере"
  grep '^AGENT_TOKEN=' "${LOCAL_ENV}" | head -n 1 | ssh "${REMOTE_HOST}" \
    "f=~/${REMOTE_DIR}/.env; [ -z \"\$(tail -c1 \"\$f\")\" ] || echo >> \"\$f\"; cat >> \"\$f\""
fi

echo "==> сеть cg-sessions"
ssh "${REMOTE_HOST}" "docker network inspect cg-sessions >/dev/null 2>&1 || docker network create cg-sessions"

echo "==> docker compose up -d --build"
# DOCKER_GID — группа сокета Docker на хосте: с ней cg-agent (не root) работает с Docker API.
ssh "${REMOTE_HOST}" "cd ~/${REMOTE_DIR} && DOCKER_GID=\$(stat -c %g /var/run/docker.sock) docker compose -f deploy/compose.yaml --env-file .env up -d --build"

echo "==> готово"
