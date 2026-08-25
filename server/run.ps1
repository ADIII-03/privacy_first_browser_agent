# run.ps1 — One-command bootstrap for the PBA reasoning server (Windows / PowerShell).
#
# Preferred path uses **uv** (https://docs.astral.sh/uv/): `uv sync` restores an
# exact environment from uv.lock in seconds; uvicorn then launches from that env.
# If uv is not installed we fall back to a plain venv + pip (requirements are
# mirrored there for that case only).
#
#   .\run.ps1                  # mock backend on :8000 (no model required)
#   .\run.ps1 --port 9000      # any extra args pass straight through to uvicorn
#   .\run.ps1 -Reinstall       # force a fresh dependency install
#
# NOTE ON ERROR HANDLING: we deliberately do NOT set $ErrorActionPreference='Stop'.
# In Windows PowerShell 5.1, a native .exe writing to stderr is wrapped as a
# *terminating* NativeCommandError under 'Stop', which would abort this bootstrap.
# We check $LASTEXITCODE / Test-Path after each native call and decide explicitly.

Set-Location $PSScriptRoot

# Separate our own -Reinstall switch from the args meant for uvicorn.
$passthru = @()
$reinstall = $false
foreach ($a in $args) {
  if ($a -eq "-Reinstall" -or $a -eq "--reinstall") { $reinstall = $true }
  else { $passthru += $a }
}

if (Get-Command uv -ErrorAction SilentlyContinue) {
  Write-Host "* uv detected"
  if ($reinstall) {
    Write-Host "* re-syncing environment from uv.lock (--reinstall) ..."
    & uv sync --reinstall
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: uv sync --reinstall failed (exit $LASTEXITCODE)."; exit 1 }
  } else {
    & uv sync --frozen
    if ($LASTEXITCODE -ne 0) { & uv sync; if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: uv sync failed."; exit 1 } }
  }
  if ($passthru.Count -eq 0) { $passthru = @("--port", "8000") }
  Write-Host "* starting: uvicorn main:app $($passthru -join ' ')"
  Write-Host "  health:   http://localhost:8000/health`n"
  & uv run --no-sync python -m uvicorn main:app @passthru
  exit $LASTEXITCODE
}

# ---- legacy fallback (no uv): venv + pip ------------------------------------
Write-Host "* uv not found — falling back to venv + pip (install uv for faster setup)"

$basePy = if (Get-Command py -ErrorAction SilentlyContinue) { "py" }
          elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
          else { Write-Host "ERROR: No Python on PATH. Install Python 3.10+ from python.org and re-run."; exit 1 }

$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPy)) {
  Write-Host "* creating virtualenv (.venv) ..."
  & $basePy -m venv .venv
  if (-not (Test-Path $venvPy)) { Write-Host "ERROR: venv creation failed (is the 'venv' module available?)."; exit 1 }
}

& $venvPy -c "import fastapi, uvicorn, pydantic" 2>$null
$depsOk = ($LASTEXITCODE -eq 0)
if ($reinstall -or -not $depsOk) {
  Write-Host "* installing requirements.txt ..."
  & $venvPy -m pip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: pip install failed (exit $LASTEXITCODE)."; exit 1 }
} else {
  Write-Host "* dependencies already present (pass -Reinstall to refresh)"
}

if ($passthru.Count -eq 0) { $passthru = @("--port", "8000") }
Write-Host "* starting: uvicorn main:app $($passthru -join ' ')"
Write-Host "  health:   http://localhost:8000/health`n"
& $venvPy -m uvicorn main:app @passthru
exit $LASTEXITCODE
