#!/usr/bin/env bash
# Деплой стенда brofrong (game.brofrong.ru) по тегу релиза: главный и игровой сервер на одной
# машине (compose.main.yaml + compose.worker.yaml + оверлей compose.stand.yaml). Образы берутся
# из реестра (их собирает CI на тег vX.Y.Z), на сервере ничего не собирается.
#
#   ./deploy/deploy-stand.sh <тег>           — деплой релиза, например v0.1.0
#   ./deploy/deploy-stand.sh enroll <код>    — обменять код подключения сервера brofrong (админка →
#                                               «Серверы» → brofrong → «Перевыпустить код») на
#                                               токен сервера: WORKER_TOKEN в .env, перезапуск
#                                               cg-agent
#
# Деплой:
# 1. Отказ, если на brofrong есть созданный или запущенный контейнер с меткой cg.session,
#    cg.install или cg.template (сборка клиента Steam): пересоздание cg-agent и смена образа под
#    ними рвут сессии и установки. Остановленные (exited, например profile-unsaved) не мешают.
# 2. Есть ли ~/cloud-gaming/.env (его деплой не создаёт; см. deploy/README.md, «Стенд brofrong»).
# 3. Драйвер NVIDIA на brofrong должен быть в images/session/drivers.txt.
# 4. Пути стенда (CG_DATA_DIR, SCRATCH_DIR, STEAM_CLIENT_DIR, STEAM_CLIENT_PARENT) — в .env, если их
#    там нет; каталоги хоста (владелец uid 1000, без sudo); сеть cg-sessions с фиксированной
#    подсетью и ip-range (есть с другой — отказ с инструкцией).
# 5. Копирует три compose-файла в ~/cloud-gaming/, проверяет конфиг (`docker compose config -q`:
#    нет обязательной переменной — ошибка до скачивания образов) и скачивает образы (образ
#    сессии и `docker compose pull`) с новыми CG_VERSION/SESSION_IMAGE из окружения; только
#    потом пишет в .env CG_VERSION=<тег> и SESSION_IMAGE=<реестр>/cg-session:<драйвер>-<тег>
#    (строки заменяются, остальное в .env не читается и не меняется); бакет профилей
#    (`run --rm cg-rustfs-bucket`), `up -d`.
# Реестр приватный: на brofrong один раз `docker login registry.imtechnologies.ru` токеном на
# чтение (см. README).
# Команды ssh собираются на этой машине нарочно (тег, пути, COMPOSE) — SC2029 не про ошибку.
# shellcheck disable=SC2029
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="brofrong"
REMOTE_DIR="cloud-gaming"
CG_REGISTRY="${CG_REGISTRY:-registry.imtechnologies.ru/gamecrate/imt-cloud-gaming}"
COMPOSE_FILES="-f compose.main.yaml -f compose.worker.yaml -f compose.stand.yaml"
# DOCKER_GID — группа сокета Docker на хосте: с ней cg-agent (не root) работает с Docker API.
# Ставится в окружении docker compose (не в .env), как раньше в deploy.sh.
COMPOSE="cd ~/${REMOTE_DIR} && DOCKER_GID=\$(stat -c %g /var/run/docker.sock) docker compose ${COMPOSE_FILES} --env-file .env"

usage() {
  echo "Использование: deploy/deploy-stand.sh <тег vX.Y.Z> | enroll <код>" >&2
  exit 2
}

# --- enroll ------------------------------------------------------------------------------------
# Обмен идёт внутри cg-orchestrator (bun fetch на его же порт): маршрут /agent на стенде наружу
# может быть не открыт. Токен из ответа сразу уходит в .env на сервере, на экран и в аргументы
# процессов не попадает; WORKER_ID ответа должен совпасть с WORKER_ID стенда.
if [ "${1:-}" = enroll ]; then
  code="${2:-}"
  [[ "${code}" =~ ^[A-Za-z0-9_-]+$ ]] || usage
  ssh "${REMOTE_HOST}" bash -s -- "${REMOTE_DIR}" "${code}" <<'REMOTE'
