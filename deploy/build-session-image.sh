#!/usr/bin/env bash
# Сборка образа сессии cg-session:<версия драйвера> на воркере (по умолчанию brofrong).
#
#   ./deploy/build-session-image.sh [ssh-хост]
#
# 1. rsync images/session -> <хост>:~/cg-session-image (каталог nv/ на воркере не трогается).
# 2. Версия драйвера = nvidia-smi --query-gpu=driver_version на воркере.
# 3. Если библиотек этой версии ещё нет: скачать NVIDIA-Linux-x86_64-<ver>.run и распаковать
#    (--extract-only) в nv/x. Скачанный .run и распаковка кешируются в ~/cg-session-image/nv.
# 4. docker build --build-arg NV_VER=<ver> -t cg-session:<ver>.
#
# Ничего, кроме своего каталога и своего образа, на воркере не меняет; sudo не нужен.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${1:-brofrong}"
REMOTE_DIR="cg-session-image"

echo "==> rsync images/session -> ${REMOTE_HOST}:~/${REMOTE_DIR}"
ssh "${REMOTE_HOST}" "mkdir -p ~/${REMOTE_DIR}"
rsync -az --delete --exclude "/nv/" --exclude ".DS_Store" \
  "${REPO_ROOT}/images/session/" "${REMOTE_HOST}:${REMOTE_DIR}/"

echo "==> версия драйвера на ${REMOTE_HOST}"
NV_VER="$(ssh "${REMOTE_HOST}" "nvidia-smi --query-gpu=driver_version --format=csv,noheader" | head -n 1 | tr -d '[:space:]')"
if ! [[ "${NV_VER}" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then
  echo "ОШИБКА: не удалось определить версию драйвера NVIDIA: '${NV_VER}'" >&2
  exit 1
fi
echo "    ${NV_VER}"

ssh "${REMOTE_HOST}" bash -s -- "${REMOTE_DIR}" "${NV_VER}" <<'REMOTE'
set -euo pipefail
cd ~/"$1"
ver="$2"
run="nv/NVIDIA-Linux-x86_64-${ver}.run"
mkdir -p nv

if [ -f "nv/x/32/libGLX_nvidia.so.${ver}" ]; then
  echo "==> библиотеки NVIDIA ${ver} уже распакованы (nv/x)"
else
  if [ ! -f "${run}" ]; then
    echo "==> скачивание ${run##*/}"
    curl -fL --retry 3 -o "${run}.part" \
      "https://us.download.nvidia.com/XFree86/Linux-x86_64/${ver}/NVIDIA-Linux-x86_64-${ver}.run"
    mv "${run}.part" "${run}"
  fi
  echo "==> распаковка ${run##*/} (--extract-only)"
  rm -rf nv/x
  sh "${run}" --extract-only --target nv/x
fi

echo "==> docker build cg-session:${ver}"
docker build --build-arg NV_VER="${ver}" -t "cg-session:${ver}" .
docker images "cg-session:${ver}"
REMOTE

echo "==> готово: cg-session:${NV_VER} на ${REMOTE_HOST}"
