#!/usr/bin/env bash
# Проверка артефакта на чистой VM/контейнере (Ubuntu 22.04/24.04). Требует multipass или docker с GUI.
set -euo pipefail
cd "$(dirname "$0")/.."
ARTIFACT="${1:-$(ls dist/*.deb 2>/dev/null | head -1)}"
if [ -z "${ARTIFACT:-}" ]; then echo "Нет .deb в dist/; сначала scripts/make-release.sh" >&2; exit 2; fi
echo "Артефакт: $ARTIFACT"
if command -v multipass >/dev/null; then
  for release in 22.04 24.04; do
    name="vl-smoke-${release//./}"
    multipass launch --name "$name" "$release" --cpus 2 --memory 4G --disk 20G || true
    multipass transfer "$ARTIFACT" "$name:/tmp/app.deb"
    multipass exec "$name" -- bash -lc 'command -v python3; command -v ffmpeg; sudo dpkg -i /tmp/app.deb || sudo apt-get -f install -y; xvfb-run -a videolessons --version || true'
    multipass delete --purge "$name"
  done
else
  echo "multipass не найден — ручной сценарий на VM (см. docs/acceptance.md)" >&2
  exit 2
fi
