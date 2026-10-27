#!/usr/bin/env bash
# Сборка шаблона клиента Steam STEAM_CLIENT_DIR (lower overlay `~/.local/share/Steam` всех
# сессий и установщиков) на воркере (по умолчанию brofrong).
#
#   ./deploy/build-steam-client.sh [ssh-хост]
#
# 1. Отказ, если на воркере есть созданные или запущенные сессии, установки или другая сборка
#    (метки cg.session, cg.install, cg.template): клиент — lower их overlay, менять его под живыми
#    нельзя. Сервис на время сборки должен простаивать (см. README).
# 2. Контейнер образа сессии (SESSION_IMAGE) с пустым домом и CG_MODE=install — те же GPU, shm,
#    no-new-privileges, /dev/input и GBM, что у сессий (agent: desktopSpec); cg-launch запускает
#    `steam -silent`, Steam сам скачивает обновление (~500 МБ) и
#    распаковывает клиент (~2,5 ГБ).
# 3. Цикл: ждать logs/connection_log.txt и 60 с без роста ~/.local/share/Steam (рост < 1 МБ, без
#    logs/, htmlcache/, dumps/ — их клиент пишет и в простое) → cg-steam-shutdown. Два цикла
#    (второй — `steam -silent` через `docker exec` и cg-session-exec, в окружении процесса сессии:
#    labwc, или plasmashell на старом образе KDE, как в cg-steam-shutdown): за первый
#    steamrt64/appcache распаковываются не до конца, и каждая сессия потом сама докачивала
#    ~480 МБ и долго входила.
# 4. `docker cp` клиента в <STEAM_CLIENT_DIR>.new без logs/ и с пустым steamapps/ (1000:1000).
# 5. Замена каталога переименованием (`mv --exchange`), старый удаляется контейнером-помощником
#    от root (в старом шаблоне могут быть файлы root).
#
# Пути и образ — из ~/cloud-gaming/.env на воркере (только несекретные CG_DATA_DIR, SESSION_IMAGE,
# GBM_ALLOCATOR_PATH), иначе значения по умолчанию как в deploy/compose.yaml. sudo не нужен;
# ничего, кроме своего каталога, своих контейнеров с меткой cg.template и сети cg-sessions
# (создаётся, если её нет), не меняет.
set -euo pipefail

REMOTE_HOST="${1:-brofrong}"
REMOTE_DIR="cloud-gaming"

ssh "${REMOTE_HOST}" bash -s -- "${REMOTE_DIR}" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"
envval() {
  local v=""
  [ -f ~/"${REMOTE_DIR}"/.env ] && v="$(sed -n "s/^$1=//p" ~/"${REMOTE_DIR}"/.env | tail -n 1)"
  printf '%s' "${v:-$2}"
}
data="$(envval CG_DATA_DIR /raid/cloud-gaming)"
image="$(envval SESSION_IMAGE cg-session:550.163.01)"
gbm="$(envval GBM_ALLOCATOR_PATH /usr/lib/x86_64-linux-gnu/nvidia/current/libnvidia-allocator.so.550.163.01)"
target="${data}/steam-client"
new="${target}.new"
name="cg-steam-client-build"
label="cg.template=steam-client"
steam=/home/ubuntu/.local/share/Steam
# Ожидание одного цикла: скачивание ~500 МБ и распаковка в ~2,5 ГБ.
cycle_timeout_sec=1800
quiet_sec=60
# Рост меньше этого (КБ) за quiet_sec считается простоем.
quiet_growth_kb=1024
poll_sec=10

# Созданные (агент создал, ещё не запустил) считаются как запущенные; остановленные — нет.
busy() {
  for l in cg.session cg.install cg.template; do
    docker ps -a --filter "label=${l}" --filter status=created --filter status=running \
      --filter status=restarting --filter status=paused --format "{{.Names}} ({{.State}}, ${l})"
  done
}
refuse_if_busy() {
  local b
  b="$(busy)"
  if [ -n "${b}" ]; then
    echo "ОШИБКА: запущены контейнеры (клиент Steam — lower их overlay, GPU одна):" >&2
    printf '%s\n' "${b}" | sed 's/^/  /' >&2
    echo "Остаток прерванной сборки (${name}) — удалить: docker rm -f ${name}" >&2
    exit 1
  fi
}

# rm -rf от root помощником: только ровно ${new} (монтируется родитель — точку монтирования rm
# не удалил бы).
rootrm_new() {
  [ -e "${new}" ] || return 0
  docker run --rm --network none --user 0 --security-opt no-new-privileges:true \
    --label "${label}-cleanup" -v "${data}:${data}" --entrypoint rm "${image}" -rf -- "${new}"
}

echo "==> ${target} из образа ${image}"
docker image inspect "${image}" >/dev/null 2>&1 || {
  echo "ОШИБКА: образа ${image} нет — сначала ./deploy/build-session-image.sh" >&2
  exit 1
}
refuse_if_busy

# Остаток прошлой сборки — только наш (по метке), чужой одноимённый не трогаем.
if docker inspect "${name}" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{index .Config.Labels "cg.template"}}' "${name}")" != steam-client ]; then
    echo "ОШИБКА: контейнер ${name} без метки ${label} — не наш, не трогаем" >&2
    exit 1
  fi
  docker rm -f "${name}" >/dev/null
fi
cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

mkdir -p "${data}"
docker network inspect cg-sessions >/dev/null 2>&1 || docker network create cg-sessions >/dev/null

