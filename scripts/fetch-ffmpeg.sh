#!/usr/bin/env bash
# Скачивает статические ffmpeg/ffprobe (pinned). Приоритет — LGPL-сборка.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="${FFMPEG_VERSION:-6.0.1}"
OUT="$ROOT/resources/ffmpeg"
mkdir -p "$OUT"
if [ -x "$OUT/ffmpeg" ] && [ -x "$OUT/ffprobe" ]; then
  echo "ffmpeg уже на месте: $($OUT/ffmpeg -version | head -1)"
  exit 0
fi
TMP="$ROOT/.cache/ffmpeg"; mkdir -p "$TMP"
URL="${FFMPEG_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz}"
echo "Скачивание $URL (GPL static; для LGPL задайте FFMPEG_URL)"
if [ ! -s "$TMP/ffmpeg.tar.xz" ]; then
  curl -fL --retry 3 -o "$TMP/ffmpeg.tar.xz" "$URL"
fi
rm -rf "$TMP/unpack" && mkdir -p "$TMP/unpack"
tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP/unpack" --strip-components=1
cp "$TMP/unpack/ffmpeg" "$TMP/unpack/ffprobe" "$OUT/"
chmod +x "$OUT/ffmpeg" "$OUT/ffprobe"
"$OUT/ffmpeg" -version | head -1