set -euo pipefail
cd ~/"$1"
code="$2"
envval() { local v; v="$(sed -n "s/^$1=//p" .env | tail -n 1)"; printf '%s' "${v:-$2}"; }
answer="$(printf '{"code":"%s"}' "${code}" | docker exec -i cg-orchestrator bun -e '
const r = await fetch("http://localhost:" + (process.env.ORCHESTRATOR_PORT || 3001) + "/agent/enroll", {
  method: "POST", headers: { "content-type": "application/json" }, body: await Bun.stdin.text(),
});
if (!r.ok) { console.error("ОШИБКА: код не принят (HTTP " + r.status + ") — перевыпустите его в админке"); process.exit(1); }
const j = await r.json();
process.stdout.write(j.workerId + " " + j.token);
')"
worker_id="${answer%% *}"
token="${answer#* }"
expected="$(envval WORKER_ID brofrong)"
if [ "${worker_id}" != "${expected}" ]; then
  echo "ОШИБКА: код выдан для сервера ${worker_id}, а стенд — ${expected} (WORKER_ID)." >&2
  echo "Токен не записан; сервер ${worker_id} теперь считается подключённым — отзовите его в админке." >&2
  exit 1
fi
tmp="$(mktemp .env.XXXXXX)"
chmod 600 "${tmp}"
grep -v '^WORKER_TOKEN=' .env >"${tmp}" || true
printf 'WORKER_TOKEN=%s\n' "${token}" >>"${tmp}"
mv -f "${tmp}" .env
echo "==> WORKER_TOKEN сервера ${worker_id} записан в ~/$1/.env"
REMOTE
  echo "==> перезапуск cg-agent"
  ssh "${REMOTE_HOST}" "${COMPOSE} up -d cg-agent"
  echo "==> готово: «Agent connected» — ssh ${REMOTE_HOST} 'docker logs cg-orchestrator 2>&1 | grep \"Agent connected\" | tail -1'"
  exit 0
fi

# --- деплой ------------------------------------------------------------------------------------
TAG="${1:-}"
[[ "${TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || usage

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

echo "==> проверка .env на сервере"
ssh "${REMOTE_HOST}" "test -f ~/${REMOTE_DIR}/.env" || {
  echo "ОШИБКА: ~/${REMOTE_DIR}/.env не найден на ${REMOTE_HOST} (см. deploy/README.md, «Стенд brofrong»)." >&2
  exit 1
}

echo "==> драйвер NVIDIA и образ сессии"
driver="$(ssh "${REMOTE_HOST}" 'nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n 1' | tr -d '[:space:]')"
if ! grep -Fqx -- "${driver}" "${REPO_ROOT}/images/session/drivers.txt"; then
  echo "ОШИБКА: драйвера ${driver:-?} на ${REMOTE_HOST} нет в images/session/drivers.txt — образа сессии в релизе нет." >&2
  exit 1
fi
session_image="${CG_REGISTRY}/cg-session:${driver}-${TAG}"
echo "    ${session_image}"

# Заменить (или дописать) строку <ключ>=<значение> в серверном .env; значения не секретные.
# set_env_default — только если ключа в .env ещё нет.
set_env() {
  ssh "${REMOTE_HOST}" bash -s -- "${REMOTE_DIR}" "$1" "$2" "${3:-replace}" <<'REMOTE'
set -euo pipefail
f=~/"$1"/.env
if [ "$4" = default ] && grep -q "^$2=" "${f}"; then exit 0; fi
tmp="$(mktemp "${f}.XXXXXX")"
chmod --reference="${f}" "${tmp}"
grep -v "^$2=" "${f}" >"${tmp}" || true
printf '%s=%s\n' "$2" "$3" >>"${tmp}"
mv -f "${tmp}" "${f}"
REMOTE
}
set_env_default() { set_env "$1" "$2" default; }

echo "==> пути стенда в .env (если их там нет)"
# Их читают bind-ы и переменные compose.worker.yaml (там по умолчанию пути /srv игрового сервера).
set_env_default CG_DATA_DIR /raid/cloud-gaming
set_env_default SCRATCH_DIR /home/brofrong/cloud-gaming-scratch
set_env_default STEAM_CLIENT_DIR /home/brofrong/cloud-gaming-steam/client
set_env_default STEAM_CLIENT_PARENT /home/brofrong/cloud-gaming-steam

echo "==> каталоги, сеть cg-sessions"
# Владелец — brofrong (uid 1000), без sudo. Сеть cg-sessions — с фиксированной подсетью и
# ip-range (CG_SESSIONS_SUBNET/CG_SESSIONS_IP_RANGE, по умолчанию как в install.sh): адрес cg-agent
# CG_AGENT_IP (172.31.240.2) закреплён в compose.worker.yaml вне ip-range. Есть с другой
# подсетью — отказ: пересоздать её можно только без сессий.
ssh "${REMOTE_HOST}" bash -s -- "${REMOTE_DIR}" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"
envval() { local v; v="$(sed -n "s/^$1=//p" ~/"${REMOTE_DIR}"/.env | tail -n 1)"; printf '%s' "${v:-$2}"; }
data="$(envval CG_DATA_DIR /raid/cloud-gaming)"
scratch="$(envval SCRATCH_DIR /home/brofrong/cloud-gaming-scratch)"
client="$(envval STEAM_CLIENT_DIR /home/brofrong/cloud-gaming-steam/client)"
client_parent="$(envval STEAM_CLIENT_PARENT /home/brofrong/cloud-gaming-steam)"
subnet="$(envval CG_SESSIONS_SUBNET 172.31.240.0/24)"
ip_range="$(envval CG_SESSIONS_IP_RANGE 172.31.240.128/25)"
dirs=("${data}" "${data}/library" "${data}/library/steamapps" "${data}/install-scratch"
  "${data}/games" "${scratch}" "${client_parent}")
mkdir -p "${dirs[@]}"
for d in "${dirs[@]}"; do
  if [ "$(stat -c %u "${d}")" != 1000 ]; then
    echo "ОШИБКА: владелец ${d} — не uid 1000 ($(stat -c %U "${d}")); исправить вручную." >&2
    exit 1
  fi
done
if [ ! -x "${client}/ubuntu12_32/steam" ]; then
  echo "    ВНИМАНИЕ: клиент Steam в ${client} не собран — ./deploy/build-steam-client.sh" >&2
  echo "    (пока шаблона нет, сервер сессий не берёт)." >&2
fi
if docker network inspect cg-sessions >/dev/null 2>&1; then
  current="$(docker network inspect cg-sessions -f '{{range .IPAM.Config}}{{.Subnet}} {{.IPRange}};{{end}}')"
  if [ "${current}" != "${subnet} ${ip_range};" ]; then
    echo "ОШИБКА: сеть cg-sessions есть, но с подсетью «${current}», а нужна ${subnet} с ip-range ${ip_range}." >&2
    echo "Пересоздать, пока нет сессий и установок (см. README, «Стенд brofrong»):" >&2
    echo "  cd ~/${REMOTE_DIR} && docker stop cg-agent && docker network rm cg-sessions" >&2
    echo "и повторить деплой. Подсеть занята — свои CG_SESSIONS_SUBNET, CG_SESSIONS_IP_RANGE, CG_AGENT_IP в .env." >&2
    exit 1
  fi
else
  docker network create --subnet "${subnet}" --ip-range "${ip_range}" cg-sessions >/dev/null || {
    echo "ОШИБКА: не удалось создать cg-sessions ${subnet} — подсеть занята? Свои CG_SESSIONS_SUBNET," >&2
    echo "CG_SESSIONS_IP_RANGE и CG_AGENT_IP (внутри подсети, вне ip-range) в ~/${REMOTE_DIR}/.env." >&2
    exit 1
  }
fi
REMOTE

echo "==> compose-файлы -> ${REMOTE_HOST}:~/${REMOTE_DIR}/"
scp -q "${REPO_ROOT}/deploy/compose.main.yaml" "${REPO_ROOT}/deploy/compose.worker.yaml" \
  "${REPO_ROOT}/deploy/compose.stand.yaml" "${REMOTE_HOST}:${REMOTE_DIR}/"

# Проверка и скачивание — с новыми CG_VERSION/SESSION_IMAGE из окружения compose (оно главнее
# --env-file): в .env они попадают, только когда конфиг верен и образы скачались.
NEXT="cd ~/${REMOTE_DIR} && CG_VERSION=${TAG} SESSION_IMAGE=${session_image} DOCKER_GID=\$(stat -c %g /var/run/docker.sock) docker compose ${COMPOSE_FILES} --env-file .env"

echo "==> проверка конфигурации compose"
ssh "${REMOTE_HOST}" "${NEXT} config -q"

echo "==> образы ${TAG}"
ssh "${REMOTE_HOST}" "docker pull -q ${session_image} >/dev/null && ${NEXT} pull -q"

echo "==> CG_VERSION и SESSION_IMAGE в .env"
set_env CG_VERSION "${TAG}"
set_env SESSION_IMAGE "${session_image}"

echo "==> бакет профилей (cg-rustfs, идемпотентно)"
ssh "${REMOTE_HOST}" "${COMPOSE} run --rm cg-rustfs-bucket"

echo "==> docker compose up -d"
ssh "${REMOTE_HOST}" "${COMPOSE} up -d"

if ! ssh "${REMOTE_HOST}" "grep -q '^WORKER_TOKEN=.' ~/${REMOTE_DIR}/.env"; then
  echo "ВНИМАНИЕ: в ~/${REMOTE_DIR}/.env нет WORKER_TOKEN — cg-agent не подключится. Админка →" >&2
  echo "«Серверы» → brofrong → «Перевыпустить код», затем ./deploy/deploy-stand.sh enroll <код>." >&2
fi
echo "==> готово: ${TAG}"
