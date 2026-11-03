#!/bin/bash
# build.sh <input-dir> <out-dir> — сборка пакета Ship of Harkinian внутри сборщика
# (builder.Dockerfile). Контракт deploy/add-game.sh: каталог этого скрипта — games/soh (/game, ro),
# <input-dir> — входные файлы (/input, ro; нужен <input-dir>/rom — ROM Ocarina of Time),
# <out-dir> — пустой каталог пакета (/out, rw).
#
# Результат в <out-dir>: soh.elf, soh.o2r, oot.o2r (активы из ROM — Nintendo, в git и образы не
# попадают), gamecontrollerdb.txt, пустой assets/, run, shipofharkinian.json. Библиотеки, которых
# нет в образе сессии (lib/), докладывает add-game.sh после сборки.
# Нужна сеть: git clone, FetchContent зависимостей libultraship, gamecontrollerdb.txt (CMake
# скачивает его с master SDL_GameControllerDB при configure).
#
# Дерево сборки — во временном каталоге (SOH_WORK — свой каталог, например чтобы не собирать
# заново при отладке). ROM копируется в дерево сборки (roms/), и это дерево удаляется на выходе,
# если оно временное.
set -euo pipefail

SOH_REPO="${SOH_REPO:-https://github.com/HarbourMasters/Shipwright}"
SOH_REF="${SOH_REF:-9.3.1}"

if [ "$#" -ne 2 ]; then
  echo "usage: build.sh <input-dir> <out-dir>" >&2
  exit 2
fi
input_dir="$1"
out_dir="$2"
game_dir="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "${input_dir}/rom" ]; then
  echo "[soh-build] no ROM: ${input_dir}/rom" >&2
  exit 1
fi
mkdir -p "${out_dir}"

if [ -n "${SOH_WORK:-}" ]; then
  work="${SOH_WORK}"
  mkdir -p "${work}"
  temp_work=""
else
  work="$(mktemp -d)"
  temp_work="${work}"
fi
src="${work}/Shipwright"
# Копия ROM в дереве сборки удаляется на любом выходе, в том числе при ошибке извлечения.
cleanup() {
  rm -rf "${src}/roms"
  if [ -n "${temp_work}" ]; then
    rm -rf "${temp_work}"
  fi
}
trap cleanup EXIT

if [ ! -d "${src}/.git" ]; then
  git clone --depth 1 --recursive --shallow-submodules --branch "${SOH_REF}" "${SOH_REPO}" "${src}"
fi
cd "${src}"

# Поломка upstream (9.3.0, 9.3.1 и develop на 2026-11-03, после #7301): консольный извлекатель
# soh-torch (цель ExtractAssets) передаёт в SohTorch::Extract путь к ROM, а функция с #7301
# принимает байты ROM — main.cpp не компилируется. Подменяем вызов чтением файла в вектор. Сама
# игра этот файл не использует (у неё своё извлечение в Extract.cpp), на soh.elf правка не влияет.
python3 - soh/assets/tools/torch-cli/main.cpp <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
call = "SohTorch::Extract(rom, src, dest, version, nullptr)"
fixed = ("SohTorch::Extract([&] { std::ifstream f(rom, std::ios::binary); "
         "return std::vector<uint8_t>(std::istreambuf_iterator<char>(f), {}); }(), "
         "src, dest, version, nullptr)")
if call in src:
    src = src.replace(call, fixed).replace("#include <filesystem>\n", "#include <filesystem>\n#include <fstream>\n#include <iterator>\n", 1)
    open(path, "w").write(src)
elif fixed not in src:
    sys.exit("torch-cli/main.cpp: unexpected Extract call, patch needs an update")
PY

cmake -H. -Bbuild-cmake -GNinja -DCMAKE_BUILD_TYPE=Release
cmake --build build-cmake --target soh GenerateSohOtr

# Torch знает только хеши ROM в порядке байт .z64 (big-endian) и называет архив по хешу
# (oot.o2r или oot-mq.o2r); имя файла в roms/ не важно. Дампы .v64 (слова по 16 бит
# переставлены) и .n64 (little-endian по 32 бита) приводим к .z64 по первым 4 байтам.
# ROM только в дереве сборки и удаляется сразу после извлечения.
rm -rf roms
mkdir -p roms
python3 - "${input_dir}/rom" roms/oot.z64 <<'PY'
import sys
data = open(sys.argv[1], "rb").read()
magic = data[:4]
if magic == b"\x80\x37\x12\x40":
    out = data
elif magic == b"\x37\x80\x40\x12":
    out = bytearray(len(data)); out[0::2] = data[1::2]; out[1::2] = data[0::2]
elif magic == b"\x40\x12\x37\x80":
    out = bytearray(len(data))
    for i in range(4):
        out[i::4] = data[3 - i::4]
else:
    sys.exit("[soh-build] not an N64 ROM (unknown header %s)" % magic.hex())
open(sys.argv[2], "wb").write(bytes(out))
PY
cmake --build build-cmake --target ExtractAssets
rm -rf roms

if [ ! -f build-cmake/soh/oot.o2r ]; then
  echo "[soh-build] ExtractAssets did not produce oot.o2r (ROM not supported?)" >&2
  exit 1
fi

install -m 0755 build-cmake/soh/soh.elf "${out_dir}/soh.elf"
install -m 0644 build-cmake/soh/soh.o2r build-cmake/soh/oot.o2r "${out_dir}/"
if [ -f build-cmake/soh/oot-mq.o2r ]; then
  install -m 0644 build-cmake/soh/oot-mq.o2r "${out_dir}/"
fi
install -m 0644 build-cmake/gamecontrollerdb.txt "${out_dir}/"
# SoH на каждом старте проверяет каталог assets/ рядом с бинарником (описания активов для
# извлечения из ROM в самой игре) и без него выходит с «Extractor assets not found», даже когда
# oot.o2r уже есть. ROM в сессии нет, извлекать игре нечего — хватает пустого каталога
# (полный soh/assets/yml — 120 МиБ).
mkdir -p "${out_dir}/assets"
install -m 0755 "${game_dir}/run" "${out_dir}/run"
install -m 0644 "${game_dir}/shipofharkinian.json" "${out_dir}/shipofharkinian.json"

echo "[soh-build] done: ${SOH_REF}"
ls -la "${out_dir}"
