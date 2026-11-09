#!/usr/bin/env bash
# Проверка сетевой изоляции cg-sessions без sudo (deploy/session-isolation.sh правила сам не
# применяет — эта проверка просто показывает, что сейчас открыто/закрыто).
#
#   ./deploy/check-session-isolation.sh [ssh-хост=brofrong]
#
# Поднимает на воркере два временных контейнера в сети cg-sessions (образ SESSION_IMAGE из
# ~/cloud-gaming/.env, явный --entrypoint sleep … infinity, своя метка cg.isolation-check, без
# GPU) и изнутри первого (`docker exec curl -m 3`, TCP) проверяет:
#   - шлюз моста cg-sessions :22 (адрес хоста с моста);
#   - LAN-адрес хоста :22 и LAN-шлюз хоста :80 (`ip route get 1.1.1.1` на самом хосте: `src` и
#     `via`) — тоже адреса хоста/LAN, просто не через мост cg-sessions;
#   - второй контейнер :8080 (в нём поднят `python3 -m http.server 8080`) — другой контейнер
#     моста, не cg-agent;
#   - cg-agent:8080 — контейнеру моста, которому разрешён только исходящий к сессиям :8080
#     (тоннель стрима), не входящий от них (у агента нет слушающих портов: без правил — отказ
#     в соединении, `reachable`);
#   - https://store.steampowered.com — интернет (и DNS сессий), должен остаться открытым.
# «факт»: closed — таймаут (curl 28, его дают DROP-правила); reachable — отказ в соединении
# (curl 7: адрес ответил, закрыт только порт — изоляции нет); dns-fail — имя не разрешилось
# (curl 6: DNS сессий сломан); open — соединение установлено (для интернета — только curl 0,
# прочие коды — fail:<код curl>).
# Печатает таблицу «цель | ожидается | факт»; код 0 — всё совпало, 1 — где-то открыто то, что
# должно быть закрыто, или интернет/DNS не работает. На сервере без применённых правил (см.
# deploy/session-isolation.sh и раздел в deploy/README.md) ожидаемо код 1 — это не баг, а
# отсутствие правил.
# Контейнеры удаляются в trap при любом выходе; ничего, кроме них (по метке cg.isolation-check),
# скрипт не трогает.
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
image="$(envval SESSION_IMAGE cg-session:550.163.01)"
label_key="cg.isolation-check"
a="cg-isolation-check-a"
b="cg-isolation-check-b"

# Наш контейнер — только если метка совпадает; без неё (в т.ч. нет контейнера вовсе) — не наш.
is_ours() {
  local n="$1"
  docker inspect "${n}" >/dev/null 2>&1 || return 1
  [ "$(docker inspect -f "{{index .Config.Labels \"${label_key}\"}}" "${n}" 2>/dev/null)" = 1 ]
}

# cleanup сам перепроверяет метку перед удалением — если remnant-проверка ниже откажет и выйдет
# (чужой контейнер с тем же именем), trap на EXIT не должен снести его за компанию.
cleanup() {
  local n
  for n in "${a}" "${b}"; do
    is_ours "${n}" && docker rm -f "${n}" >/dev/null 2>&1
  done
}
trap cleanup EXIT

# Остаток прошлого прерванного запуска — только свой (по метке), чужой одноимённый не трогаем.
for n in "${a}" "${b}"; do
  if docker inspect "${n}" >/dev/null 2>&1; then
    if ! is_ours "${n}"; then
      echo "ОШИБКА: контейнер ${n} без метки ${label_key} — не наш, не трогаем" >&2
      exit 1
    fi
    docker rm -f "${n}" >/dev/null
  fi
done

docker network inspect cg-sessions >/dev/null 2>&1 || {
  echo "ОШИБКА: сети cg-sessions нет на этом сервере" >&2
  exit 1
}

bridge_gw="$(docker network inspect cg-sessions -f '{{(index .IPAM.Config 0).Gateway}}')"
# `ip route get 1.1.1.1` на самом хосте: "1.1.1.1 via <gw> dev <if> src <ip> ..."
lan_gw="$(ip route get 1.1.1.1 | sed -n 's/.* via \([0-9.]*\).*/\1/p' | head -n 1)"
host_ip="$(ip route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
if [ -z "${bridge_gw}" ] || [ -z "${lan_gw}" ] || [ -z "${host_ip}" ]; then
  echo "ОШИБКА: не удалось определить шлюз моста (${bridge_gw}) / LAN хоста (${host_ip} via ${lan_gw})" >&2
  exit 1
fi

echo "==> временные контейнеры ${a}/${b} (образ ${image}, без GPU)"
docker run -d --name "${b}" --label "${label_key}=1" --network cg-sessions \
  --security-opt no-new-privileges:true --entrypoint sleep "${image}" infinity >/dev/null
docker exec -d "${b}" python3 -m http.server 8080
docker run -d --name "${a}" --label "${label_key}=1" --network cg-sessions \
  --security-opt no-new-privileges:true --entrypoint sleep "${image}" infinity >/dev/null

# Подождать, пока ${a} сможет exec (контейнер поднялся) — без этого первый curl может промахнуться.
for ((i = 0; i < 50; i++)); do
  docker exec "${a}" true >/dev/null 2>&1 && break
  sleep 0.2
done

# curl -m 3 изнутри ${a}. Закрытый адрес (`closed`) — только таймаут (28): DROP молчит, а отказ
# в соединении (7) значит, что хост ответил (`reachable`). 6 — имя (контейнера) не разрешилось,
# проверки не было (`dns-fail`). Любое другое — соединение было (даже с протокольной ошибкой
# HTTP) — `open`.
tcp_check() {
  local url="$1" rc
  set +e
  docker exec "${a}" curl -m 3 -s -o /dev/null "${url}" >/dev/null 2>&1
  rc=$?
  set -e
  case "${rc}" in
  28) echo closed ;;
  7) echo reachable ;;
  6) echo dns-fail ;;
  *) echo open ;;
  esac
}

# Интернет: `open` — только curl 0 (ответ получен, любой HTTP-статус); 6 — `dns-fail` (DNS
# сессий сломан, например DNS-сервер хоста попал под DROP частных диапазонов).
internet_check() {
  local url="$1" rc
  set +e
  docker exec "${a}" curl -m 3 -s -o /dev/null "${url}" >/dev/null 2>&1
  rc=$?
  set -e
  case "${rc}" in
  0) echo open ;;
  6) echo dns-fail ;;
  *) echo "fail:${rc}" ;;
  esac
}

printf '%-32s | %-9s | %-9s\n' "цель" "ожидается" "факт"
printf '%-32s-+-%-9s-+-%-9s\n' "--------------------------------" "---------" "---------"
ok=0
row() {
  local name="$1" check="$2" url="$3" expect="$4" actual
  actual="$("${check}" "${url}")"
  printf '%-32s | %-9s | %-9s\n' "${name}" "${expect}" "${actual}"
  [ "${actual}" = "${expect}" ] || ok=1
}

row "шлюз моста cg-sessions:22" tcp_check "http://${bridge_gw}:22" closed
row "LAN-адрес хоста:22" tcp_check "http://${host_ip}:22" closed
row "LAN-шлюз хоста:80" tcp_check "http://${lan_gw}:80" closed
row "второй контейнер моста:8080" tcp_check "http://${b}:8080" closed
row "cg-agent:8080" tcp_check "http://cg-agent:8080" closed
row "интернет (store.steampowered.com)" internet_check "https://store.steampowered.com" open

exit "${ok}"
REMOTE
