#!/usr/bin/env bash
# Локальные проверки: backend pytest + ruff, frontend typecheck + vitest.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
if [ -x "$ROOT/.venv/bin/python" ]; then
  echo "== ruff =="
  "$ROOT/.venv/bin/ruff" check backend/app backend/tests
  echo "== pytest =="
  ( cd backend && "$ROOT/.venv/bin/python" -m pytest )
else
  echo "backend: .venv не найден, пропуск" >&2
fi
echo "== frontend typecheck =="
npm --prefix frontend run typecheck
echo "== frontend tests =="
npm --prefix frontend run test
