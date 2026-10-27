#!/usr/bin/env bash
# Правила iptables/ip6tables для сети cg-sessions (новый сервер — на `brofrong` нет sudo, там
# правила не применяются, только deploy/check-session-isolation.sh показывает текущее состояние).
#
# Контейнеры сессий и установщиков должны видеть интернет (Steam, игры), но не адреса хоста,
# локальную сеть и другие контейнеры моста cg-sessions, кроме cg-api -> :8080 (Selkies-стрим
# сессии через cg-api). Ответы на уже установленные соединения (ESTABLISHED,RELATED) разрешены
# всегда — иначе сломается и сам интернет-трафик сессий. Подробности — спека §4.4
# (docs/superpowers/specs/2026-10-27-kiosk-image-design.md).
#
#   ./deploy/session-isolation.sh detect [ssh-хост=brofrong]
#     только читает (ничего не меняет и не применяет) `docker network inspect cg-sessions` и
#     `docker inspect cg-api` на сервере; печатает готовую строку аргументов для `print`.
#
#   ./deploy/session-isolation.sh print --subnet <cidr> --bridge <ifname> --api-ip <ip> \
#       [--subnet6 <cidr>]
#     печатает в stdout фрагмент дампа `iptables-save` (таблица `filter`, цепочки `DOCKER-USER`
#     и `INPUT`) — сам ничего не применяет. Неверный или неполный набор аргументов — код 2,
#     stdout пуст.
#
# Как применить на новом сервере (владелец, вручную, с sudo — см. раздел в deploy/README.md):
#   1. ./deploy/session-isolation.sh detect <хост>            — узнать подсеть/мост/IP cg-api;
#   2. ./deploy/session-isolation.sh print <аргументы detect> — посмотреть правила глазами;
#   3. применить:
#        ssh <хост> './deploy/session-isolation.sh print <аргументы> \
#          | sed "/^# ip6tables/,\$d" | sudo iptables-restore -n'
#        # если detect напечатал --subnet6 — вторая часть вывода (после строки "# ip6tables"):
#        ssh <хост> './deploy/session-isolation.sh print <аргументы> \
#          | sed -n "/^# ip6tables/,\$p" | tail -n +2 | sudo ip6tables-restore -n'
#      `-n` (noflush) не трогает остальные таблицы/правила хоста; политики встроенных цепочек в
#      дампе помечены `-` — `*tables-restore` их не меняет. Цепочка `DOCKER-USER` — общая для всех
#      сетей docker на хосте: если на сервере появятся другие сети/сервисы с правилами в ней, этот
#      дамп нужно будет совмещать с ними руками (здесь `-n` не защищает от повторного накопления
#      дублей при повторном применении — перед повтором стоит почистить старые строки);
#   4. сохранить после перезагрузки (Debian/Ubuntu, пакет iptables-persistent):
#        sudo apt install iptables-persistent && sudo netfilter-persistent save
#      (или вручную: sudo sh -c 'iptables-save > /etc/iptables/rules.v4' и так же для ip6tables);
#   5. проверить: ./deploy/check-session-isolation.sh <хост> → код 0, все «закрыто» — закрыто.
#
# Если `cg-api` пересоздан с другим IP — повторить шаги 1–3 (правило с его старым IP само не
# исчезнет, его нужно убрать так же руками, как при любом повторном применении).
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Использование:
  deploy/session-isolation.sh detect [ssh-хост=brofrong]
  deploy/session-isolation.sh print --subnet <cidr> --bridge <ifname> --api-ip <ip> [--subnet6 <cidr>]
USAGE
}

is_ipv4() {
  local re='^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$'
  [[ "$1" =~ ${re} ]] || return 1
  local o
  for o in "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; do
    [ "${o}" -le 255 ] || return 1
  done
}

is_ipv4_cidr() {
  [[ "$1" =~ ^([0-9.]+)/([0-9]{1,2})$ ]] || return 1
  is_ipv4 "${BASH_REMATCH[1]}" || return 1
  [ "${BASH_REMATCH[2]}" -le 32 ]
}

is_ipv6_cidr() {
  # Упрощённо: hex-группы и ":", префикс 0–128 — достаточно, чтобы отличить от опечатки/IPv4.
  [[ "$1" =~ ^([0-9A-Fa-f:]+)/([0-9]{1,3})$ ]] || return 1
  [[ "${BASH_REMATCH[1]}" == *:* ]] || return 1
  [ "${BASH_REMATCH[2]}" -le 128 ]
}

is_ifname() {
  [[ "$1" =~ ^[A-Za-z0-9_.-]+$ ]]
}

