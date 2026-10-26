#!/usr/bin/env bash
# Ручная сборка .deb (ar + tar): окружение без fpm/electron-builder.
# Требует: dist-electron/, frontend/dist, backend-dist/vl-backend, resources/{ffmpeg,models}.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
STAGE="$ROOT/.tmp/deb-stage"
PKGROOT="$STAGE/root"
APPDIR="$PKGROOT/opt/VideoLessons"
DEBIAN="$STAGE/DEBIAN"
OUT="$ROOT/dist/VideoLessons-${VERSION}-amd64.deb"

for required in dist-electron/main.js frontend/dist/index.html backend-dist/vl-backend/vl-backend; do
  [ -e "$ROOT/$required" ] || { echo "Нет $required — соберите: scripts/build-backend.sh docker && scripts/build-electron.sh" >&2; exit 1; }
done

rm -rf "$STAGE"; mkdir -p "$APPDIR/resources" "$DEBIAN" \
  "$PKGROOT/usr/share/applications" "$PKGROOT/usr/share/icons/hicolor/512x512/apps"

cp -a "$ROOT/node_modules/electron/dist/." "$APPDIR/"
cp -a "$ROOT/dist-electron" "$APPDIR/dist-electron"
cp "$ROOT/package.json" "$APPDIR/package.json"
mkdir -p "$APPDIR/resources/frontend"
cp -a "$ROOT/backend-dist/vl-backend" "$APPDIR/resources/backend"
cp -a "$ROOT/frontend/dist" "$APPDIR/resources/frontend/dist"
[ -d "$ROOT/resources/ffmpeg" ] && cp -a "$ROOT/resources/ffmpeg" "$APPDIR/resources/ffmpeg"
[ -d "$ROOT/resources/models" ] && cp -a "$ROOT/resources/models" "$APPDIR/resources/models"
cp "$ROOT/resources/THIRD-PARTY-NOTICES.md" "$APPDIR/resources/"
cp "$ROOT/resources/SOURCE-OFFER.md" "$APPDIR/resources/" 2>/dev/null || true

cat > "$APPDIR/videolessons" <<'LAUNCH'
#!/bin/sh
DIR=$(dirname "$(readlink -f "$0")")
VL_PACKAGED=1 VL_RESOURCES_DIR="$DIR/resources" exec "$DIR/electron" "$DIR" "$@"
LAUNCH
chmod +x "$APPDIR/videolessons"
ln -sf /opt/VideoLessons/videolessons "$PKGROOT/usr/bin/videolessons"
cp "$ROOT/packaging/linux/videolessons.desktop" "$PKGROOT/usr/share/applications/videolessons.desktop"
cp "$ROOT/build/icon.png" "$PKGROOT/usr/share/icons/hicolor/512x512/apps/videolessons.png"

INSTALLED_KB=$(du -sk "$PKGROOT" | cut -f1)
cat > "$DEBIAN/control" <<CONTROL
Package: videolessons
Version: ${VERSION}
Section: video
Priority: optional
Architecture: amd64
Installed-Size: ${INSTALLED_KB}
Maintainer: VideoLessons Maintainers <maintainers@videolessons.local>
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libdrm2, libgbm1, libasound2
Description: VideoLessons
 Локальная библиотека видеоуроков: офлайн-транскрипция (faster-whisper CPU),
 поиск по произнесённым словам, иерархические теги и пользовательские
 метки на фрагменты видео с поиском по ним.
CONTROL

cat > "$DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
if [ -f /opt/VideoLessons/chrome-sandbox ]; then
  chown root:root /opt/VideoLessons/chrome-sandbox || true
  chmod 4755 /opt/VideoLessons/chrome-sandbox || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q || true
fi
exit 0
POSTINST
chmod 755 "$DEBIAN/postinst"
cat > "$DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
set -e
exit 0
POSTRM
chmod 755 "$DEBIAN/postrm"

(cd "$PKGROOT" && tar --owner=0 --group=0 -czf "$STAGE/data.tar.gz" .)
(cd "$DEBIAN" && tar --owner=0 --group=0 -czf "$STAGE/control.tar.gz" .)
printf '2.0\n' > "$STAGE/debian-binary"
mkdir -p "$ROOT/dist"
rm -f "$OUT"
(cd "$STAGE" && ar rc "$OUT" debian-binary control.tar.gz data.tar.gz)
echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Проверка содержимого: ar t $OUT"
