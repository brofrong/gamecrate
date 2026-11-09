#!/usr/bin/env bash
# Сборка и пуш образов cg-session в CI (.gitlab-ci.yml, джоба build-session, запускается на
# тег релиза vX.Y.Z).
#
#   ./deploy/ci/build-session-images.sh <тег>
#
# Для каждой версии драйвера из images/session/drivers.txt (одна версия на строке):
# 1. Скачивает NVIDIA-Linux-x86_64-<версия>.run в images/session/nv/, если его там ещё нет
#    (кэшируется между пайплайнами CI, см. .gitlab-ci.yml: cache по images/session/nv/*.run).
# 2. Распаковывает (--extract-only) в images/session/nv/x — то же место, что использует
#    deploy/build-session-image.sh на воркере (brofrong); отличие только в том, что версию там
#    определяет nvidia-smi хоста, а здесь — строки drivers.txt, без ssh.
# 3. docker build images/session --build-arg NV_VER=<версия>
#    -t $CI_REGISTRY_IMAGE/cg-session:<версия>-<тег>, затем docker push.
#
# Версии обрабатываются по очереди (не параллельно): images/session/nv/x — общий путь
# распаковки для всех версий, параллельная сборка затёрла бы его.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAG="${1:?использование: build-session-images.sh <тег>}"
SESSION_DIR="${REPO_ROOT}/images/session"
DRIVERS_FILE="${SESSION_DIR}/drivers.txt"
REGISTRY_IMAGE="${CI_REGISTRY_IMAGE:?переменная CI_REGISTRY_IMAGE не задана}"

mkdir -p "${SESSION_DIR}/nv"

while IFS= read -r ver; do
  [ -n "${ver}" ] || continue
  if ! [[ "${ver}" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then
    echo "ОШИБКА: в drivers.txt не похоже на версию драйвера: '${ver}'" >&2
    exit 1
  fi

  run="${SESSION_DIR}/nv/NVIDIA-Linux-x86_64-${ver}.run"
  if [ -f "${SESSION_DIR}/nv/x/32/libGLX_nvidia.so.${ver}" ]; then
    echo "==> библиотеки NVIDIA ${ver} уже распакованы (nv/x)"
  else
    if [ ! -f "${run}" ]; then
      echo "==> скачивание ${run##*/}"
      curl -fL --retry 3 -o "${run}.part" \
        "https://us.download.nvidia.com/XFree86/Linux-x86_64/${ver}/NVIDIA-Linux-x86_64-${ver}.run"
      mv "${run}.part" "${run}"
    fi
    echo "==> распаковка ${run##*/} (--extract-only)"
    rm -rf "${SESSION_DIR}/nv/x"
    sh "${run}" --extract-only --target "${SESSION_DIR}/nv/x"
  fi

  tag="${REGISTRY_IMAGE}/cg-session:${ver}-${TAG}"
  echo "==> docker build ${tag}"
  docker build --build-arg NV_VER="${ver}" -t "${tag}" "${SESSION_DIR}"
  echo "==> docker push ${tag}"
  docker push "${tag}"
done <"${DRIVERS_FILE}"

echo "==> готово: образы cg-session собраны и запушены для тега ${TAG}"
