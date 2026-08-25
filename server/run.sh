#!/usr/bin/env bash
# run.sh — One-command bootstrap for the PBA reasoning server (macOS / Linux).
#
# Preferred path uses **uv** (https://docs.astral.sh/uv/): `uv sync` restores an
# exact environment from uv.lock in seconds; then uvicorn launches from that env.
# If uv is not installed we fall back to a plain venv + pip (requirements are
# mirrored there for that case only).
#
#   ./run.sh                  # mock backend on :8000 (no model required)
#   ./run.sh --port 9000      # any extra args pass straight through to uvicorn
#   PBA_REINSTALL=1 ./run.sh  # force a fresh dependency install
#
# (If the executable bit isn't set, just run:  bash run.sh)
set -euo pipefail
cd "$(dirname "$0")"

if command -v uv >/dev/null 2>&1; then
  echo "* uv $(uv --version | cut -d' ' -f2) detected"
  if [ "${PBA_REINSTALL:-}" = "1" ]; then
    echo "* re-syncing environment from uv.lock (--reinstall) ..."
    uv sync --reinstall
  else
    uv sync --frozen 2>/dev/null || uv sync
  fi
  if [ "$#" -eq 0 ]; then set -- --port 8000; fi
  echo "* starting: uvicorn main:app $*"
  echo "  health:   http://localhost:8000/health"
  echo
  exec uv run --no-sync python -m uvicorn main:app "$@"
fi

# ---- legacy fallback (no uv): venv + pip ------------------------------------
echo "* uv not found — falling back to python3 -m venv (install uv for faster setup)"
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || PY=python
command -v "$PY" >/dev/null 2>&1 || { echo "No Python on PATH. Install Python 3.10+ and re-run."; exit 1; }

VENV_PY=".venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "* creating virtualenv (.venv) ..."
  "$PY" -m venv .venv
fi

if [ "${PBA_REINSTALL:-}" = "1" ] || ! "$VENV_PY" -c "import fastapi, uvicorn, pydantic" 2>/dev/null; then
  echo "* installing requirements.txt ..."
  "$VENV_PY" -m pip install -r requirements.txt
else
  echo "* dependencies already present (PBA_REINSTALL=1 to refresh)"
fi

if [ "$#" -eq 0 ]; then set -- --port 8000; fi
echo "* starting: uvicorn main:app $*"
echo "  health:   http://localhost:8000/health"
echo
exec "$VENV_PY" -m uvicorn main:app "$@"
