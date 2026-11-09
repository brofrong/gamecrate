#!/usr/bin/env bash
# Сборка пакета своей игры (games/<slug>) на воркере (по умолчанию brofrong).
#
#   ./deploy/add-game.sh <slug> [--host <ssh-хост>] [--input <name>=<путь>]... [--rebuild]
#
# Результат — пакет <GAMES_DIR>/<slug>/<version>/ на хосте (GAMES_DIR = <CG_DATA_DIR>/games, как
# у cg-agent в compose.worker.yaml/compose.stand.yaml): исполняемый run и бинарник игры (поля version и binary из
# games/<slug>/game.json). Агент видит пакет после деплоя, игрокам игру открывает админка.
#
# 1. game.json: version, binary, inputs. Каждый inputs[].name — обязательный --input.
# 2. Из серверного ~/cloud-gaming/.env читаются только CG_DATA_DIR и SESSION_IMAGE (несекретные).
# 3. Пакет этой версии уже есть — выход (пересобрать: --rebuild).
# 4. Свой каталог запуска на хосте ~/cg-games-src/<slug>.XXXXXX (mktemp): src/ — rsync
#    games/<slug>/, build.sh, build.log, build.rc. У параллельных запусков общих файлов нет, сама
#    сборка одной игры — по замку ~/cg-games-src/<slug>.lock.
# 5. Сборка на хосте стартует отдельным процессом (setsid nohup) до передачи входных файлов: она
#    создаёт временный каталог входных файлов (mktemp -d, на brofrong /tmp — tmpfs), и её ловушка
#    удаляет его на любом выходе — в том числе если мак пропал посреди передачи (входные файлы не
#    пришли за час — выход). Входные файлы (для SoH — ROM) идут 8 частями параллельно с докачкой и
#    сверкой SHA-256. Мак показывает лог и переподключается после обрыва; Ctrl-C на маке
#    останавливает сборку.
# 6. Сборщик cg-game-builder-<slug>:<version> из builder.Dockerfile (FROM SESSION_IMAGE).
# 7. docker run сборщика: /game — исходники (ro), /input — входные файлы (ro), /out — пустой
#    <slug>/.build-<version> (rw); команда /game/build.sh /input /out. Потом входные файлы
#    удаляются.
# 8. Библиотеки, которых нет в образе сессии (ldd в SESSION_IMAGE), — из сборщика в lib/, не
#    больше 5 проходов.
# 9-10. В пакете есть run и бинарник, нет ROM (*.z64, *.n64, *.v64) и копий входных файлов (тот же
#    размер и SHA-256 под любым именем).
# 11. .build-<version> -> <version> (--rebuild: если на старой версии за время сборки началась
#    сессия — ошибка, старая версия остаётся).
# 12. Старые версии удаляются: остаются новая и предыдущая (по mtime). Версия, на которой идёт
#     сессия (метка cg.own-game), не удаляется и не пересобирается.
#
# Файлов Nintendo (ROM, .o2r) нет в репозитории, в образе сборщика и в git (games/README.md):
# ROM на хосте только во временном каталоге и в /input сборщика (bind, не слой образа).
# Ничего, кроме своих каталогов (~/cg-games-src, <GAMES_DIR>) и образа сборщика, на хосте не
# меняет; sudo не нужен.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="brofrong"
REMOTE_DIR="cloud-gaming"
SRC_DIR="cg-games-src"

usage() {
  echo "usage: $0 <slug> [--host <ssh-хост>] [--input <name>=<путь>]... [--rebuild]" >&2
  exit 2
}

slug=""
rebuild=""
# Входные файлы: имена и пути — параллельные массивы (bash 3.2 на маке, без declare -A).
input_names=()
input_paths=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      [ "$#" -ge 2 ] || usage
      REMOTE_HOST="$2"
      shift 2
      ;;
    --input)
      [ "$#" -ge 2 ] || usage
      case "$2" in
        *=*) ;;
        *) usage ;;
      esac
      input_names+=("${2%%=*}")
      input_paths+=("${2#*=}")
      shift 2
      ;;
    --rebuild)
      rebuild=1
      shift
      ;;
    -*) usage ;;
    *)
      [ -z "${slug}" ] || usage
      slug="$1"
      shift
      ;;
  esac