gbm_binds=()
if [ -f "${gbm}" ]; then
  gbm_binds=(-v "${gbm}:/usr/lib/x86_64-linux-gnu/libnvidia-allocator.so.1:ro"
    -v "${gbm}:/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so:ro")
else
  echo "    ВНИМАНИЕ: ${gbm} не найден — без GBM-бэкенда NVIDIA" >&2
fi

echo "==> контейнер ${name}"
# PASSWD — случайный, через окружение docker CLI (не в аргументах), как у сессий.
PASSWD="$(head -c 18 /dev/urandom | base64)" docker run -d --name "${name}" --label "${label}" \
  --runtime nvidia --gpus all --shm-size 2g \
  --security-opt no-new-privileges:true \
  --tmpfs /dev/input:mode=1777,size=64k,nosuid,nodev,noexec \
  --network cg-sessions \
  "${gbm_binds[@]}" \
  -e CG_MODE=install -e PASSWD \
  "${image}" >/dev/null

# Ждать, пока клиент Steam войдёт в цикл: есть logs/connection_log.txt и каталог (без logs/,
# htmlcache/, dumps/) за quiet_sec секунд вырос меньше чем на quiet_growth_kb.
wait_idle() {
  local start now size last=-1000000 since
  start="$(date +%s)"
  since="${start}"
  while :; do
    sleep "${poll_sec}"
    now="$(date +%s)"
    if [ "$(docker inspect -f '{{.State.Running}}' "${name}")" != true ]; then
      echo "ОШИБКА: ${name} остановился; docker logs:" >&2
      docker logs --tail 50 "${name}" >&2 || true
      exit 1
    fi
    size="$(docker exec "${name}" du -sk --exclude=logs --exclude=htmlcache --exclude=dumps \
      "${steam}" 2>/dev/null | cut -f1 || true)"
    size="${size:-0}"
    if [ $((size - last)) -ge "${quiet_growth_kb}" ] || [ $((last - size)) -ge "${quiet_growth_kb}" ]; then
      last="${size}"
      since="${now}"
      echo "    $((now - start)) с: $((size / 1024)) МБ"
    fi
    if docker exec "${name}" test -f "${steam}/logs/connection_log.txt" &&
      [ $((now - since)) -ge "${quiet_sec}" ]; then
      echo "    клиент в цикле: $((size / 1024)) МБ, ${quiet_sec} с без роста"
      return
    fi
    if [ $((now - start)) -ge "${cycle_timeout_sec}" ]; then
      echo "ОШИБКА: клиент Steam не вошёл в цикл за ${cycle_timeout_sec} с; docker logs:" >&2
      docker logs --tail 50 "${name}" >&2 || true
      exit 1
    fi
  done
}

shutdown_steam() {
  docker exec "${name}" cg-steam-shutdown || {
    echo "ОШИБКА: cg-steam-shutdown не закрыл Steam" >&2
    exit 1
  }
}

echo "==> цикл 1: первый запуск Steam"
wait_idle
shutdown_steam

echo "==> цикл 2: повторный запуск (довести steamrt64/appcache)"
# Без logs/ connection_log.txt появится заново только после нового входа в цикл. Steam — через
# `docker exec` и cg-session-exec (окружение процесса сессии: labwc, или plasmashell на старом
# образе KDE — переменные из /proc/<pid>/environ, как в cg-steam-shutdown): автостарт cg-launch
# второй раз не сработает (замок), а restart контейнера не нужен.
docker exec "${name}" rm -rf "${steam}/logs"
docker exec -d "${name}" cg-session-exec \
  bash -c 'exec steam -silent </dev/null >/tmp/cg-steam-template.log 2>&1'
for ((i = 0; ; i++)); do
  docker exec "${name}" pgrep -f 'ubuntu12_32/steam( |$)' >/dev/null && break
  if [ "${i}" -ge 120 ]; then
    echo "ОШИБКА: Steam не запустился через docker exec за 120 с (нет процесса сессии?)" >&2
    docker exec "${name}" tail -n 20 /tmp/cg-steam-template.log >&2 || true
    exit 1
  fi
  sleep 1
done
wait_idle
shutdown_steam
docker stop "${name}" >/dev/null

echo "==> копирование в ${new}"
rootrm_new
mkdir "${new}"
docker cp "${name}:${steam}/." "${new}"
rm -rf "${new}/logs" "${new}/steamapps"
mkdir "${new}/steamapps"
if [ ! -x "${new}/ubuntu12_32/steam" ]; then
  echo "ОШИБКА: в ${new} нет ubuntu12_32/steam — клиент не скачался" >&2
  exit 1
fi
foreign="$(find "${new}" ! -uid 1000 -print -quit)"
if [ -n "${foreign}" ]; then
  echo "ОШИБКА: в ${new} есть файлы не uid 1000, например ${foreign}" >&2
  exit 1
fi
# По одному: du с несколькими путями не считает повторно вложенные в уже посчитанный каталог.
for d in "${new}" "${new}/steamrt64" "${new}/appcache" "${new}/package"; do
  du -sh "${d}" 2>/dev/null | sed 's/^/    /' || true
done

echo "==> замена ${target}"
refuse_if_busy
if [ -e "${target}" ]; then
  mv -T --exchange "${new}" "${target}"
  echo "==> удаление прошлого шаблона"
  rootrm_new
else
  mv -T "${new}" "${target}"
fi
echo "==> готово: $(du -sh "${target}" | cut -f1) в ${target}"
REMOTE
