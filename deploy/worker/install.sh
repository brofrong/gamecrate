#!/usr/bin/env bash
# Установка игрового сервера одной командой (спека 2026-11-09 §3 «Добавление сервера»). Команду
# с одноразовым кодом показывает админка («Серверы» → «Добавить сервер»):
#
#   curl -fsSL https://<домен>/agent/install.sh | sudo bash -s -- <код> [--public-ip <ip>] \
#     [--data-dir <путь>] [--sessions-subnet <a.b.c.0/24>] [--dry-run]
#
# Скрипт отдаёт оркестратор главного (`GET /agent/install.sh`), подставляя вместо заглушек ниже
# свой публичный адрес (ORCHESTRATOR_PUBLIC_URL), версию релиза (CG_VERSION) и версии драйвера
# NVIDIA, для которых в релизе есть образ сессии (CG_DRIVERS, images/session/drivers.txt).
# Копия из репозитория с заглушками не запускается — скачивать с главного.
#
# Шаги (при любой ошибке — выход с кодом 1 и сообщением, что не так):
# 1. Проверки, ничего не меняя и не тратя код: root, `docker` и `docker compose`, `nvidia-smi`,
#    NVIDIA runtime в `docker info` (NVIDIA Container Toolkit), `nvidia-drm modeset=1`, драйвер
#    из списка релиза, `libnvidia-allocator.so.<драйвер>` (Debian — …/nvidia/current/, Ubuntu —
#    /usr/lib/x86_64-linux-gnu/), группа сокета Docker (DOCKER_GID), публичный IP
#    (`curl https://api.ipify.org` или `--public-ip`), сеть cg-sessions (если уже есть — с той же
#    подсетью и ip-range, иначе отказ с инструкцией). SLOTS = число GPU.
# 2. `POST /agent/enroll` — код меняется на постоянный токен сервера; `docker login` реестра
#    выданными учётными данными (только чтение; пароль — через stdin); наличие образов релиза в
#    реестре (`docker manifest inspect`); `docker pull` образа сессии (агент создаёт контейнеры
#    сессий из локального образа).
# 3. Каталоги (владелец uid 1000): CG_DATA_DIR (по умолчанию /srv/cloud-gaming: library,
#    install-scratch, games — одна ФС, перенос игр `rename`), SCRATCH_DIR
#    /srv/cloud-gaming-scratch, STEAM_CLIENT_PARENT /srv/cloud-gaming-steam; сеть cg-sessions с
#    фиксированной подсетью (по умолчанию 172.31.240.0/24, `--sessions-subnet`): контейнерам
#    сессий Docker раздаёт адреса из ip-range .128/25, cg-agent закреплён на .2 вне его;
#    /opt/cloud-gaming/.env (права 600, root) и compose.yaml, session-isolation.sh,
#    build-steam-client.sh — с главного.
# 4. `session-isolation.sh apply-local --agent-ip <адрес агента>` — до старта агента, вместе с
#    сохранением правил на перезагрузку (не вышло — уже запущенный агент прежней установки
#    останавливается, выход 1); затем `docker compose pull && up -d` (только cg-agent).
# 5. Шаблон клиента Steam (`build-steam-client.sh`), если его ещё нет: ~2,5 ГБ, 10–30 минут.
#    Пока шаблона нет, сервер сессий не берёт; ошибка сборки установку не отменяет.
# 6. До ~60 с ждёт в логе cg-agent «Connected to orchestrator» (первый принятый оркестратором
#    отчёт). Есть — «Сервер <id> подключён. Откройте UDP <порты> в файрволе провайдера», нет —
#    предупреждение и как смотреть лог.
#
# `--dry-run` выполняет проверки шага 1 и печатает план; код не тратится, ничего не меняется.
# Повторный запуск с новым кодом (админка «Перевыпустить код») переустанавливает сервер: старый
# токен перестаёт действовать, .env перезаписывается.
#
# Для тестов (deploy/test/installScript.test.ts): CG_SYSFS — вместо /sys, CG_INSTALL_ROOT —
# корень, к которому приписываются /opt, /srv, /usr/lib и /var/run (в .env пишутся пути без
# него), CG_CONNECT_TIMEOUT — сколько секунд ждать подключения агента (60); docker, nvidia-smi,
# curl, stat, chown, id подменяются через PATH.
set -euo pipefail

