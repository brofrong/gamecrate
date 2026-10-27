#!/usr/bin/env bash
# Замер запуска уже установленной игры на воркере (по умолчанию brofrong): от вставки строки
# `sessions` (`queued`) — как нажатие «Играть» — до `play_segments.started_at` (`Game started`).
#
#   ./deploy/measure-session-start.sh <userId> <appId> [запусков=3] [ssh-хост]
#
# 1. Перед каждым запуском — отказ, если на воркере есть созданные или запущенные контейнеры
#    cg.session/cg.install (остановленные `profile-unsaved` не мешают) или у пользователя есть
#    активная сессия: замер — только на свободном слоте и без установок.
# 2. Вставляет `sessions(id, user_id, app_id, state='queued')` (id — uuid из /proc) и каждые
#    0,5 с отмечает первое появление: `container` — контейнер сессии запущен, `steam-ui` — есть
#    logs/steamui_login.txt клиента Steam, `game` — строка `play_segments` этой сессии. Таймаут —
#    10 мин.
# 3. На `game`: копирует из контейнера logs/{steamui_login,webhelper,client_networkmanager}.txt
#    во временный каталог и печатает переходы входа (`SetLoginState`, `Timed out`) и время первой
#    строки webhelper. Имени аккаунта и токена в этих строках нет.
# 4. Останавливает сессию как сайт (`stop_requested_at = now()`), ждёт `ended`/`failed` и
#    исчезновения контейнера (до 5 мин), удаляет временный каталог.
# В конце — таблица в секундах от вставки строки и медиана `game`.
#
# Пишет в БД только строки `sessions` пользователя: каждая станет обычной завершённой сессией и
# попадёт в его историю (игровое время — несколько секунд). `.env` не читает; чужие контейнеры,
# тома и образы не трогает. Отказ, таймаут или `failed` — ненулевой код (сессия при этом тоже
# останавливается).
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <userId> <appId> [runs=3] [ssh-host=brofrong]" >&2
  exit 2
fi
USER_ID="$1"
APP_ID="$2"
RUNS="${3:-3}"
REMOTE_HOST="${4:-brofrong}"
# Значения уходят в SQL: только безопасные символы.
[[ "${USER_ID}" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad userId" >&2; exit 2; }
[[ "${APP_ID}" =~ ^[0-9]+$ ]] || { echo "bad appId" >&2; exit 2; }
[[ "${RUNS}" =~ ^[1-9][0-9]*$ ]] || { echo "bad runs" >&2; exit 2; }

ssh "${REMOTE_HOST}" bash -s -- "${USER_ID}" "${APP_ID}" "${RUNS}" <<'REMOTE'
set -euo pipefail
user_id="$1"
app_id="$2"
runs="$3"
steam_logs=/home/ubuntu/.local/share/Steam/logs
start_timeout_ms=600000
stop_timeout_ms=300000

sql() { docker exec cg-postgres psql -U cg -d cloud_gaming -v ON_ERROR_STOP=1 -Atqc "$1"; }
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
# Миллисекунды → секунды с одним знаком.
sec() { awk -v ms="$1" 'BEGIN { if (ms == "") print "-"; else printf "%.1f", ms / 1000 }'; }

busy() {
  for l in cg.session cg.install; do
    docker ps -a --filter "label=${l}" --filter status=created --filter status=running \
      --filter status=restarting --filter status=paused --format "{{.Names}} ({{.State}}, ${l})"
  done
  sql "select 'session ' || id || ' (' || state || ')' from sessions
       where user_id = '${user_id}' and state not in ('ended', 'failed')"
}

tmp="$(mktemp -d)"
sid=""
stop_session() {
  [ -n "${sid}" ] || return 0
  sql "update sessions set stop_requested_at = now()
       where id = '${sid}' and stop_requested_at is null" >/dev/null
  local t0 state
  t0="$(now_ms)"
  while :; do
    state="$(sql "select state from sessions where id = '${sid}'")"
    if { [ "${state}" = ended ] || [ "${state}" = failed ]; } &&
      ! docker inspect "cg-session-${sid}" >/dev/null 2>&1; then
      break
    fi
    if [ $(( $(now_ms) - t0 )) -gt "${stop_timeout_ms}" ]; then
      echo "ОШИБКА: сессия ${sid} не остановилась за 5 мин (state=${state})" >&2
      return 1
    fi
    sleep 1
  done
  sid=""
}
trap 'stop_session || true; rm -rf "${tmp}"' EXIT

results=()
for run in $(seq 1 "${runs}"); do
  b="$(busy)"
  if [ -n "${b}" ]; then
    echo "ОШИБКА: слот или пользователь заняты:" >&2
    printf '%s\n' "${b}" | sed 's/^/  /' >&2
    exit 1
  fi
  sid="$(cat /proc/sys/kernel/random/uuid)"
  name="cg-session-${sid}"
  t0="$(now_ms)"
  sql "insert into sessions (id, user_id, app_id, state)
       values ('${sid}', '${user_id}', ${app_id}, 'queued')" >/dev/null
  t_container="" t_ui="" t_game=""
  while [ -z "${t_game}" ]; do
    t="$(( $(now_ms) - t0 ))"
    if [ "$(docker inspect -f '{{.State.Running}}' "${name}" 2>/dev/null)" = true ]; then
      [ -n "${t_container}" ] || t_container="${t}"
      if [ -z "${t_ui}" ] && docker exec "${name}" test -s "${steam_logs}/steamui_login.txt" 2>/dev/null; then
        t_ui="${t}"
      fi
    fi
    if [ -n "$(sql "select 1 from play_segments where session_id = '${sid}' limit 1")" ]; then
      t_game="${t}"
      break
    fi
    state="$(sql "select state from sessions where id = '${sid}'")"
    if [ "${state}" = failed ] || [ "${state}" = ended ]; then
      echo "ОШИБКА: запуск ${run}: сессия ${sid} — ${state}: $(sql "select coalesce(fail_reason, '') from sessions where id = '${sid}'")" >&2
      exit 1
    fi
    if [ "${t}" -gt "${start_timeout_ms}" ]; then
      echo "ОШИБКА: запуск ${run}: игра не запустилась за 10 мин (state=${state})" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "== запуск ${run}: сессия ${sid}"
  for f in steamui_login webhelper client_networkmanager; do
    docker cp "${name}:${steam_logs}/${f}.txt" "${tmp}/${f}.txt" >/dev/null 2>&1 || true
  done
  if [ -f "${tmp}/steamui_login.txt" ]; then
    grep -E 'SetLoginState|Timed out' "${tmp}/steamui_login.txt" | sed 's/^/  /' || true
  fi
  if [ -f "${tmp}/webhelper.txt" ]; then
    echo "  webhelper: первая строка $(grep -oE '^\[[^]]*\]' "${tmp}/webhelper.txt" | head -n 1 || true)"
  fi
  rm -f "${tmp}"/*.txt
  results+=("${run} $(sec "${t_container}") $(sec "${t_ui}") $(sec "${t_game}")")
  stop_session
done

echo
printf '%-4s %10s %9s %6s\n' run container steam-ui game
printf '%s\n' "${results[@]}" | awk '{ printf "%-4s %10s %9s %6s\n", $1, $2, $3, $4 }'
printf '%s\n' "${results[@]}" | awk '{ print $4 }' | sort -n |
  awk '{ v[NR] = $1 } END { m = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2; printf "медиана game: %.1f с\n", m }'
REMOTE
