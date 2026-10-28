#!/usr/bin/env bash
# Деплой на brofrong (game.brofrong.ru): rsync репозитория + docker compose up --build.
# Сервисы: cg-api, cg-postgres, cg-orchestrator, cg-agent, cg-rustfs (см. compose.yaml).
#
# .env на сервере (~/cloud-gaming/.env) создаётся и копируется отдельно, один раз,
# вручную (см. README.md). Этот скрипт его никогда не перезаписывает и не выводит значения;
# единственное изменение — дописать строки AGENT_TOKEN, RUSTFS_ACCESS_KEY, RUSTFS_SECRET_KEY,
# PROFILE_KEY из локального .env.production, если таких ключей на сервере ещё нет.
# Из серверного .env читаются только несекретные пути CG_DATA_DIR, SCRATCH_DIR,
# STEAM_CLIENT_DIR и STEAM_CLIENT_PARENT.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="brofrong"
REMOTE_DIR="cloud-gaming"
LOCAL_ENV="${REPO_ROOT}/.env.production"

# Живые сессии и установки: пересоздание cg-agent и смена слоёв под ними — не деплоим. Считаются
# и только что созданные (created: агент создал, ещё не запустил). Остановленные (exited,
# например profile-unsaved) не мешают.
echo "==> проверка: нет запущенных сессий, установок и сборки клиента Steam"
busy="$(ssh "${REMOTE_HOST}" 'for l in cg.session cg.install cg.template; do
  docker ps -a --filter "label=$l" --filter status=created --filter status=running \
    --filter status=restarting --filter status=paused --format "{{.Names}} ({{.State}}, $l)"
done')"
if [ -n "${busy}" ]; then
  echo "ОШИБКА: на ${REMOTE_HOST} запущены контейнеры:" >&2
  printf '%s\n' "${busy}" | sed 's/^/  /' >&2
  echo "Дождитесь окончания сессий/установок (или остановите их штатно) и повторите деплой." >&2
  exit 1
fi

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

# Секрет из локального .env.production — в серверный .env, если ключа там нет. Берётся первая
# строка `<ключ>=` локального файла: она же проверяется и она же отправляется. Значение идёт через
# stdin ssh: не попадает ни в аргументы процессов, ни в вывод. На сервере смотрится только наличие
# ключа и непустого значения (grep -q), сами значения не читаются; пустая строка `<ключ>=` —
# ошибка (удалить её вручную), а не повод дописать вторую.
#   append_secret <ключ> <проверка значения: функция> <описание> <команда генерации>
append_secret() {
  local key="$1" check="$2" what="$3" gen="$4" state line
  state="$(ssh "${REMOTE_HOST}" "f=~/${REMOTE_DIR}/.env; if grep -q '^${key}=.' \"\$f\"; then echo present; elif grep -q '^${key}=' \"\$f\"; then echo empty; else echo missing; fi")"
  case "${state}" in
    present)
      echo "==> ${key} на сервере уже есть"
      return
      ;;
    empty)
      echo "ОШИБКА: в ~/${REMOTE_DIR}/.env на сервере строка ${key}= с пустым значением —" >&2
      echo "удалите её вручную (sed -i '/^${key}=\$/d' ~/${REMOTE_DIR}/.env) и повторите деплой." >&2
      exit 1
      ;;
    missing) ;;
    *)
      echo "ОШИБКА: не удалось проверить ${key} в ~/${REMOTE_DIR}/.env на сервере" >&2
      exit 1
      ;;
  esac
  line="$(grep -m 1 "^${key}=" "${LOCAL_ENV}" 2>/dev/null || true)"
  if ! "${check}" "${line#*=}"; then
    echo "ОШИБКА: в ~/${REMOTE_DIR}/.env на сервере нет ${key}, а в ${LOCAL_ENV} нет значения" >&2
    echo "(${what}). Сгенерировать (см. README.md), не выводя на экран:" >&2
    echo "  grep -q '^${key}=' .env.production || printf '${key}=%s\\n' \"\$(${gen})\" >> .env.production" >&2
    exit 1
  fi
  echo "==> дописываем ${key} в ~/${REMOTE_DIR}/.env на сервере"
  printf '%s\n' "${line}" | ssh "${REMOTE_HOST}" \
    "f=~/${REMOTE_DIR}/.env; [ -z \"\$(tail -c1 \"\$f\")\" ] || echo >> \"\$f\"; cat >> \"\$f\""
}

# Проверки значения (аргумент — значение из .env.production; не выводится).
min32() { [ "${#1}" -ge 32 ]; }
min16() { [ "${#1}" -ge 16 ]; }
# base64 ровно 32 байт (AES-256): 44 символа base64, после декодирования 32 байта.
base64_32() {
  [[ "$1" =~ ^[A-Za-z0-9+/]{43}=$ ]] &&
    [ "$(printf '%s' "$1" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" = 32 ]
}

