#!/usr/bin/env bash
# Правила iptables/ip6tables для сети cg-sessions (новый сервер — на `brofrong` нет sudo, там
# правила не применяются, только deploy/check-session-isolation.sh показывает текущее состояние).
#
# Контейнеры сессий и установщиков должны видеть интернет (Steam, игры), но не адреса хоста,
# локальную сеть и другие контейнеры моста cg-sessions, кроме cg-api -> :8080 (Selkies-стрим
# сессии через cg-api). Ответы на уже установленные соединения (ESTABLISHED,RELATED) разрешены
# всегда — иначе сломается и сам интернет-трафик сессий. DNS-серверы хоста (`--resolver`, их
# находит `detect`) открыты для :53 — встроенный DNS Docker (127.0.0.11) шлёт внешние запросы
# из сети контейнера, и без этого исключения DNS сессий ломается, если сервер в частной сети
# (10/8, 192.168/16, 169.254/16…). Подробности — спека §4.4
# (docs/superpowers/specs/2026-10-27-kiosk-image-design.md).
#
#   ./deploy/session-isolation.sh detect [ssh-хост=brofrong]
#     только читает (ничего не меняет и не применяет) `docker network inspect cg-sessions`,
#     `docker inspect cg-api` и DNS-серверы хоста (`/run/systemd/resolve/resolv.conf`, если он
#     есть, иначе `/etc/resolv.conf`; 127.x и ::1 пропускаются — их Docker спрашивает из сети
#     хоста, IPv6-серверы тоже, с предупреждением) на сервере; печатает готовую строку
#     аргументов для `print`.
#
#   ./deploy/session-isolation.sh print --subnet <cidr> --bridge <ifname> --api-ip <ip> \
#       [--resolver <ipv4>]… [--subnet6 <cidr>]
#     печатает в stdout фрагмент дампа `iptables-save` (таблица `filter`, цепочки `DOCKER-USER`
#     и `CG-SESSIONS-IN`) и в комментарии — команду перехода из INPUT в CG-SESSIONS-IN (см. шаг
#     3б); сам ничего не применяет. Неверный или неполный набор аргументов — код 2, stdout пуст.
#
# Как применить на новом сервере (владелец, вручную, с sudo — см. раздел в deploy/README.md):
#   1. ./deploy/session-isolation.sh detect <хост>            — узнать подсеть/мост/IP cg-api/DNS;
#   2. ./deploy/session-isolation.sh print <аргументы detect> — посмотреть правила глазами;
#   3. применить:
#      а) цепочки:
#        ssh <хост> './deploy/session-isolation.sh print <аргументы> \
#          | sed "/^# ip6tables/,\$d" | sudo iptables-restore -n'
#        # если detect напечатал --subnet6 — вторая часть вывода (после строки "# ip6tables"):
#        ssh <хост> './deploy/session-isolation.sh print <аргументы> \
#          | sed -n "/^# ip6tables/,\$p" | tail -n +2 | sudo ip6tables-restore -n'
#      б) переход из INPUT — первым правилом, чтобы разрешения хоста (ufw, `--dport 22 -j ACCEPT`
#         и т. п.) не срабатывали раньше; `-C` не даёт ему задвоиться при повторном применении:
#        ssh <хост> 'sudo iptables -C INPUT -i <мост> -j CG-SESSIONS-IN 2>/dev/null \
#          || sudo iptables -I INPUT 1 -i <мост> -j CG-SESSIONS-IN'
#        # и так же `ip6tables`, если есть --subnet6.
#      `-n` (noflush) не трогает остальные таблицы и встроенные цепочки хоста, но объявленная в
#      дампе пользовательская цепочка (`:DOCKER-USER`, `:CG-SESSIONS-IN`) очищается целиком и
#      заполняется заново. Поэтому повторное применение не копит дублей, но СТИРАЕТ любые другие
#      правила в DOCKER-USER: эта цепочка общая для всех сетей docker на хосте — если на сервере
#      появятся свои правила в ней, их нужно дописать в этот дамп руками до применения.
#   4. сохранить после перезагрузки (Debian/Ubuntu, пакет iptables-persistent):
#        sudo apt install iptables-persistent && sudo netfilter-persistent save
#      (или вручную: sudo sh -c 'iptables-save > /etc/iptables/rules.v4' и так же для ip6tables);
#   5. проверить: ./deploy/check-session-isolation.sh <хост> → код 0, все «закрыто» — закрыто.
#
# Если `cg-api` пересоздан с другим IP или сменились DNS-серверы хоста — повторить шаги 1–3
# (цепочки перезапишутся целиком, переход из INPUT останется один).
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Использование:
  deploy/session-isolation.sh detect [ssh-хост=brofrong]
  deploy/session-isolation.sh print --subnet <cidr> --bridge <ifname> --api-ip <ip> \
      [--resolver <ipv4>]... [--subnet6 <cidr>]
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
  local subnet="" bridge="" api_ip="" subnet6="" resolver
  # `${resolvers[@]+…}` ниже — пустой массив под `set -u` в bash < 4.4.
  local -a resolvers=()
  while [ $# -gt 0 ]; do
    case "$1" in
    --subnet | --bridge | --api-ip | --subnet6 | --resolver)
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
    --resolver)
      resolvers+=("$2")
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
  for resolver in ${resolvers[@]+"${resolvers[@]}"}; do
    is_ipv4 "${resolver}" || {
      echo "ОШИБКА: --resolver не похож на IPv4: ${resolver}" >&2
      exit 2
    }
  done

  # DNS хоста: в DOCKER-USER (сервер в сети/LAN) — до DROP частных диапазонов; в CG-SESSIONS-IN
  # (сервер — сам хост) — до DROP. Порядок `-A` в цепочке = порядок проверки.
  local dns_forward="" dns_input="" proto
  for resolver in ${resolvers[@]+"${resolvers[@]}"}; do
    for proto in udp tcp; do
      dns_forward+="-A DOCKER-USER -i ${bridge} -d ${resolver} -p ${proto} --dport 53 -j RETURN"$'\n'
      dns_input+="-A CG-SESSIONS-IN -d ${resolver} -p ${proto} --dport 53 -j ACCEPT"$'\n'
    done
  done

  # Объявление пользовательской цепочки при `*tables-restore -n` очищает её — повторное
  # применение перезаписывает DOCKER-USER и CG-SESSIONS-IN целиком (и стирает чужие правила в
  # DOCKER-USER). Встроенная INPUT в дампе не объявлена и не трогается: переход в CG-SESSIONS-IN
  # ставится отдельной командой с `-C` (в дампе `-I INPUT 1` задваивался бы при каждом повторе).
  cat <<RULES