ORCHESTRATOR_PUBLIC_URL="__ORCHESTRATOR_PUBLIC_URL__"
CG_VERSION="__CG_VERSION__"
CG_DRIVERS="__CG_DRIVERS__"
CG_REGISTRY="registry.imtechnologies.ru/gamecrate/imt-cloud-gaming"

# Всё ниже — внутри main, вызов в последней строке: при `curl … | bash` bash читает скрипт из
# stdin по кускам, и без этого оборванная загрузка выполнилась бы наполовину, а команда, читающая
# stdin, съела бы остаток скрипта. Тело main не сдвинуто отступом — так читается как обычный скрипт.
main() {

SYSFS="${CG_SYSFS:-/sys}"
ROOT="${CG_INSTALL_ROOT:-/}"
ROOT="${ROOT%/}"
OPT=/opt/cloud-gaming
UDP_PORT_BASE=59000

fail() {
  echo "ОШИБКА: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Использование: install.sh <код подключения> [--public-ip <ip>] [--data-dir <путь>]
  [--sessions-subnet <a.b.c.0/24>] [--dry-run]
USAGE
}

code=""
public_ip=""
data_dir=/srv/cloud-gaming
sessions_subnet=172.31.240.0/24
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
  --public-ip | --data-dir | --sessions-subnet)
    [ $# -ge 2 ] || {
      usage
      fail "у $1 нет значения"
    }
    case "$1" in
    --public-ip) public_ip="$2" ;;
    --data-dir) data_dir="$2" ;;
    *) sessions_subnet="$2" ;;
    esac
    shift 2
    ;;
  --dry-run)
    dry_run=1
    shift
    ;;
  -*)
    usage
    fail "неизвестный флаг: $1"
    ;;
  *)
    [ -z "${code}" ] || {
      usage
      fail "лишний аргумент: $1"
    }
    code="$1"
    shift
    ;;
  esac
done

case "${ORCHESTRATOR_PUBLIC_URL}" in
__*) fail "это копия из репозитория — скачайте скрипт с главного: curl -fsSL https://<домен>/agent/install.sh" ;;
esac
ORCHESTRATOR_PUBLIC_URL="${ORCHESTRATOR_PUBLIC_URL%/}"
[ -n "${code}" ] || {
  usage
  fail "нет кода подключения (его показывает админка: «Серверы» → «Добавить сервер»)"
}
[[ "${code}" =~ ^[A-Za-z0-9_-]+$ ]] || fail "код подключения — только буквы и цифры, проверьте команду"
[[ "${data_dir}" =~ ^/[^,:[:space:]]*$ ]] || fail "--data-dir: нужен абсолютный путь без пробелов, «,» и «:»"
data_dir="${data_dir%/}"
# Сеть cg-sessions — /24: ip-range контейнеров сессий — верхняя половина (.128/25), cg-agent — .2.
[[ "${sessions_subnet}" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\.0/24$ ]] ||
  fail "--sessions-subnet: нужна подсеть вида a.b.c.0/24, например 172.31.240.0/24"
