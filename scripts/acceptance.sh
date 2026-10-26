#!/usr/bin/env bash
# Приёмка API: поднимает backend, прогоняет сценарии, пишет отчёт. Коды: 0/1/2.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
export VL_TOKEN="${VL_TOKEN:-acceptance-token}"
export VL_DATA_DIR="$ROOT/.tmp/acceptance-data"
export VL_FRONTEND_DIR="$ROOT/frontend/dist"
rm -rf "$VL_DATA_DIR"; mkdir -p "$VL_DATA_DIR" "$ROOT/dist/acceptance"
LOG="$ROOT/.tmp/acceptance.log"
( cd backend && VL_PORT=0 "$ROOT/.venv/bin/python" -m app.main ) >"$LOG" 2>&1 &
PID=$!
cleanup(){ kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT
PORT=""
for _ in $(seq 1 100); do
  PORT=$(python3 - <<PY
import re
try:
    text=open("$LOG",encoding="utf-8").read()
except FileNotFoundError:
    print("")
else:
    m=re.search(r'VL_READY:\{"port":\s*(\d+)\}', text)
    print(m.group(1) if m else "")
PY
)
  [ -n "$PORT" ] && break
  sleep 0.2
done
if [ -z "$PORT" ]; then echo "backend не стартовал" >&2; exit 2; fi
BASE="http://127.0.0.1:$PORT"
H="X-VL-Token: $VL_TOKEN"
pass=0; fail=0
check(){ local name="$1" expected="$2" actual="$3"; if [ "$actual" = "$expected" ]; then pass=$((pass+1)); echo "PASS $name"; else fail=$((fail+1)); echo "FAIL $name: expected $expected got $actual"; fi; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }

check "health 200" 200 "$(code -H "$H" "$BASE/api/health")"
check "auth 401" 401 "$(code "$BASE/api/health")"
check "settings 200" 200 "$(code -H "$H" "$BASE/api/settings")"

FIX="$ROOT/.tmp/acceptance-videos"; rm -rf "$FIX"; mkdir -p "$FIX"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=black:s=320x240:d=2" \
  -f lavfi -i "sine=frequency=440:duration=2" -shortest -c:v mpeg4 -c:a aac "$FIX/lesson-01.mp4"
check "scan 202" 202 "$(code -H "$H" -H "Content-Type: application/json" -d "{\"path\":\"$FIX\"}" "$BASE/api/videos/scan")"
VIDEO_ID=""
for _ in $(seq 1 100); do
  VIDEO_ID=$(curl -s -H "$H" "$BASE/api/videos" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["items"][0]["id"] if d["items"] else "")')
  [ -n "$VIDEO_ID" ] && break; sleep 0.1
done
check "scan indexed" 1 "$(curl -s -H "$H" "$BASE/api/videos" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')"

TAG=$(curl -s -H "$H" -H "Content-Type: application/json" -d '{"name":"Приемка"}' "$BASE/api/tags" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
check "tag assign 204" 204 "$(code -H "$H" -H "Content-Type: application/json" -d "{\"tag_id\":$TAG}" "$BASE/api/videos/$VIDEO_ID/tags")"
ANN=$(curl -s -H "$H" -H "Content-Type: application/json" -d "{\"video_id\":$VIDEO_ID,\"start_ms\":500,\"end_ms\":1500,\"label\":\"важный пример\",\"tag_ids\":[$TAG]}" "$BASE/api/annotations")
ANN_ID=$(echo "$ANN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
check "annotation created" 1 "$(echo "$ANN" | python3 -c 'import json,sys; print(1 if json.load(sys.stdin)["label"]=="важный пример" else 0)')"
check "annotation search" 1 "$(curl -s -H "$H" "$BASE/api/search?q=%D0%B2%D0%B0%D0%B6%D0%BD%D1%8B%D0%B9&scope=annotations" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')"
check "annotation tag filter" 1 "$(curl -s -H "$H" "$BASE/api/search?q=tag:%D0%9F%D1%80%D0%B8%D0%B5%D0%BC%D0%BA%D0%B0&scope=annotations" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])')"
check "annotation export" 1 "$(curl -s -H "$H" "$BASE/api/annotations/export?video_id=$VIDEO_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
check "annotation delete 204" 204 "$(code -X DELETE -H "$H" "$BASE/api/annotations/$ANN_ID")"
check "annotation 404 after delete" 404 "$(code -H "$H" "$BASE/api/annotations/$ANN_ID")"

python3 - "$pass" "$fail" "$PORT" <<'PY'
import json,sys,datetime,pathlib
passed,failed,port=map(int,sys.argv[1:4])
report={"timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat(),"port":port,
        "passed":passed,"failed":failed,"status":"ok" if failed==0 else "fail"}
pathlib.Path("dist/acceptance/report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps(report,ensure_ascii=False))
PY
[ "$fail" -eq 0 ] || exit 1
