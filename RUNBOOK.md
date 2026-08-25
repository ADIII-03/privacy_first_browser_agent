# RUNBOOK — running & testing the Privacy Browser Agent

Everything you need to run the system and reproduce the evaluation. For the demo and all
five metrics you need **no configuration at all** — the server defaults to an offline
mock planner.

- **What the pieces are:** a Chrome extension (perception + redaction + action, runs in
  the browser), a stateless FastAPI reasoning server (returns *validated actions*, never
  sees raw PII), and a Node evaluation harness (scores the shipped code).
- **Design & rationale:** [`DESIGN.md`](DESIGN.md) · **Before/after visual:** [`REDACTION_VISUAL.md`](REDACTION_VISUAL.md) · **Demo walkthrough:** [`demo/README.md`](demo/README.md)

---

## 0. Environment variables — what you actually need

**For the demo and all evaluation metrics: none.** `PBA_BACKEND` defaults to `mock`, so
the whole loop runs offline. Env vars only matter if you swap the mock planner for a real
vision-language model.

| Variable | Needed when | Default | Purpose |
|---|---|---|---|
| `PBA_BACKEND` | never required | `mock` | `mock` (heuristic, offline) or `vlm` / `auto` (routed chain, see below) |
| `PORT` | only with `python main.py` | `8000` | server port (ignored when you pass `uvicorn --port`) |
| `PBA_VLM_ROUTES` | multi-endpoint setups | *(unset)* | JSON list of OpenAI-compatible endpoints tried **in order**, with 60 s cooldown failover — see below |
| `PBA_VLM_BASE_URL` | single-endpoint `vlm` | `http://localhost:8001/v1` | any OpenAI-compatible endpoint (vLLM, SGLang, Ollama, llama-server) |
| `PBA_VLM_MODEL` | single-endpoint `vlm` | `Qwen/Qwen2.5-VL-7B-Instruct` | model name to request |
| `PBA_VLM_API_KEY` | remote endpoints | `not-needed-for-local` | API key for the legacy single endpoint |
| `PBA_VLM_TIMEOUT_S` | slow links | `30` | per-request HTTP timeout |
| `PBA_VLM_COOLDOWN_S` | flaky primaries | `60` | how long a failed route is skipped |

### Model profiles & the route chain

The adapter auto-selects a **profile** from the model name:

- **`json`** — generic instruct VLMs (Qwen2.5-VL, InternVL, …). Closed-vocabulary
  JSON action contract.
- **`uitars`** — ByteDance UI-TARS-1.x models. Parses the native
  `Thought/Action: click(x,y)` DSL and **snaps normalized coordinates to the nearest
  element id**, so the client keeps executing by id. A `type` aimed at a sensitive
  field is converted to `fill_local`, so raw values never cross the network.

Single endpoint (legacy, unchanged):

```bash
export PBA_BACKEND=vlm
export PBA_VLM_BASE_URL=http://localhost:8001/v1     # your vLLM / Ollama / llama-server
export PBA_VLM_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
```

Routed chain — cloud first for speed, local as offline fallback (ISRO story):

```bash
export PBA_BACKEND=auto
export OPENROUTER_API_KEY=sk-or-...
export PBA_VLM_ROUTES='[
 {"name":"openrouter","base_url":"https://openrouter.ai/api/v1",
  "model":"bytedance/ui-tars-1.5-7b","api_key_env":"OPENROUTER_API_KEY"},
 {"name":"local-vllm","base_url":"http://localhost:8001/v1",
  "model":"Qwen/Qwen2.5-VL-7B-Instruct"}
]'
```

A dead/unreachable route is skipped after its first failure (cooldown), and if every
route fails the deterministic mock planner answers so a live demo never dies mid-task.
`GET /health` reports the active backend and each route's health.

Verify the reasoning tier without a model or GPU:

```bash
python selftest.py    # parser units + HTTP layer + failover, all offline
```

There is no `.env` file — the code reads `os.environ` directly, so you set these in the
shell (or leave them unset).

## Prerequisites

- **Python 3.9+** — reasoning server
- **Node 18+** — evaluation harness
- **Chrome / Chromium / Edge 121+** — extension (needs WebGPU + the offscreen document)

---

## 1. Reasoning server