sessions_ip_range="${BASH_REMATCH[1]}.128/25"
agent_ip="${BASH_REMATCH[1]}.2"
if [ "${CG_VERSION}" = dev ] || ! [[ "${CG_VERSION}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  fail "главный сервер запущен не из релиза (CG_VERSION=${CG_VERSION}) — образов для него в реестре нет"
fi

is_ipv4() {
  local re='^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$' o
  [[ "$1" =~ ${re} ]] || return 1
  for o in "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; do
    [ "${o}" -le 255 ] || return 1
  done
}

# ---------------------------------------------------------------------------------------------
# 1. Проверки
# ---------------------------------------------------------------------------------------------
if [ "${dry_run}" = 0 ] && [ "$(id -u)" != 0 ]; then
  fail "запускать от root: curl -fsSL ${ORCHESTRATOR_PUBLIC_URL}/agent/install.sh | sudo bash -s -- <код>"
fi
command -v docker >/dev/null 2>&1 ||
  fail "нет Docker — установите Docker Engine (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 ||
  fail "нет плагина docker compose — установите docker-compose-plugin"
command -v nvidia-smi >/dev/null 2>&1 || fail "нет nvidia-smi — установите драйвер NVIDIA"
gpus="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null)" ||
  fail "nvidia-smi не отвечает — драйвер NVIDIA не загружен (перезагрузка после установки?)"
driver=""
slots=0
while IFS= read -r line; do
  line="${line//[[:space:]]/}"
  [ -n "${line}" ] || continue
  [ -z "${driver}" ] && driver="${line}"
  [ "${line}" = "${driver}" ] || fail "у GPU разные версии драйвера (${driver} и ${line})"
  slots=$((slots + 1))
done <<<"${gpus}"
[ "${slots}" -gt 0 ] || fail "nvidia-smi не видит ни одной GPU"
[[ "${driver}" =~ ^[0-9]+(\.[0-9]+)+$ ]] || fail "не похоже на версию драйвера NVIDIA: ${driver}"
case "$(docker info --format '{{json .Runtimes}}' 2>/dev/null)" in
*'"nvidia"'*) ;;
*) fail "в Docker нет runtime nvidia — установите NVIDIA Container Toolkit и выполните: nvidia-ctk runtime configure --runtime=docker && systemctl restart docker" ;;
esac
modeset_file="${SYSFS}/module/nvidia_drm/parameters/modeset"
modeset="$(cat "${modeset_file}" 2>/dev/null || true)"
[ "${modeset}" = Y ] ||
  fail "нужен nvidia-drm modeset=1 (сейчас: ${modeset:-модуль nvidia_drm не загружен}) — echo 'options nvidia-drm modeset=1' > /etc/modprobe.d/nvidia-drm.conf, update-initramfs -u, перезагрузка"
supported=0
for d in ${CG_DRIVERS}; do
  [ "${d}" = "${driver}" ] && supported=1
done
[ "${supported}" = 1 ] ||
  fail "драйвер NVIDIA ${driver} не поддерживается релизом ${CG_VERSION} (образы сессии есть для: ${CG_DRIVERS:-ни одного}) — поставьте драйвер из этого списка"
gbm=""
for candidate in \
  "/usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.${driver}" \
  "/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.${driver}"; do
  if [ -f "${ROOT}${candidate}" ]; then
    gbm="${candidate}"
    break
  fi
done
[ -n "${gbm}" ] || fail "не найден libnvidia-allocator.so.${driver} (GBM-бэкенд NVIDIA) ни в /usr/lib/x86_64-linux-gnu/nvidia/current/, ни в /usr/lib/x86_64-linux-gnu/"
docker_gid="$(stat -c %g "${ROOT}/var/run/docker.sock" 2>/dev/null)" ||
  fail "не удалось узнать группу /var/run/docker.sock"
[[ "${docker_gid}" =~ ^[0-9]+$ ]] || fail "странная группа /var/run/docker.sock: ${docker_gid}"
if [ -z "${public_ip}" ]; then
  public_ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null)" ||
    fail "не удалось узнать публичный IP (api.ipify.org) — укажите его: --public-ip <ip>"
fi
is_ipv4 "${public_ip}" || fail "публичный IP не похож на IPv4: ${public_ip}"
is_ipv4 "${agent_ip}" || fail "--sessions-subnet: не похоже на IPv4-подсеть: ${sessions_subnet}"
# Сеть cg-sessions уже есть (прошлая установка или чужая) — только с той же подсетью и ip-range:
# адрес cg-agent и правила изоляции на них завязаны.
network_exists=0
if docker network inspect cg-sessions >/dev/null 2>&1; then
  network_exists=1
  current="$(docker network inspect cg-sessions -f '{{range .IPAM.Config}}{{.Subnet}} {{.IPRange}};{{end}}')"
  if [ "${current}" != "${sessions_subnet} ${sessions_ip_range};" ]; then
    fail "сеть cg-sessions уже есть, но с другой подсетью (${current:-без заданной подсети}), а нужна ${sessions_subnet} с ip-range ${sessions_ip_range}. Пересоздайте её, пока нет сессий и установок: docker ps -a --filter label=cg.session --filter label=cg.install (пусто), docker stop cg-agent, docker network rm cg-sessions — и запустите установку снова (или укажите --sessions-subnet с подсетью этой сети)"
  fi
