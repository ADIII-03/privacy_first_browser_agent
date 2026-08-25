# run.ps1 — One-command bootstrap for the PBA reasoning server (Windows / PowerShell).
#
# Creates an isolated virtualenv, installs requirements.txt into it, then launches
# uvicorn — all idempotently. Re-running is safe: the venv and its installed deps
# are reused, so only the FIRST run pays the install cost.
#
#   .\run.ps1                  # mock backend on :8000 (no model required)
#   .\run.ps1 --port 9000      # any extra args pass straight through to uvicorn
#   .\run.ps1 -Reinstall       # force a fresh dependency install
#
# It calls the venv's python.exe DIRECTLY instead of sourcing Activate.ps1, so it
# works even under the default Restricted execution policy (no activation needed).
#
# NOTE ON ERROR HANDLING: we deliberately do NOT set $ErrorActionPreference='Stop'.
# In Windows PowerShell 5.1, a native .exe that writes to stderr — a failed
# `python -c import` probe on a fresh venv, or even a routine `pip` warning — is
# wrapped as a *terminating* NativeCommandError under 'Stop', which would abort
# this bootstrap mid-install. Instead we check $LASTEXITCODE / Test-Path after each
# native call and decide explicitly.

Set-Location $PSScriptRoot

# Separate our own -Reinstall switch from the args meant for uvicorn.
$passthru = @()
$reinstall = $false
foreach ($a in $args) {
  if ($a -eq "-Reinstall" -or $a -eq "--reinstall") { $reinstall = $true }
  else { $passthru += $a }
}

# 1. Locate a base Python: the `py` launcher is the Windows norm; fall back to python.
$basePy = if (Get-Command py -ErrorAction SilentlyContinue) { "py" }
          elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" }
          else { Write-Host "ERROR: No Python on PATH. Install Python 3.10+ from python.org and re-run."; exit 1 }

$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

# 2. Create the venv once. Verify success by the artifact it should produce, not by
#    exit code (see NOTE above — native exit handling is unreliable here).
if (-not (Test-Path $venvPy)) {
  Write-Host "* creating virtualenv (.venv) ..."
  & $basePy -m venv .venv
  if (-not (Test-Path $venvPy)) { Write-Host "ERROR: venv creation failed (is the 'venv' module available?)."; exit 1 }
}

# 3. Install deps on first run, when a core import is missing, or on -Reinstall.
#    The probe exits non-zero AND prints a traceback on a fresh venv; 2>$null drops
#    the text, and (with 'Stop' off) $LASTEXITCODE cleanly reports whether deps exist.
& $venvPy -c "import fastapi, uvicorn, pydantic" 2>$null
$depsOk = ($LASTEXITCODE -eq 0)
if ($reinstall -or -not $depsOk) {
  Write-Host "* installing requirements.txt ..."
  & $venvPy -m pip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: pip install failed (exit $LASTEXITCODE)."; exit 1 }
} else {
  Write-Host "* dependencies already present (pass -Reinstall to refresh)"
}

# 4. Launch. Default to :8000 when no uvicorn args are supplied.
if ($passthru.Count -eq 0) { $passthru = @("--port", "8000") }
Write-Host "* starting: uvicorn main:app $($passthru -join ' ')"
Write-Host "  health:   http://localhost:8000/health`n"
& $venvPy -m uvicorn main:app @passthru
exit $LASTEXITCODE
