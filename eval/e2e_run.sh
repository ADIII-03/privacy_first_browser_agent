#!/usr/bin/env bash
# e2e_run.sh — One command: run the REAL extension in a REAL browser, end-to-end.
#
# Builds a TEST-RIG extension copy (host_permissions <all_urls> — captureVisibleTab
# needs activeTab granted by a genuine user gesture, which automation cannot
# produce; the shipped manifest stays strict), launches Chromium with it, then
# drives the perceive→redact→plan→act loop via CDP and reports privacy receipts.
#
#   bash eval/e2e_run.sh                 # headless, ~10 s
#   HEADED=1 bash eval/e2e_run.sh        # visible browser window (leaves it open)
#   SLOW_MS=1200 bash eval/e2e_run.sh    # slow the loop between steps (demo mode)
#   CHROME_BIN=... CDP_PORT=9222 ...     # overrides
#
# Exit 0 = the agent loop completed with privacy receipts on every step.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/eval/e2e_work"
CDP_PORT="${CDP_PORT:-9222}"
SERVER_URL="${SERVER_URL:-http://localhost:8000}"
DEMO_PORT="${DEMO_PORT:-8088}"
HEADED="${HEADED:-0}"
SLOW_MS="${SLOW_MS:-0}"
KEEP_OPEN="${KEEP_OPEN:-$HEADED}"

say() { printf '\033[1;36m[e2e]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[e2e] FATAL:\033[0m %s\n' "$*"; exit 2; }

# ---- 0. chromium binary ------------------------------------------------------
CHROME_BIN="${CHROME_BIN:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -1)}"
[ -x "$CHROME_BIN" ] || die "no chromium found (set CHROME_BIN or: npx playwright install chromium)"

# ---- 1. reasoning server -----------------------------------------------------
curl -sf "$SERVER_URL/health" >/dev/null 2>&1 || {
  say "starting reasoning server (uv) ..."
  ( cd "$ROOT/server" && nohup uv run uvicorn main:app --port 8000 >/tmp/pba-e2e-server.log 2>&1 & echo $! > /tmp/pba-e2e-server.pid )
  for i in $(seq 1 30); do curl -sf "$SERVER_URL/health" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -sf "$SERVER_URL/health" >/dev/null 2>&1 || die "reasoning server did not come up (see /tmp/pba-e2e-server.log)"
}
say "reasoning server: $SERVER_URL"

# ---- 2. demo page over http (file:// blocks content scripts by default) ------
curl -sf "http://localhost:$DEMO_PORT/index.html" >/dev/null 2>&1 || {
  say "serving demo/ on :$DEMO_PORT ..."
  ( nohup python3 -m http.server "$DEMO_PORT" -d "$ROOT/demo" >/tmp/pba-e2e-demo.log 2>&1 & echo $! > /tmp/pba-e2e-demo.pid )
  sleep 0.7
}
say "demo page: http://localhost:$DEMO_PORT/index.html"

# ---- 3. test-rig extension copy ----------------------------------------------
rm -rf "$WORK/ext-test"
mkdir -p "$WORK"
cp -r "$ROOT/extension" "$WORK/ext-test"
python3 - "$WORK/ext-test/manifest.json" <<'EOF'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["host_permissions"] = ["<all_urls>"]   # TEST RIG ONLY — see header note
m["name"] += " [TEST-RIG]"
json.dump(m, open(p, "w"), indent=2)
EOF
if [ "$SLOW_MS" != "0" ]; then
  sed -i "s/setTimeout(r, 300)/setTimeout(r, $SLOW_MS)/" "$WORK/ext-test/background/service-worker.js"
  say "loop pacing slowed to ${SLOW_MS}ms/step (watch mode)"
fi
say "test rig: $WORK/ext-test"

# ---- 4. launch chromium -------------------------------------------------------
CHROME_ARGS=(--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage
  --no-first-run --no-default-browser-check --disable-crash-reporter
  --enable-unsafe-webgpu "--load-extension=$WORK/ext-test"
  "--user-data-dir=$WORK/profile" "--remote-debugging-port=$CDP_PORT"
  --window-size=1280,900 about:blank)
if [ "$HEADED" = "1" ]; then
  say "launching VISIBLE chromium on DISPLAY=${DISPLAY:-:0} ..."
  DISPLAY="${DISPLAY:-:0}" nohup "$CHROME_BIN" "${CHROME_ARGS[@]}" >"$WORK/chrome.log" 2>&1 &
else
  say "launching headless chromium ..."
  nohup "$CHROME_BIN" --headless=new "${CHROME_ARGS[@]}" >"$WORK/chrome.log" 2>&1 &
fi
CHROME_PID=$!
for i in $(seq 1 30); do
  curl -sf "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.4
done
curl -sf "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1 || die "chromium CDP never came up ($WORK/chrome.log)"

# ---- 5. drive the agent loop --------------------------------------------------
export PROFILE_DIR="$WORK/profile"
RUN_PY() {  # websockets dep resolved on the fly, no repo-level python project needed
  if command -v uv >/dev/null 2>&1; then
    uv run --quiet --with websockets python "$ROOT/eval/e2e_browser.py"
  else
    python3 "$ROOT/eval/e2e_browser.py"   # needs websockets importable
  fi
}
RC=0; RUN_PY || RC=$?

# ---- 6. teardown --------------------------------------------------------------
if [ "$KEEP_OPEN" != "1" ]; then
  kill "$CHROME_PID" 2>/dev/null || true
else
  say "leaving the browser open (HEADED/KEEP_OPEN=1) — popup tab shows receipts & log"
fi
if [ -f /tmp/pba-e2e-server.pid ] && [ "${SPAWNED_SERVER:-0}" = "1" ]; then :; fi
# servers we spawned are left running (harmless, reusable); stop them with:
#   kill $(cat /tmp/pba-e2e-server.pid) 2>/dev/null; kill $(cat /tmp/pba-e2e-demo.pid) 2>/dev/null

say "result: $([ $RC -eq 0 ] && echo PASS || echo FAIL) (eval/out_e2e.png has the final frame)"
exit $RC