fi

session_image="${CG_REGISTRY}/cg-session:${driver}-${CG_VERSION}"
app_image="${CG_REGISTRY}/cg-app:${CG_VERSION}"
scratch_dir=/srv/cloud-gaming-scratch
steam_parent=/srv/cloud-gaming-steam
steam_client="${steam_parent}/client"
last_port=$((UDP_PORT_BASE + slots - 1))
if [ "${slots}" = 1 ]; then ports="${UDP_PORT_BASE}"; else ports="${UDP_PORT_BASE}-${last_port}"; fi
# Каталоги хоста: владелец uid 1000 (агент и сессии), STEAM_CLIENT_DIR создаёт сборка шаблона.
dirs=("${data_dir}" "${data_dir}/library" "${data_dir}/library/steamapps"
  "${data_dir}/install-scratch" "${data_dir}/games" "${scratch_dir}" "${steam_parent}")

if [ "${dry_run}" = 1 ]; then
  cat <<PLAN
Проверки пройдены. План установки (--dry-run: код не тратится, ничего не меняется):
  главный сервер: ${ORCHESTRATOR_PUBLIC_URL}
  версия релиза:  ${CG_VERSION} (${app_image})
  драйвер NVIDIA: ${driver}, GPU: ${slots} → SLOTS=${slots}
  образ сессии:   ${session_image}
  GBM:            ${gbm}
  DOCKER_GID:     ${docker_gid}
  публичный IP:   ${public_ip}, UDP ${ports}
  cg-sessions:    ${sessions_subnet}, ip-range ${sessions_ip_range}, cg-agent ${agent_ip}
  1. POST ${ORCHESTRATOR_PUBLIC_URL}/agent/enroll: код → WORKER_ID=<выдаст главный>,
     WORKER_TOKEN=<выдаст главный>; docker login реестра (учётные данные выдаст главный)
  2. docker pull ${session_image}
  3. каталоги (владелец 1000): ${dirs[*]}
  4. сеть cg-sessions; ${OPT}/.env (600), compose.yaml, session-isolation.sh, build-steam-client.sh
  5. session-isolation.sh apply-local --agent-ip ${agent_ip}; docker compose pull && up -d (cg-agent)
  6. шаблон клиента Steam в ${steam_client}, если его нет
PLAN
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# 2. Обмен кода, реестр, образы
# ---------------------------------------------------------------------------------------------
echo "==> обмен кода подключения (${ORCHESTRATOR_PUBLIC_URL})"
# Код — через stdin (не в аргументах curl); ответ с токеном — в переменную, не в файл и не на экран.
response="$(printf '{"code":"%s"}' "${code}" |
  curl -sS --max-time 30 -X POST -H 'content-type: application/json' --data-binary @- \
    -w '\n%{http_code}' "${ORCHESTRATOR_PUBLIC_URL}/agent/enroll")" ||
  fail "главный сервер ${ORCHESTRATOR_PUBLIC_URL} не отвечает"
status="${response##*$'\n'}"
body="${response%$'\n'*}"
case "${status}" in
200) ;;
403) fail "Код подключения недействителен, уже использован или истёк — создайте новый в админке (карточка сервера → «Перевыпустить код»)" ;;
*) fail "главный сервер ответил ${status} на обмен кода" ;;
esac