*filter
:DOCKER-USER - [0:0]
:CG-SESSIONS-IN - [0:0]
-A DOCKER-USER -i ${bridge} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -i ${bridge} -o ${bridge} -s ${api_ip} -p tcp --dport 8080 -j RETURN
-A DOCKER-USER -i ${bridge} -o ${bridge} -j DROP
${dns_forward}-A DOCKER-USER -i ${bridge} -d 10.0.0.0/8 -j DROP
-A DOCKER-USER -i ${bridge} -d 172.16.0.0/12 -j DROP
-A DOCKER-USER -i ${bridge} -d 192.168.0.0/16 -j DROP
-A DOCKER-USER -i ${bridge} -d 169.254.0.0/16 -j DROP
-A DOCKER-USER -i ${bridge} -d 100.64.0.0/10 -j DROP
-A CG-SESSIONS-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
${dns_input}-A CG-SESSIONS-IN -j DROP
COMMIT
# Затем переход из INPUT первым правилом (не задваивается при повторе):
#   iptables -C INPUT -i ${bridge} -j CG-SESSIONS-IN 2>/dev/null || iptables -I INPUT 1 -i ${bridge} -j CG-SESSIONS-IN
RULES

  if [ -n "${subnet6}" ]; then
    # Без отдельного IPv6-адреса cg-api (--api-ip — только IPv4, см. детект): бридж-бридж по v6
    # закрыт целиком — cg-api -> сессии ходит по v4, это не хуже, чем изоляция, которую просят.
    # DNS-серверы — только IPv4 (`--resolver`), по v6 исключений нет.
    cat <<RULES6
# ip6tables
*filter
:DOCKER-USER - [0:0]
:CG-SESSIONS-IN - [0:0]
-A DOCKER-USER -i ${bridge} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -i ${bridge} -o ${bridge} -j DROP
-A DOCKER-USER -i ${bridge} -d fc00::/7 -j DROP
-A DOCKER-USER -i ${bridge} -d fe80::/10 -j DROP
-A CG-SESSIONS-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A CG-SESSIONS-IN -j DROP
COMMIT
# Затем переход из INPUT первым правилом (не задваивается при повторе):
#   ip6tables -C INPUT -i ${bridge} -j CG-SESSIONS-IN 2>/dev/null || ip6tables -I INPUT 1 -i ${bridge} -j CG-SESSIONS-IN
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
# DNS-серверы хоста, которые Docker отдаёт встроенному резолверу (systemd-resolved — его
# настоящие серверы, а не заглушка 127.0.0.53). Одной строкой через пробел, может быть пустой.
conf=/etc/resolv.conf
[ -r /run/systemd/resolve/resolv.conf ] && conf=/run/systemd/resolve/resolv.conf
awk '$1 == "nameserver" { printf "%s ", $2 }' "${conf}"
echo
REMOTE
  )"

  net_line="$(printf '%s\n' "${out}" | sed -n '1p')"
  api_ip="$(printf '%s\n' "${out}" | sed -n '2p')"
  local resolver_line resolver resolver_args=""
  resolver_line="$(printf '%s\n' "${out}" | sed -n '3p')"
  for resolver in ${resolver_line}; do
    case "${resolver}" in
    127.* | ::1) continue ;; # loopback Docker спрашивает из сети хоста — правило не нужно
    esac
    if is_ipv4 "${resolver}"; then
      resolver_args+=" --resolver ${resolver}"
    else
      echo "ПРЕДУПРЕЖДЕНИЕ: DNS-сервер ${resolver} не IPv4 — исключения для него нет" >&2
    fi
  done
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

  printf -- '--subnet %s --bridge %s --api-ip %s%s' "${subnet}" "${bridge}" "${api_ip}" \
    "${resolver_args}"
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
