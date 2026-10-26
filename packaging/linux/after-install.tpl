#!/bin/bash
# Chromium sandbox: SUID-бит на chrome-sandbox (TARGET.md §9 — sandbox не выключаем).
if [ -f /opt/VideoLessons/chrome-sandbox ]; then
  chown root:root /opt/VideoLessons/chrome-sandbox || true
  chmod 4755 /opt/VideoLessons/chrome-sandbox || true
fi
