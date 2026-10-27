#!/bin/bash
# УСТАРЕЛО: конфиг deb.afterInstall из packaging/electron-builder.yml удалён —
# используется дефолтный postinst electron-builder (создаёт /usr/bin/<exe>,
# настраивает chrome-sandbox SUID/0755 по наличию user namespaces и ставит
# AppArmor-профиль на Ubuntu 24+). Кастомный скрипт заменял этот шаблон целиком.
# Файл оставлен для истории; сборкой не используется.
# Chromium sandbox: SUID-бит на chrome-sandbox (TARGET.md §9 — sandbox не выключаем).
if [ -f /opt/VideoLessons/chrome-sandbox ]; then
  chown root:root /opt/VideoLessons/chrome-sandbox || true
  chmod 4755 /opt/VideoLessons/chrome-sandbox || true
fi