cmd_print() {
  local subnet="" bridge="" api_ip="" subnet6=""
  while [ $# -gt 0 ]; do
    case "$1" in
    --subnet | --bridge | --api-ip | --subnet6)
      # Флаг без значения: `shift 2` при единственном оставшемся аргументе под `set -e` уронит
      # скрипт с кодом 1 без сообщения — проверяем заранее и даём код 2, как остальным ошибкам.
      if [ $# -lt 2 ]; then
        echo "ОШИБКА: у $1 нет значения" >&2
        exit 2
      fi
      ;;
    esac
    case "$1" in
    --subnet)
      subnet="$2"
      shift 2
      ;;
    --bridge)
      bridge="$2"
      shift 2
      ;;
    --api-ip)
      api_ip="$2"
      shift 2
      ;;
    --subnet6)
      subnet6="$2"
      shift 2
      ;;
    *)
      echo "ОШИБКА: неизвестный аргумент: $1" >&2
      exit 2
      ;;
    esac
  done

  if [ -z "${subnet}" ] || [ -z "${bridge}" ] || [ -z "${api_ip}" ]; then
    echo "ОШИБКА: нужны --subnet, --bridge и --api-ip" >&2
    usage
    exit 2
  fi
  is_ipv4_cidr "${subnet}" || {
    echo "ОШИБКА: --subnet не похож на IPv4 CIDR: ${subnet}" >&2
    exit 2
  }
  is_ifname "${bridge}" || {
    echo "ОШИБКА: --bridge не похож на имя интерфейса: ${bridge}" >&2
    exit 2
  }
  is_ipv4 "${api_ip}" || {
    echo "ОШИБКА: --api-ip не похож на IPv4: ${api_ip}" >&2
    exit 2
  }
  if [ -n "${subnet6}" ]; then
    is_ipv6_cidr "${subnet6}" || {
      echo "ОШИБКА: --subnet6 не похож на IPv6 CIDR: ${subnet6}" >&2
      exit 2
    }
  fi

  # :INPUT/:DOCKER-USER со значением "-" вместо политики — *tables-restore не трогает текущую
  # политику встроенной цепочки INPUT, а DOCKER-USER (не встроенная) всегда "-".
  cat <<RULES
*filter
:INPUT - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -i ${bridge} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -i ${bridge} -o ${bridge} -s ${api_ip} -p tcp --dport 8080 -j RETURN
-A DOCKER-USER -i ${bridge} -o ${bridge} -j DROP
-A DOCKER-USER -i ${bridge} -d 10.0.0.0/8 -j DROP
-A DOCKER-USER -i ${bridge} -d 172.16.0.0/12 -j DROP
-A DOCKER-USER -i ${bridge} -d 192.168.0.0/16 -j DROP
-A DOCKER-USER -i ${bridge} -d 169.254.0.0/16 -j DROP
-A DOCKER-USER -i ${bridge} -d 100.64.0.0/10 -j DROP
-A INPUT -i ${bridge} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A INPUT -i ${bridge} -j DROP
COMMIT
RULES

  if [ -n "${subnet6}" ]; then
    # Без отдельного IPv6-адреса cg-api (--api-ip — только IPv4, см. детект): бридж-бридж по v6
    # закрыт целиком — cg-api -> сессии ходит по v4, это не хуже, чем изоляция, которую просят.
    cat <<RULES6
# ip6tables
*filter
:INPUT - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -i ${bridge} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -i ${bridge} -o ${bridge} -j DROP
-A DOCKER-USER -i ${bridge} -d fc00::/7 -j DROP
-A DOCKER-USER -i ${bridge} -d fe80::/10 -j DROP
-A INPUT -i ${bridge} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A INPUT -i ${bridge} -j DROP
COMMIT
RULES6
  fi
}

cmd_detect() {
  local host="${1:-brofrong}"
  local out net_line api_ip net_id options_json subnets subnet="" subnet6="" s

  out="$(ssh "${host}" bash -s <<'REMOTE'
set -euo pipefail
docker network inspect cg-sessions \
  -f '{{.Id}}|{{json .Options}}|{{range .IPAM.Config}}{{.Subnet}};{{end}}'
docker inspect cg-api -f '{{(index .NetworkSettings.Networks "cg-sessions").IPAddress}}'
REMOTE
  )"

  net_line="$(printf '%s\n' "${out}" | sed -n '1p')"
  api_ip="$(printf '%s\n' "${out}" | sed -n '2p')"
  IFS='|' read -r net_id options_json subnets <<<"${net_line}"

  # {{json .Options}} — валидный JSON ({} если опций нет); извлекаем ключ без jq (его на
  # воркере может не быть — только локально).
  local bridge
  bridge="$(printf '%s' "${options_json}" |
    sed -n 's/.*"com\.docker\.network\.bridge\.name":"\([^"]*\)".*/\1/p')"
  if [ -z "${bridge}" ]; then
    bridge="br-${net_id:0:12}"
  fi

  IFS=';' read -ra subnet_arr <<<"${subnets}"
  for s in "${subnet_arr[@]}"; do
    [ -z "${s}" ] && continue
    case "${s}" in
    *:*) subnet6="${s}" ;;
    *) subnet="${s}" ;;
    esac
  done

  if [ -z "${subnet}" ] || [ -z "${bridge}" ] || [ -z "${api_ip}" ]; then
    echo "ОШИБКА: не удалось определить подсеть/мост/IP cg-api на ${host}" >&2
    echo "    net_line=${net_line@Q} api_ip=${api_ip@Q}" >&2
    exit 1
  fi

  printf -- '--subnet %s --bridge %s --api-ip %s' "${subnet}" "${bridge}" "${api_ip}"
  if [ -n "${subnet6}" ]; then
    printf -- ' --subnet6 %s' "${subnet6}"
  fi
  printf '\n'
}

case "${1:-}" in
print)
  shift
  cmd_print "$@"
  ;;
detect)
  shift
  cmd_detect "$@"
  ;;
*)
  usage
  exit 2
  ;;
esac