done
[ -n "${slug}" ] || usage

# Те же правила, что OwnGameSlug/OwnGameVersion в @cg/rpc: значения идут в пути и bind.
if ! [[ "${slug}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "ОШИБКА: slug — строчные буквы, цифры и «-», до 32 символов: '${slug}'" >&2
  exit 1
fi
GAME_DIR="${REPO_ROOT}/games/${slug}"
for f in game.json builder.Dockerfile build.sh; do
  if [ ! -f "${GAME_DIR}/${f}" ]; then
    echo "ОШИБКА: нет games/${slug}/${f}" >&2
    exit 1
  fi
done

echo "==> games/${slug}/game.json"
manifest="$(bun -e '
const m = await Bun.file(process.argv[1]).json();
console.log(m.version ?? "");
console.log(m.binary ?? "");
for (const i of m.inputs ?? []) console.log(i.name);
' "${GAME_DIR}/game.json")"
version="$(printf '%s\n' "${manifest}" | sed -n 1p)"
binary="$(printf '%s\n' "${manifest}" | sed -n 2p)"
need_inputs="$(printf '%s\n' "${manifest}" | sed -n '3,$p')"
if ! [[ "${version}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "ОШИБКА: version в game.json — буквы, цифры, «.», «_», «-»: '${version}'" >&2
  exit 1
fi
if [ -z "${binary}" ] || [[ "${binary}" == */* ]]; then
  echo "ОШИБКА: binary в game.json — имя файла без «/»: '${binary}'" >&2
  exit 1
fi
echo "    версия ${version}, бинарник ${binary}"

# has_input <name> — передан ли --input с этим именем.
has_input() {
  local n
  for n in ${input_names[@]+"${input_names[@]}"}; do
    [ "${n}" = "$1" ] && return 0
  done
  return 1
}
missing=""
for n in ${need_inputs}; do
  if ! [[ "${n}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
    echo "ОШИБКА: inputs[].name в game.json — как slug: '${n}'" >&2
    exit 1
  fi
  has_input "${n}" || missing="${missing} ${n}"
done
if [ -n "${missing}" ]; then
  echo "ОШИБКА: не хватает входных файлов:${missing}" >&2
  echo "Передайте каждый: --input <name>=<путь> (список — inputs в games/${slug}/game.json)." >&2
  exit 1
fi
seen=" "
for i in ${input_names[@]+"${!input_names[@]}"}; do
  n="${input_names[$i]}"
  if ! printf '%s\n' ${need_inputs} | grep -qx -- "${n}"; then
    echo "ОШИБКА: --input ${n}: такого входа нет в inputs games/${slug}/game.json" >&2
    exit 1
  fi
  case "${seen}" in
    *" ${n} "*)
      echo "ОШИБКА: --input ${n} передан дважды" >&2
      exit 1
      ;;
  esac
  seen="${seen}${n} "
  if [ ! -f "${input_paths[$i]}" ]; then
    echo "ОШИБКА: --input ${n}: нет файла ${input_paths[$i]}" >&2
    exit 1
  fi
done

echo "==> ${REMOTE_HOST}: CG_DATA_DIR и SESSION_IMAGE из ~/${REMOTE_DIR}/.env"
# Только эти два несекретных значения, остальные строки .env не читаются и не выводятся (как
# каталоги в deploy-stand.sh). Нет .env или ключа — умолчания стенда (compose.stand.yaml).
remote_env="$(ssh "${REMOTE_HOST}" bash -s -- "${REMOTE_DIR}" <<'REMOTE'
set -euo pipefail
envval() { local v=""; [ -f ~/"$1"/.env ] && v="$(sed -n "s/^$2=//p" ~/"$1"/.env | tail -n 1)"; printf '%s\n' "${v:-$3}"; }
envval "$1" CG_DATA_DIR /raid/cloud-gaming
envval "$1" SESSION_IMAGE cg-session:550.163.01
REMOTE
)"
games_dir="$(printf '%s\n' "${remote_env}" | sed -n 1p)/games"
session_image="$(printf '%s\n' "${remote_env}" | sed -n 2p)"
echo "    GAMES_DIR=${games_dir}, SESSION_IMAGE=${session_image}"

if [ -z "${rebuild}" ] &&
  ssh "${REMOTE_HOST}" "test -d '${games_dir}/${slug}/${version}'"; then
  echo "==> пакет ${games_dir}/${slug}/${version} уже есть на ${REMOTE_HOST} — пересобрать: --rebuild"
  exit 0
fi

# Размер и SHA-256 каждого входного файла: сверка после передачи и поиск копий входа в пакете
# (ROM без расширения, /input/rom, расширением не поймать).
input_specs=()
for i in ${input_names[@]+"${!input_names[@]}"}; do
  input_specs+=("$(wc -c <"${input_paths[$i]}" | tr -d ' '):$(shasum -a 256 "${input_paths[$i]}" | cut -d ' ' -f 1)")
done

run_dir=""
input_dir=""
build_pid=""
local_log=""
# Ctrl-C или ошибка на маке: остановить свою сборку на хосте (её ловушка удалит входные файлы,
# контейнер и .build) и удалить временный каталог входных файлов. Не удалось (связь пропала) —
# сказать, что удалить руками: там может лежать ROM. Обрыв связи сам сборку не останавливает:
# входные файлы она удалит сама, даже если они так и не пришли (ждёт их не дольше часа).
cleanup_inputs() {
  local j
  # Части файла, которые ещё передаются (send_part &), — вместе с их ssh.
  for j in $(jobs -p); do
    pkill -P "${j}" 2>/dev/null || true
    kill "${j}" 2>/dev/null || true
  done
  [ -z "${local_log}" ] || rm -f "${local_log}"
  if [ -n "${build_pid}" ]; then
    ssh "${REMOTE_HOST}" "kill -TERM -- -${build_pid} 2>/dev/null; for i in \$(seq 60); do kill -0 ${build_pid} 2>/dev/null || break; sleep 1; done" ||
      echo "ВНИМАНИЕ: не удалось остановить сборку на ${REMOTE_HOST} (pid ${build_pid})" >&2
  fi
  if [ -n "${input_dir}" ]; then
    if ssh "${REMOTE_HOST}" "rm -rf '${input_dir}'"; then
      echo "==> удалён ${REMOTE_HOST}:${input_dir}"
    else
      echo "ВНИМАНИЕ: не удалось удалить ${REMOTE_HOST}:${input_dir} — удалите вручную:" >&2
      echo "  ssh ${REMOTE_HOST} rm -rf '${input_dir}'" >&2
    fi
  fi
}
trap cleanup_inputs EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
local_log="$(mktemp -t cg-add-game)"

run_dir="$(ssh "${REMOTE_HOST}" "mkdir -p ~/${SRC_DIR} && mktemp -d ~/${SRC_DIR}/${slug}.XXXXXX")"
if ! [[ "${run_dir}" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "ОШИБКА: mktemp -d на ${REMOTE_HOST} вернул странный путь: '${run_dir}'" >&2
  exit 1
fi
echo "==> rsync games/${slug} -> ${REMOTE_HOST}:${run_dir}/src"
# Файлы Nintendo (если лежат в рабочей копии) на хост не едут: в /game сборщика их быть не должно.
rsync -az --delete --exclude ".DS_Store" \
  --exclude "*.z64" --exclude "*.n64" --exclude "*.v64" --exclude "*.o2r" --exclude "roms/" \
  "${GAME_DIR}/" "${REMOTE_HOST}:${run_dir}/src/"

# Канал с мака до brofrong бывает 5–20 КиБ/с на одно соединение и рвётся каждые 10–20 минут: scp
# ROM 32 МиБ падал по таймауту, rsync (openrsync на маке) после обрыва передавал файл заново, а
# одним потоком с докачкой ROM шёл около двух часов. Поэтому файл идёт 8 частями параллельно
# (скорость складывается), каждая — с докачкой; на хосте части склеиваются, в конце — сверка
# SHA-256.
PARTS=8
# send_part <файл> <смещение> <длина> <путь части на хосте> — одна часть с докачкой: каждая
# попытка дописывает хвост части с того размера, что уже на хосте.
send_part() {
  local src="$1" off="$2" len="$3" dst="$4" have attempt
  # head закрывает канал раньше tail — без pipefail код конвейера — код ssh.
  set +o pipefail
  for attempt in $(seq 1 30); do
    have="$(ssh "${REMOTE_HOST}" "stat -c %s '${dst}' 2>/dev/null || echo 0")" || have=""
    if [ -n "${have}" ]; then
      [ "${have}" -lt "${len}" ] || return 0
      if tail -c +"$((off + have + 1))" "${src}" 2>/dev/null | head -c "$((len - have))" |
        ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "${REMOTE_HOST}" "cat >> '${dst}'"; then
        continue
      fi
    fi
    sleep 5
  done
  echo "ОШИБКА: часть ${dst##*/} не передана за 30 попыток" >&2
  return 1
}
# send_file <локальный файл> <путь на хосте> <SHA-256 файла>
send_file() {
  local src="$1" dst="$2" sum_local="$3" size chunk k pids="" pid failed="" parts="" sum_remote
  size="$(wc -c <"${src}" | tr -d ' ')"
  chunk="$(((size + PARTS - 1) / PARTS))"
  for k in $(seq 0 $((PARTS - 1))); do
    [ "$((k * chunk))" -lt "${size}" ] || break
    len="${chunk}"
    [ "$((k * chunk + len))" -le "${size}" ] || len="$((size - k * chunk))"
    send_part "${src}" "$((k * chunk))" "${len}" "${dst}.part${k}" &
    pids="${pids} $!"
    parts="${parts} '${dst}.part${k}'"
  done
  for pid in ${pids}; do
    wait "${pid}" || failed=1
  done
  [ -z "${failed}" ] || return 1
  sum_remote="$(ssh "${REMOTE_HOST}" "cat ${parts} > '${dst}' && rm -f ${parts} && sha256sum '${dst}'" |
    cut -d ' ' -f 1)" || true
  if [ "${sum_local}" != "${sum_remote}" ]; then
    echo "ОШИБКА: ${dst} на ${REMOTE_HOST} не совпал с ${src} (SHA-256) — передача не удалась" >&2
    return 1
  fi
}

# Скрипт сборки на хосте: ждёт входные файлы, сборщик, пакет, библиотеки, проверки, старые
# версии. Запускается в своей сессии (setsid nohup) — обрыв ssh его не убивает; мак читает лог и
# переподключается.
#   build.sh <slug> <version> <binary> <games_dir> <session_image> <input_dir> <run_dir> <размер:sha256>...
ssh "${REMOTE_HOST}" "cat > '${run_dir}/build.sh'" <<'REMOTE'
set -euo pipefail
slug="$1"
version="$2"
binary="$3"
games_dir="$4"
session_image="$5"
input_dir="$6"
run_dir="$7"
shift 7
# Размер и SHA-256 входных файлов: копии входа в пакете быть не должно.
input_specs=("$@")
src="${run_dir}/src"
lock="${run_dir%/*}/${slug}.lock"
builder="cg-game-builder-${slug}:${version}"
container="cg-game-build-${slug}"
pkg_root="${games_dir}/${slug}"
out="${pkg_root}/.build-${version}"
# Сколько ждать входные файлы с мака, с (ADD_GAME_READY_TIMEOUT на маке — для проверки обрыва).
READY_TIMEOUT="${READY_TIMEOUT:-3600}"
locked=""
done_pkg=""

# Второй рубеж к ловушке на маке: входные файлы и недособранный пакет удаляются и здесь, даже если
# связь с маком пропала. Сигналы превращаем в exit, чтобы сработал EXIT. Контейнер и .build —
# только свои (после замка): чужую идущую сборку не трогаем. Код выхода — в build.rc для мака.
cleanup() {
  local rc=$?
  rm -rf "${input_dir}"
  if [ -n "${locked}" ]; then
    docker rm -f "${container}" >/dev/null 2>&1 || true
    if [ -z "${done_pkg}" ]; then
      rm -rf "${out}"
    fi
  fi
  echo "${rc}" >"${run_dir}/build.rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# in_use <version> — на этой версии пакета идёт сессия: контейнер с меткой cg.own-game создан или
# запущен (как проверка занятости в deploy-stand.sh; остановленные не мешают).
in_use() {
  [ -n "$(docker ps -aq --filter "label=cg.own-game=${slug}/$1" --filter status=created \
    --filter status=running --filter status=restarting --filter status=paused)" ]
}

mkdir -p "${pkg_root}"
if [ "$(stat -c %u "${games_dir}")" != 1000 ]; then
  echo "ОШИБКА: владелец ${games_dir} — не uid 1000 ($(stat -c %U "${games_dir}")); исправить вручную." >&2
  exit 1
fi
# Одна сборка игры за раз: вторая затёрла бы .build-<version> и контейнер первой. Замок — рядом с
# каталогами запусков, не в GAMES_DIR (там только пакеты).
exec 9>"${lock}"
if ! flock -n 9; then
  echo "ОШИБКА: ${slug} уже собирается (занят ${lock})" >&2
  exit 1
fi
locked=1
# Каталоги прошлых запусков этой игры (лог неудачных остаётся для разбора) — старше суток.
find "${run_dir%/*}" -mindepth 1 -maxdepth 1 -type d -name "${slug}.*" ! -path "${run_dir}" \
  -mtime +1 -exec rm -rf {} +
if [ -d "${pkg_root}/${version}" ] && in_use "${version}"; then
  echo "ОШИБКА: на пакете ${slug}/${version} идёт сессия — дождитесь её окончания." >&2
  exit 1
fi

# Мак передаёт входные файлы, когда видит waiting, и сообщает об окончании файлом ready.
touch "${run_dir}/waiting"
echo "==> ждём входные файлы (не дольше ${READY_TIMEOUT} с)"
for _ in $(seq "${READY_TIMEOUT}"); do
  [ ! -f "${run_dir}/ready" ] || break
  sleep 1
done
if [ ! -f "${run_dir}/ready" ]; then
  echo "ОШИБКА: входные файлы не пришли за ${READY_TIMEOUT} с — удалены" >&2
  exit 1
fi

echo "==> docker build ${builder}"
docker build --build-arg SESSION_IMAGE="${session_image}" -f "${src}/builder.Dockerfile" \
  -t "${builder}" "${src}"

echo "==> сборка ${slug} ${version} -> ${out}"
rm -rf "${out}"
mkdir -p "${out}"
# --init: сигнал (связь с маком пропала, Ctrl-C) доходит до build.sh, и его ловушка убирает копию
# ROM в дереве сборки. Дерево сборки — во временном каталоге контейнера, уходит вместе с --rm.
# --no-healthcheck: проверка Selkies из образа сессии сборщику не нужна.
docker run --rm --init --no-healthcheck --name "${container}" --user 1000:1000 \
  -v "${src}:/game:ro" -v "${input_dir}:/input:ro" -v "${out}:/out" \
  "${builder}" /game/build.sh /input /out
# Входные файлы больше не нужны — не ждём конца скрипта.
rm -rf "${input_dir}"

echo "==> библиотеки, которых нет в ${session_image}"
# not_found — чего не находит ldd бинарника в образе сессии (с уже собранным lib/ пакета).
not_found() {
  docker run --rm --user 1000:1000 --entrypoint bash -v "${out}:/opt/cg-game:ro" "${session_image}" \
    -c 'LD_LIBRARY_PATH=/opt/cg-game/lib ldd "/opt/cg-game/$1" | awk "/not found/ { print \$1 }" | sort -u' \
    _ "${binary}"
}
libs_ok=""
for pass in 1 2 3 4 5 6; do
  missing="$(not_found)"
  if [ -z "${missing}" ]; then
    libs_ok=1
    break
  fi
  [ "${pass}" -le 5 ] || break
  echo "    проход ${pass}:" ${missing}
  # shellcheck disable=SC2086 # список имён библиотек — отдельными аргументами
  docker run --rm --user 1000:1000 -v "${out}:/out" "${builder}" bash -c '
    set -euo pipefail
    mkdir -p /out/lib
    for so in "$@"; do
      # Первое совпадение — флагом, без exit: awk, вышедший раньше, оборвал бы пайп, и ldconfig
      # с длинным выводом упал бы от SIGPIPE (141) — при pipefail молча обрывая скрипт.
      p="$(ldconfig -p | awk -v n="${so}" "!found && \$1 == n && /x86-64/ { found = 1; print \$NF }")"
      if [ -z "${p}" ]; then
        echo "ОШИБКА: ${so} нет и в сборщике" >&2
        exit 1
      fi
      cp -L "${p}" /out/lib/
    done
  ' _ ${missing}
done
if [ -z "${libs_ok}" ]; then
  echo "ОШИБКА: после 5 проходов ldd всё ещё не находит:" ${missing} >&2
  exit 1
fi
if [ -d "${out}/lib" ]; then
  echo "    lib/: $(ls "${out}/lib" | tr '\n' ' ')"
fi

test -x "${out}/run" || { echo "ОШИБКА: в пакете нет исполняемого run" >&2; exit 1; }
test -f "${out}/${binary}" || { echo "ОШИБКА: в пакете нет ${binary}" >&2; exit 1; }
roms="$(find "${out}" -iname '*.z64' -o -iname '*.n64' -o -iname '*.v64')"
# Копия входного файла под любым именем: тот же размер и SHA-256.
for spec in ${input_specs[@]+"${input_specs[@]}"}; do
  while IFS= read -r f; do
    if [ "$(sha256sum "${f}" | cut -d ' ' -f 1)" = "${spec#*:}" ]; then
      roms="${roms:+${roms}
}${f}"
    fi
  done < <(find "${out}" -type f -size "${spec%%:*}c")
done
if [ -n "${roms}" ]; then
  echo "ОШИБКА: в пакете ROM или копия входного файла — пакет удалён:" >&2
  printf '%s\n' "${roms}" | sed 's/^/  /' >&2
  exit 1
fi

echo "==> ${pkg_root}/${version}"
# --rebuild: сборка шла минуты — за это время на старой версии могла начаться сессия.
if [ -d "${pkg_root}/${version}" ] && in_use "${version}"; then
  echo "ОШИБКА: на пакете ${slug}/${version} началась сессия — старая версия оставлена, новая удалена." >&2
  exit 1
fi
rm -rf "${pkg_root:?}/${version}"
mv "${out}" "${pkg_root}/${version}"
touch "${pkg_root}/${version}"
done_pkg=1
du -sh "${pkg_root}/${version}"
ls -la "${pkg_root}/${version}"

# Остаются новая и самая свежая из прочих (по mtime); версии под живой сессией не трогаем.
prev=""
for v in $(ls -1t "${pkg_root}"); do
  [ "${v}" != "${version}" ] || continue
  if [ -z "${prev}" ]; then
    prev="${v}"
    continue
  fi
  if in_use "${v}"; then
    echo "    ${v}: идёт сессия — не удаляем"
    continue
  fi
  echo "==> удаляем старую версию ${pkg_root}/${v}"
  rm -rf "${pkg_root:?}/${v}"
done
REMOTE

# Сборка стартует до передачи: каталог входных файлов создаёт и удаляет она (см. шаг 5).
ready_timeout="${ADD_GAME_READY_TIMEOUT:-3600}"
[[ "${ready_timeout}" =~ ^[0-9]+$ ]] || { echo "ОШИБКА: ADD_GAME_READY_TIMEOUT — число секунд" >&2; exit 1; }
launch="$(ssh "${REMOTE_HOST}" "cd ~ || exit 1; d=\$(mktemp -d) || exit 1; READY_TIMEOUT=${ready_timeout} setsid nohup bash '${run_dir}/build.sh' \
  '${slug}' '${version}' '${binary}' '${games_dir}' '${session_image}' \"\$d\" '${run_dir}' \
  ${input_specs[*]+${input_specs[*]}} >'${run_dir}/build.log' 2>&1 </dev/null & echo \"\$! \$d\"")"
build_pid="${launch%% *}"
input_dir="${launch#* }"
if ! [[ "${build_pid}" =~ ^[0-9]+$ ]] || ! [[ "${input_dir}" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "ОШИБКА: сборка на ${REMOTE_HOST} не запустилась: '${launch}'" >&2
  build_pid=""
  input_dir=""
  exit 1
fi
echo "==> сборка на ${REMOTE_HOST} (pid ${build_pid}, лог ${run_dir}/build.log)"
# Сборка взяла замок и ждёт входные файлы (waiting) — или уже вышла (build.rc: занято, идёт сессия).
state="$(ssh "${REMOTE_HOST}" "for i in \$(seq 120); do [ -f '${run_dir}/waiting' ] && { echo waiting; exit; }; [ -f '${run_dir}/build.rc' ] && { echo done; exit; }; sleep 1; done; echo timeout")"
if [ "${state}" != waiting ]; then
  ssh "${REMOTE_HOST}" "cat '${run_dir}/build.log'" >&2 || true
  echo "ОШИБКА: сборка на ${REMOTE_HOST} не дошла до приёма входных файлов (${state})" >&2
  exit 1
fi
for i in ${input_names[@]+"${!input_names[@]}"}; do
  echo "==> --input ${input_names[$i]} -> ${REMOTE_HOST}:${input_dir}/${input_names[$i]} (${PARTS} частей)"
  send_file "${input_paths[$i]}" "${input_dir}/${input_names[$i]}" "${input_specs[$i]#*:}"
done
sent=""
for attempt in 1 2 3 4 5; do
  if ssh "${REMOTE_HOST}" "touch '${run_dir}/ready'"; then
    sent=1
    break
  fi
  sleep 5
done
[ -n "${sent}" ] || { echo "ОШИБКА: не удалось сообщить сборке на ${REMOTE_HOST}, что файлы переданы" >&2; exit 1; }

# Лог — с того байта, что уже показан (копия на маке, local_log); tail --pid выходит, когда сборка
# закончилась.
followed=""
for attempt in $(seq 1 60); do
  shown="$(wc -c <"${local_log}" | tr -d ' ')"
  if ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "${REMOTE_HOST}" \
    "tail -c +$((shown + 1)) --pid=${build_pid} -f '${run_dir}/build.log'" | tee -a "${local_log}"; then
    followed=1
    break
  fi
  echo "    связь оборвалась, переподключаемся (${attempt}/60)" >&2
  sleep 10
done
if [ -z "${followed}" ]; then
  echo "ОШИБКА: связь с ${REMOTE_HOST} потеряна, сборка (pid ${build_pid}) продолжается там:" >&2
  echo "  ssh ${REMOTE_HOST} tail -f ${run_dir}/build.log" >&2
  # Сборку не останавливаем (ловушка не тронет): входные файлы она удалит сама.
  build_pid=""
  input_dir=""
  exit 1
fi
build_pid=""
rc="$(ssh "${REMOTE_HOST}" "cat '${run_dir}/build.rc' 2>/dev/null" || true)"
if [ "${rc}" != 0 ]; then
  echo "ОШИБКА: сборка на ${REMOTE_HOST} завершилась с кодом ${rc:-?} (лог: ${run_dir}/build.log)" >&2
  exit 1
fi
# Удачный запуск — каталог запуска не нужен (неудачный остаётся с логом, его уберёт следующая сборка
# через сутки).
ssh "${REMOTE_HOST}" "rm -rf '${run_dir}'" || true

echo "==> Пакет готов. Дальше: деплой (каталог игр), затем в админке «Открыта игрокам»."
