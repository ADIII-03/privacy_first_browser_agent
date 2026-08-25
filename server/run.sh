#!/usr/bin/env bash
# run.sh — One-command bootstrap for the PBA reasoning server (macOS / Linux).
#
# Creates an isolated virtualenv, installs requirements.txt into it, then launches
# uvicorn — all idempotently. Re-running reuses the venv, so only the FIRST run
# pays the install cost.
#
#   ./run.sh                  # mock backend on :8000 (no model required)
#   ./run.sh --port 9000      # any extra args pass straight through to uvicorn
#   PBA_REINSTALL=1 ./run.sh  # force a fresh dependency install
#
# (If the executable bit isn't set, just run:  bash run.sh)
set -euo pipefail
cd "$(dirname "$0")"

# 1. Locate a base Python (override with PYTHON=/path/to/python).
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || PY=python
command -v "$PY" >/dev/null 2>&1 || { echo "No Python on PATH. Install Python 3.10+ and re-run."; exit 1; }

VENV_PY=".venv/bin/python"

# 2. Create the venv once.
if [ ! -x "$VENV_PY" ]; then
  echo "* creating virtualenv (.venv) ..."
  "$PY" -m venv .venv
fi

# 3. Install deps on first run, when a core import is missing, or on PBA_REINSTALL=1.
if [ "${PBA_REINSTALL:-}" = "1" ] || ! "$VENV_PY" -c "import fastapi, uvicorn, pydantic" 2>/dev/null; then
  echo "* installing requirements.txt ..."
  "$VENV_PY" -m pip install -r requirements.txt
else
  echo "* dependencies already present (PBA_REINSTALL=1 to refresh)"
fi

# 4. Launch. Default to :8000 when no uvicorn args are supplied.
if [ "$#" -eq 0 ]; then set -- --port 8000; fi
echo "* starting: uvicorn main:app $*"
echo "  health:   http://localhost:8000/health"
echo
exec "$VENV_PY" -m uvicorn main:app "$@"
