#!/usr/bin/env bash
# Структурная проверка раскладки собранного артефакта (M8).
#
# Sidecar-backend, SPA, ffmpeg/ffprobe и модели обязаны лежать в resources/
# ВНЕ asar: Electron запускает их как дочерние процессы и читает с диска,
# а из asar нельзя ни исполнить файл, ни отдать его backend'у.
#
# Проверка ловит регресс «electron-builder запущен без --config
# packaging/electron-builder.yml» (тогда extraResources не применяются,
# а в asar затягивается весь репозиторий).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
UNPACKED="$ROOT/dist/linux-unpacked"
RES="$UNPACKED/resources"
MAX_ASAR_MB="${VL_MAX_ASAR_MB:-100}"
fail=0

ok() { printf 'ok: %s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*" >&2; fail=1; }
is_exec() { [ -f "$1" ] && [ -x "$1" ]; }

if [ ! -d "$UNPACKED" ]; then
  echo "Нет $UNPACKED — сначала соберите артефакты (npm run dist или npm run dist:dir)" >&2
  exit 1
fi

# --- backend sidecar ------------------------------------------------------
if is_exec "$RES/backend/vl-backend"; then
  ok "sidecar: resources/backend/vl-backend (исполняемый)"
else
  bad "нет исполняемого resources/backend/vl-backend — приложение не сможет запустить backend"
fi
if [ -d "$RES/backend/_internal" ]; then
  ok "sidecar: resources/backend/_internal (PyInstaller onedir)"
else
  bad "нет resources/backend/_internal — onedir-backend неполный"
fi

# --- SPA ------------------------------------------------------------------
if [ -f "$RES/frontend/dist/index.html" ]; then
  ok "SPA: resources/frontend/dist/index.html"
else
  bad "нет resources/frontend/dist/index.html — окно откроется пустым (API-only)"
fi

# --- ffmpeg / ffprobe -----------------------------------------------------
for bin in ffmpeg ffprobe; do
  if is_exec "$RES/ffmpeg/$bin"; then
    ok "ffmpeg: resources/ffmpeg/$bin (исполняемый)"
  else
    bad "нет исполняемого resources/ffmpeg/$bin — транскрипция/превью не заработают"
  fi
done

# --- модели (M13: не поставляются в бандле) ------------------------------
if [ -d "$RES/models" ] && [ -n "$(ls -A "$RES/models" 2>/dev/null)" ]; then
  bad "resources/models не должен входить в релизный артефакт (M13): модели скачиваются в \$VL_DATA_DIR/models"
else
  ok "models: в бандле отсутствуют (скачиваются из настроек)"
fi

# --- llama.cpp runtime (M14) ---------------------------------------------
if is_exec "$RES/llama/llama-cli"; then
  ok "llama.cpp: resources/llama/llama-cli (исполняемый)"
else
  bad "нет исполняемого resources/llama/llama-cli — саммари не заработает"
fi

# --- лицензии -------------------------------------------------------------
if [ -f "$RES/THIRD-PARTY-NOTICES.md" ]; then
  ok "licenses: resources/THIRD-PARTY-NOTICES.md"
else
  bad "нет resources/THIRD-PARTY-NOTICES.md"
fi

# --- asar -----------------------------------------------------------------
if [ -f "$RES/app.asar" ]; then
  size_mb=$(( $(stat -c%s "$RES/app.asar") / 1024 / 1024 ))
  if [ "$size_mb" -le "$MAX_ASAR_MB" ]; then
    ok "app.asar: ${size_mb} MB (<= ${MAX_ASAR_MB} MB)"
  else
    bad "app.asar ${size_mb} MB — в архив попал лишний код; проверьте, что electron-builder запущен с --config packaging/electron-builder.yml"
  fi
else
  bad "нет resources/app.asar"
fi

# --- AppImage -------------------------------------------------------------
shopt -s nullglob
appimages=("$ROOT"/dist/VideoLessons-*.AppImage)
if [ "${#appimages[@]}" -eq 0 ]; then
  echo "note: dist/VideoLessons-*.AppImage не найден — проверен только linux-unpacked"
else
  for img in "${appimages[@]}"; do
    tmp="$(mktemp -d)"
    if ( cd "$tmp" && "$img" --appimage-extract 'resources/backend/vl-backend' >/dev/null 2>&1 ); then
      extracted="$tmp/squashfs-root/resources/backend/vl-backend"
      if is_exec "$extracted"; then
        ok "AppImage: $(basename "$img") содержит resources/backend/vl-backend"
      else
        bad "AppImage $(basename "$img") НЕ содержит resources/backend/vl-backend — backend не запустится"
      fi
    else
      bad "не удалось распаковать $(basename "$img") (--appimage-extract)"
    fi
    if ( cd "$tmp" && "$img" --appimage-extract 'resources/frontend/dist/index.html' >/dev/null 2>&1 ); then
      if [ -f "$tmp/squashfs-root/resources/frontend/dist/index.html" ]; then
        ok "AppImage: $(basename "$img") содержит resources/frontend/dist/index.html"
      else
        bad "AppImage $(basename "$img") НЕ содержит SPA (resources/frontend/dist/index.html)"
      fi
    fi
    if ( cd "$tmp" && "$img" --appimage-extract 'resources/ffmpeg/ffmpeg' >/dev/null 2>&1 ); then
      if is_exec "$tmp/squashfs-root/resources/ffmpeg/ffmpeg"; then
        ok "AppImage: $(basename "$img") содержит исполняемый resources/ffmpeg/ffmpeg"
      else
        bad "AppImage: $(basename "$img") НЕ содержит исполняемый resources/ffmpeg/ffmpeg"
      fi
    fi
    rm -rf "$tmp"
  done
fi

# --- размерные гейты (M13/M14) -------------------------------------------
MAX_APPIMAGE_MB="${VL_MAX_APPIMAGE_MB:-450}"
MAX_DEB_MB="${VL_MAX_DEB_MB:-400}"
shopt -s nullglob
for img in "$ROOT"/dist/VideoLessons-*.AppImage; do
  mb=$(( $(stat -c%s "$img") / 1024 / 1024 ))
  if [ "$mb" -le "$MAX_APPIMAGE_MB" ]; then ok "size: $(basename "$img") ${mb} MB (<= ${MAX_APPIMAGE_MB})"; else bad "size: $(basename "$img") ${mb} MB > ${MAX_APPIMAGE_MB} MB"; fi
done
for deb in "$ROOT"/dist/VideoLessons-*.deb; do
  mb=$(( $(stat -c%s "$deb") / 1024 / 1024 ))
  if [ "$mb" -le "$MAX_DEB_MB" ]; then ok "size: $(basename "$deb") ${mb} MB (<= ${MAX_DEB_MB})"; else bad "size: $(basename "$deb") ${mb} MB > ${MAX_DEB_MB} MB"; fi
done

if [ "$fail" -ne 0 ]; then
  echo "== artifacts: FAIL ==" >&2
  exit 1
fi
echo "== artifacts: OK =="
