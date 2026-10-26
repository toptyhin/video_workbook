#!/usr/bin/env bash
# CI: lint/test (+ опционально сборка артефактов). Коды выхода: 0 успех, 1 провал, 2 окружение.
set -euo pipefail
cd "$(dirname "$0")/.."
STAGE="${VL_CI_STAGE:-all}"
echo "== stage: $STAGE =="
case "$STAGE" in
  deps|lint|test|all)
    scripts/test.sh || exit 1
    ;;
esac
if [ "$STAGE" = "build" ] || [ "$STAGE" = "all" ]; then
  if ! command -v docker >/dev/null; then echo "docker недоступен" >&2; exit 2; fi
  scripts/fetch-ffmpeg.sh || exit 2
  scripts/build-backend.sh docker || exit 2
  scripts/build-electron.sh || exit 1
fi
if [ "$STAGE" = "artifacts" ] || [ "$STAGE" = "all" ]; then
  mkdir -p dist
  npx electron-builder --linux deb AppImage --publish never || exit 1
  mkdir -p dist/ci && sha256sum dist/*.deb dist/*.AppImage 2>/dev/null > dist/ci/SHA256SUMS || true
fi
echo "CI OK"