**Fastest — one command** (restores the exact environment from `uv.lock` via [uv](https://docs.astral.sh/uv/), starts uvicorn; safe to re-run — only the first run syncs). No uv? The scripts fall back to plain venv + pip automatically.

| OS | From the `server/` folder |
|---|---|
| Windows (PowerShell) | `.\run.ps1` |
| macOS / Linux | `bash run.sh` |

Extra args pass straight through to uvicorn (e.g. `.\run.ps1 --port 9000`); force a dependency refresh with `-Reinstall` (PowerShell) or `PBA_REINSTALL=1` (bash). If PowerShell refuses to run the script (execution policy), use `powershell -ExecutionPolicy Bypass -File run.ps1`.

Run the offline verification suite the same way: `uv run python selftest.py` (or `.venv\Scripts\python selftest.py`).

Manual equivalent (uv):

```bash
cd server
uv sync            # creates .venv from uv.lock (add --reinstall to refresh)
uv run uvicorn main:app --port 8000
```

<details><summary><b>Or do it step by step without uv</b> (same result, manual)</summary>

**Windows (PowerShell):**

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt   # mirror of pyproject.toml for non-uv setups
python -m uvicorn main:app --port 8000
```

**macOS / Linux (bash):**

```bash
cd server
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt   # mirror of pyproject.toml for non-uv setups
python -m uvicorn main:app --port 8000
```

</details>

Leave it running. It's healthy when `http://localhost:8000/health` returns:

```json
{"ok": true, "backend": "mock", "protocol": "1.0"}
```

> **PowerShell execution-policy error on `Activate.ps1`?** Skip activation and call the
> venv Python directly: `.\.venv\Scripts\python -m uvicorn main:app --port 8000`
> (and `.\.venv\Scripts\python -m pip install -r requirements.txt` to install).

---

## 2. Evaluation harness — proves the metrics

No install, no browser. From the **repo root**, in a second terminal:

```bash
node eval/run_all.js
```

This prints the full SIH 26171 scorecard (#1–#5). Expected shape:

```
1. Visual context accuracy    25%   F1=0.95 R=1.00 meanIoU=0.93 (11 scenes, grounding OK)
2. PII detection prec/recall  20%   P=0.99 R=1.00 F1=0.99
3. Redaction precision        20%   coverage=1 boxP=1 IoU=0.7
4. Client resource use (proxy)20%   ~4,700 chars/ms local scan
5. End-to-end latency         15%   server /plan p50 ~16ms
```

- **Metric #5 requires the server from step 1** to be running on port 8000. Metrics
  #1–#4 run standalone.
- Score just the on-device vision model (Metric #1): `node eval/vision_eval.js`
- The run also exercises `/plan` end-to-end and the **422 residual-PII tripwire**, so
  this one command is the best single "test all of it."

---

## 3. Extension + demo — the actual browser experience (manual)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open [`demo/index.html`](demo/index.html) in that same Chrome profile (double-click,
   or `file://…/demo/index.html`).
4. Click the extension icon. The popup's **Server** field defaults to
   `http://localhost:8000` — change it there if you ran the server on a different port.
5. Enter a task, e.g. *“fill in my email and phone from my profile, then submit the
   application”*, and click **Run**.
6. Watch the **privacy receipt** in the popup: what was detected, what was redacted, and
   whether the (redacted) screenshot was allowed to leave the device.

The demo page deliberately plants every signal the filter must catch — typed sensitive
fields, checksum-valid Aadhaar/PAN/card text, two `<img>` faces, and a `<canvas>`
signature. Full walkthrough: [`demo/README.md`](demo/README.md).

> **Browser runtime note.** The in-browser WebGPU shader and `chrome.*` plumbing are
> verified by hand on the demo page; the CPU vision core (identical algorithm) is what
> the Node evaluator scores. Firefox is shimmed and documented but not verified — see the
> README "Browser support" section.

---

## 4. Before/after visual — zero setup

Open [`demo/redaction-visual.html`](demo/redaction-visual.html) in any browser. No server,
no extension — it's a self-contained explainer of the page-you-see vs. the-server-receives.

---

## 5. Optional — attach a real VLM instead of the mock

**Windows (PowerShell):**

```powershell
.\.venv\Scripts\python -m pip install openai
$env:PBA_BACKEND = "vlm"
$env:PBA_VLM_BASE_URL = "http://localhost:8001/v1"     # your local vLLM / Ollama / LM Studio
$env:PBA_VLM_MODEL = "Qwen/Qwen2.5-VL-7B-Instruct"
python -m uvicorn main:app --port 8000
```

**macOS / Linux (bash):**

```bash
pip install openai
export PBA_BACKEND=vlm
export PBA_VLM_BASE_URL=http://localhost:8001/v1
export PBA_VLM_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
python -m uvicorn main:app --port 8000
```

If the model call fails for any reason, the server **falls back to the mock planner**
rather than crashing, so the loop never breaks.

---

## Smoke test (optional — reproduces the hands-on verification)

On Windows PowerShell use `curl.exe` (bare `curl` is a different alias there); on
macOS/Linux use `curl`.

```powershell
# 1. liveness
curl.exe http://localhost:8000/health

# 2. clean context -> HTTP 200 with a fill_local plan (value sourced on the client, never sent)
curl.exe -X POST http://localhost:8000/plan -H "Content-Type: application/json" `
  -d '{\"session_id\":\"t1\",\"step\":0,\"task\":\"fill in the form and submit\",\"viewport\":{\"w\":1280,\"h\":720}}'

# 3. raw email smuggled in -> HTTP 422 residual_pii_detected (server fails closed)
curl.exe -X POST http://localhost:8000/plan -H "Content-Type: application/json" `
  -d '{\"session_id\":\"t2\",\"step\":0,\"task\":\"email the receipt to a@b.com\",\"viewport\":{\"w\":1280,\"h\":720}}'
```

| Call | Expected |
|---|---|
| `/health` | `{"ok":true,"backend":"mock","protocol":"1.0"}` |
| clean `/plan` | `200` — `actions:[{"type":"fill_local","source":"email",…}]` |
| leaky `/plan` | `422` — `{"error":"residual_pii_detected","kind":"email","location":"task"}` |

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `error while attempting to bind on ('127.0.0.1', 8000)` | Port already in use — a server is already running, or pick another port with `--port 8001` and set the same URL in the extension popup. |
| Metric #5 missing / errors in `run_all.js` | The server isn't running on port 8000. Start step 1 first. |
| `Activate.ps1 cannot be loaded` (PowerShell) | Execution policy — call `.\.venv\Scripts\python -m …` directly (see step 1 note). |
| Extension can't reach the server | Check the **Server** URL in the popup matches where uvicorn is listening; the server allows all origins by default. |
| `ModuleNotFoundError: openai` | Only needed for `PBA_BACKEND=vlm`; `pip install openai`. Mock mode needs nothing extra. |