append_secret AGENT_TOKEN min32 "не короче 32 символов" "openssl rand -hex 32"
append_secret RUSTFS_ACCESS_KEY min16 "не короче 16 символов" "openssl rand -hex 24"
append_secret RUSTFS_SECRET_KEY min16 "не короче 16 символов" "openssl rand -hex 24"
append_secret PROFILE_KEY base64_32 "base64 ровно 32 байт" "openssl rand -base64 32"

echo "==> каталоги библиотеки, клиента Steam и scratch"
# Владелец — brofrong (uid 1000), без sudo. Пустой <STEAM_CLIENT_DIR>/steamapps нужен до первой
# сессии: overlay библиотеки монтируется внутрь overlay клиента, без каталога Docker создал бы его от
# root. Значения по умолчанию — как в compose.yaml (CG_DATA_DIR, SCRATCH_DIR, STEAM_CLIENT_DIR,
# STEAM_CLIENT_PARENT); в .env — без кавычек. STEAM_CLIENT_PARENT создаётся отдельно от
# STEAM_CLIENT_DIR (а не через dirname) — так же, как его читает compose.yaml для своего bind.
ssh "${REMOTE_HOST}" bash -s -- "${REMOTE_DIR}" <<'REMOTE'
set -euo pipefail
envval() { local v; v="$(sed -n "s/^$1=//p" ~/"${REMOTE_DIR}"/.env | tail -n 1)"; printf '%s' "${v:-$2}"; }
REMOTE_DIR="$1"
data="$(envval CG_DATA_DIR /raid/cloud-gaming)"
scratch="$(envval SCRATCH_DIR /home/brofrong/cloud-gaming-scratch)"
client="$(envval STEAM_CLIENT_DIR /home/brofrong/cloud-gaming-steam/client)"
client_parent="$(envval STEAM_CLIENT_PARENT /home/brofrong/cloud-gaming-steam)"
dirs=("${data}" "${data}/library" "${data}/library/steamapps" "${data}/install-scratch" "${scratch}"
  "${client_parent}" "${client}" "${client}/steamapps")
mkdir -p "${dirs[@]}"
for d in "${dirs[@]}"; do
  if [ "$(stat -c %u "${d}")" != 1000 ]; then
    echo "ОШИБКА: владелец ${d} — не uid 1000 ($(stat -c %U "${d}")); исправить вручную." >&2
    exit 1
  fi
  echo "    ${d}"
done
if [ ! -x "${client}/ubuntu12_32/steam" ]; then
  echo "    ВНИМАНИЕ: клиент Steam в ${client} не собран — ./deploy/build-steam-client.sh" >&2
  echo "    (без него каждая сессия скачивает клиент заново, ~2,5 ГБ)." >&2
fi
REMOTE

echo "==> сеть cg-sessions"
ssh "${REMOTE_HOST}" "docker network inspect cg-sessions >/dev/null 2>&1 || docker network create cg-sessions"

# Коммит для блока «Версии» админки (CG_COMMIT агента) — берётся локально: rsync выше не
# копирует .git на сервер, там rev-parse не сработает. -dirty, если есть незакоммиченные
# изменения (в т.ч. неотслеживаемые — porcelain их тоже показывает). Вычисляется до COMPOSE,
# чтобы попасть в неё сразу — оба места ниже (run и up) берут один и тот же COMPOSE.
commit="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
if [ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]; then
  commit="${commit}-dirty"
fi

# DOCKER_GID — группа сокета Docker на хосте: с ней cg-agent (не root) работает с Docker API.
# CG_COMMIT — коммит этого деплоя (локальный git, не серверный .env). Обе — рядом, в окружении
# именно docker compose (а не cd): так переменные уходят процессу compose и подставляются в
# cg-agent compose.yaml (${CG_COMMIT:-unknown} там, если вдруг не задано).
COMPOSE="cd ~/${REMOTE_DIR} && DOCKER_GID=\$(stat -c %g /var/run/docker.sock) CG_COMMIT=${commit} docker compose -f deploy/compose.yaml --env-file .env"

echo "==> бакет профилей (cg-rustfs, идемпотентно)"
# Поднимает cg-rustfs (ждёт healthy) и одноразовым AWS CLI в сети cg создаёт бакет, если его нет.
ssh "${REMOTE_HOST}" "${COMPOSE} run --rm cg-rustfs-bucket"

echo "==> docker compose up -d --build"
ssh "${REMOTE_HOST}" "${COMPOSE} up -d --build"

echo "==> готово"