# Строковое поле `"<ключ>":"<значение>"` ответа (JSON без пробелов, ключи уникальны и во вложенном
# registry). Без jq: его на сервере может не быть. Значения с экранированием (\) не принимаются.
json_str() {
  local v
  v="$(printf '%s' "${body}" | sed -n "s/.*\"$1\":\"\\([^\"\\\\]*\\)\".*/\\1/p")"
  printf '%s' "${v}"
}
worker_id="$(json_str workerId)"
worker_token="$(json_str token)"
orchestrator_url="$(json_str orchestratorUrl)"
[[ "${worker_id}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "главный не выдал workerId"
[[ "${worker_token}" =~ ^cgw_[A-Za-z0-9_-]{43}$ ]] || fail "главный выдал токен не того формата"
[[ "${orchestrator_url}" =~ ^wss?://[^[:space:]]+$ ]] || fail "главный не выдал адрес WebSocket оркестратора"
case "${body}" in
*'"registry":null'*)
  echo "    реестр главным не задан — образы скачиваются без логина"
  ;;
*)
  registry_server="$(json_str server)"
  registry_user="$(json_str username)"
  registry_password="$(json_str password)"
  [ -n "${registry_server}" ] && [ -n "${registry_user}" ] && [ -n "${registry_password}" ] ||
    fail "главный выдал неполные учётные данные реестра"
  echo "==> docker login ${registry_server}"
  printf '%s' "${registry_password}" |
    docker login --username "${registry_user}" --password-stdin "${registry_server}" >/dev/null ||
    fail "docker login ${registry_server} не прошёл"
  unset registry_password
  ;;
esac

echo "==> образы релиза ${CG_VERSION}"
for image in "${app_image}" "${session_image}"; do
  docker manifest inspect "${image}" >/dev/null 2>&1 ||
    fail "в реестре нет ${image} — релиз ${CG_VERSION} собран не для драйвера ${driver}? Код уже использован: создайте новый в админке после исправления"
done
echo "==> docker pull ${session_image} (несколько ГБ)"
docker pull "${session_image}" </dev/null || fail "не удалось скачать ${session_image}"

# ---------------------------------------------------------------------------------------------
# 3. Каталоги, сеть, .env и файлы с главного
# ---------------------------------------------------------------------------------------------
echo "==> каталоги (владелец uid 1000)"
for d in "${dirs[@]}"; do
  mkdir -p "${ROOT}${d}"
  chown 1000:1000 "${ROOT}${d}"
  echo "    ${d}"
done

if [ "${network_exists}" = 0 ]; then
  echo "==> сеть cg-sessions (${sessions_subnet}, ip-range ${sessions_ip_range})"
  docker network create --subnet "${sessions_subnet}" --ip-range "${sessions_ip_range}" \
    cg-sessions >/dev/null ||
    fail "не удалось создать сеть cg-sessions ${sessions_subnet} — подсеть занята другой сетью Docker или сетью хоста? Код уже использован: создайте новый в админке и запустите установку с --sessions-subnet <свободная a.b.c.0/24>"
fi

echo "==> ${OPT}"
mkdir -p "${ROOT}${OPT}"
chmod 700 "${ROOT}${OPT}"
umask 077
env_tmp="${ROOT}${OPT}/.env.new"
cat >"${env_tmp}" <<ENV
# Игровой сервер ${worker_id}: записал deploy/worker/install.sh $(date -u +%Y-%m-%dT%H:%MZ).
# Переменные deploy/compose.worker.yaml; WORKER_TOKEN — секрет (права 600), не выводить.
CG_REGISTRY=${CG_REGISTRY}
CG_VERSION=${CG_VERSION}
ORCHESTRATOR_URL=${orchestrator_url}
WORKER_ID=${worker_id}
WORKER_TOKEN=${worker_token}
WORKER_PUBLIC_IP=${public_ip}
SLOTS=${slots}
UDP_PORT_BASE=${UDP_PORT_BASE}
SESSION_IMAGE=${session_image}
GBM_ALLOCATOR_PATH=${gbm}
DOCKER_GID=${docker_gid}
ROLES=worker,gamestore
CG_DATA_DIR=${data_dir}
SCRATCH_DIR=${scratch_dir}
STEAM_CLIENT_DIR=${steam_client}
STEAM_CLIENT_PARENT=${steam_parent}
MIN_FREE_GB=20
CG_SESSIONS_SUBNET=${sessions_subnet}
CG_SESSIONS_IP_RANGE=${sessions_ip_range}
CG_AGENT_IP=${agent_ip}
ENV
unset worker_token
chmod 600 "${env_tmp}"
chown root:root "${env_tmp}"
mv -f "${env_tmp}" "${ROOT}${OPT}/.env"
umask 022

download() {
  curl -fsSL --max-time 60 -o "${ROOT}${OPT}/$2" "${ORCHESTRATOR_PUBLIC_URL}/agent/$1" ||
    fail "не удалось скачать ${ORCHESTRATOR_PUBLIC_URL}/agent/$1"
}
download compose.worker.yaml compose.yaml
download session-isolation.sh session-isolation.sh
download build-steam-client.sh build-steam-client.sh
chmod 755 "${ROOT}${OPT}/session-isolation.sh" "${ROOT}${OPT}/build-steam-client.sh"

# ---------------------------------------------------------------------------------------------
# 4. Агент и изоляция сессий
# ---------------------------------------------------------------------------------------------
compose() {
  docker compose -f "${ROOT}${OPT}/compose.yaml" --env-file "${ROOT}${OPT}/.env" "$@"
}
# Изоляция — до старта агента: его адрес закреплён, и сессий без правил не будет ни секунды.
# Не применилась или не сохранилась — останавливаем агент прежней установки, если он запущен.
echo "==> изоляция контейнеров сессий"
if ! bash "${ROOT}${OPT}/session-isolation.sh" apply-local --agent-ip "${agent_ip}" </dev/null; then
  compose stop </dev/null >/dev/null 2>&1 || true
  fail "правила изоляции сессий не применились или не сохранились — агент не запущен, чтобы сервер не брал игроков без изоляции. Исправьте и запустите: ${OPT}/session-isolation.sh apply-local --agent-ip ${agent_ip} && docker compose -f ${OPT}/compose.yaml --env-file ${OPT}/.env up -d"
fi

echo "==> cg-agent ${CG_VERSION}"
compose pull </dev/null
compose up -d </dev/null

# ---------------------------------------------------------------------------------------------
# 5. Шаблон клиента Steam
# ---------------------------------------------------------------------------------------------
if [ -x "${ROOT}${steam_client}/ubuntu12_32/steam" ]; then
  echo "==> шаблон клиента Steam уже есть (${steam_client})"
else
  echo "==> шаблон клиента Steam (~2,5 ГБ, 10–30 минут; пока его нет, сервер не берёт сессии)"
  bash "${ROOT}${OPT}/build-steam-client.sh" --env-file "${ROOT}${OPT}/.env" </dev/null ||
    echo "ПРЕДУПРЕЖДЕНИЕ: шаблон клиента Steam не собран — повторить: sudo ${OPT}/build-steam-client.sh" >&2
fi

# ---------------------------------------------------------------------------------------------
# 6. Подключился ли агент
# ---------------------------------------------------------------------------------------------
# «Connected to orchestrator» агент пишет после первого отчёта, принятого оркестратором (снимок
# загрузки раз в 5 с) — значит, токен принят и связь есть. Лог — сначала в переменную: с
# `docker logs | grep -q` grep выходит на первом совпадении, docker logs получает SIGPIPE, и под
# pipefail конвейер давал 141 — ложное «не подключился».
connected=0
deadline=$((SECONDS + ${CG_CONNECT_TIMEOUT:-60}))
while :; do
  agent_log="$(docker logs cg-agent 2>&1 </dev/null || true)"
  if [ "$(docker inspect -f '{{.State.Running}}' cg-agent 2>/dev/null)" = true ] &&
    [[ "${agent_log}" == *"Connected to orchestrator"* ]]; then
    connected=1
    break
  fi
  [ "${SECONDS}" -lt "${deadline}" ] || break
  sleep 2
done

echo
if [ "${connected}" = 1 ]; then
  echo "Сервер ${worker_id} подключён. Откройте UDP ${ports} в файрволе провайдера."
else
  echo "ПРЕДУПРЕЖДЕНИЕ: cg-agent не подключился к главному за ${CG_CONNECT_TIMEOUT:-60} с." >&2
  echo "Лог: docker logs --tail 50 cg-agent (ошибка конфига, токена или сети до ${ORCHESTRATOR_PUBLIC_URL})." >&2
  echo "Когда подключится — сервер появится в админке. Откройте UDP ${ports} в файрволе провайдера." >&2
fi

}

main "$@"
