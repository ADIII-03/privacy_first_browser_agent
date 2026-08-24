# On-Device Visual Perception for Light-Weight Browser Agents

**Smart India Hackathon — Problem Statement 26171**

A privacy-preserving perception layer that lets a browser agent *see* and *act* on a
live web page **while guaranteeing that personally identifiable information never leaves
the device**. Perception and redaction run entirely in the browser; a stateless server
receives only a sanitized, structured description of the page and returns a *validated
action* — never free-reign code.

> Full rationale, threat model, algorithms and evaluation are in **[`DESIGN.md`](DESIGN.md)**
> (the production design document). A rendered before/after of the privacy filter is in
> **[`REDACTION_VISUAL.md`](REDACTION_VISUAL.md)** — open
> **[`demo/redaction-visual.html`](demo/redaction-visual.html)** in any browser for the
> interactive version. Step-by-step run & test instructions live in
> **[`RUNBOOK.md`](RUNBOOK.md)**. This README is the quick operational guide.

---

## The idea in one picture

```
        BROWSER (trusted)                          SERVER (untrusted)
 ┌───────────────────────────────────┐
 │ content script                    │   sanitized context (JSON)
 │  • enumerate interactable elements │  ──────────────────────────►  ┌──────────────┐
 │  • detect PII (DOM + regex+checksum)│   • origin-only URL           │  /plan        │
 │  • local secret vault (never sent) │   • tokenized labels          │  planner or   │
 │                                   │   • element geometry + IDs    │  VLM adapter  │
 │ offscreen document (WebGPU)        │   • redacted screenshot*      │  + security   │
 │  • on-device vision (faces/sig.)   │   • privacy receipt           │  sanitation   │
 │  • fuse signals → policy → redact  │                               └──────┬───────┘
 │  • Set-of-Marks numbered overlay   │        validated ActionPlan          │
 │                                   │  ◄───────────────────────────────────┘
 │ service worker                    │   {click|type|fill_local|…} by element ID
 │  • perceive → plan → act loop      │
 │  • validate every action, verify   │   * screenshot sent ONLY if policy allows;
 │    effect, detect loops, budget    │     withheld when vision can't run on an
 └───────────────────────────────────┘     image-bearing page (fail-closed)
```

**Design stance:** fail-closed privacy · DOM-primary / vision-secondary · closed-allowlist actions.

---

## Repository layout

```
privacy-browser-agent/
├── DESIGN.md                       # ← the production design document (start here)
├── RUNBOOK.md                      # step-by-step run & test instructions
├── REDACTION_VISUAL.md             # rendered before/after of the privacy filter
├── extension/                      # Chrome MV3 extension (perception + redaction + action)
│   ├── manifest.json
│   ├── lib/
│   │   ├── protocol.js             # shared enums: PII types, actions, redaction methods
│   │   ├── privacy/
│   │   │   ├── pii-regex.js        # checksum-validated detector (Luhn/Verhoeff/PAN/entropy)
│   │   │   ├── dom-detector.js     # interactable + field-sensitivity + live ID index
│   │   │   ├── fusion.js           # union-biased multi-signal fusion (noisy-OR, IoU merge)
│   │   │   └── policy.js           # fail-closed policy engine + privacy receipt
│   │   ├── redactor.js             # offscreen canvas: mask + Set-of-Marks overlay
│   │   ├── dom-perception.js       # assembles the sanitized context payload
│   │   └── vision/
│   │       ├── vision-detector.js  # on-device CV detector: WebGPU shader + CPU fallback
│   │       └── vision-neural.js    # optional transformers.js/ONNX hook (vendored, off by default)
│   ├── content/content.js          # action validation + execution + local vault
│   ├── background/service-worker.js# perceive→plan→act orchestration
│   ├── offscreen/                  # offscreen document (vision + compositing host)
│   └── popup/                      # privacy-receipt dashboard
├── server/                         # FastAPI reasoning tier (stateless)
│   ├── schemas.py                  # Pydantic v2 schema = the privacy contract
│   ├── security.py                 # plan sanitation (destructive / sensitive / caps)
│   ├── planner.py                  # mock heuristic planner (default — no model needed)
│   ├── vlm_adapter.py              # OpenAI-compatible VLM client (Qwen2.5-VL, etc.)
│   ├── main.py                     # /health, /plan, residual-PII tripwire
│   └── prompts/system_prompt.txt   # injection-resistant, redaction-aware
├── demo/                           # self-contained synthetic target page + walkthrough
│   ├── index.html                  # gov-form: typed fields, valid-checksum text, faces, signature
│   ├── redaction-visual.html       # interactive before/after of the redaction pipeline
│   └── README.md                   # end-to-end task instructions
└── eval/                           # scores the SHIPPED code (no eval-only reimplementation)
    ├── fixtures/screen_truth.js    # synthetic labeled screen-truth for Metric #1
    ├── vision_eval.js              # Metric #1 — visual context accuracy on the shipped detector
    └── make_dataset.js  pii_eval.js  redaction_eval.js  latency_bench.js  run_all.js
```

---

## Quick start

> The full, copy-pasteable run & test guide (Windows + macOS/Linux, troubleshooting,
> smoke tests) is in **[`RUNBOOK.md`](RUNBOOK.md)**. The essentials:

### 1. Reasoning server (mock mode — no model required)

```bash
cd server
pip install -r requirements.txt
uvicorn main:app --port 8000        # http://localhost:8000/health
```

The default `PBA_BACKEND=mock` uses a deterministic heuristic planner, so the whole
loop runs with **zero external dependencies**. To attach a real vision-language model:

```bash
export PBA_BACKEND=vlm
export PBA_VLM_BASE_URL=http://localhost:8001/v1     # e.g. a vLLM server
export PBA_VLM_MODEL=Qwen2.5-VL-7B-Instruct
uvicorn main:app --port 8000
```

### 2. Extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open any page, click the extension, type a task (e.g. *“fill in the application”*), **Run**.
4. The popup shows the **privacy receipt**: what was detected, what was redacted, and
   whether the screenshot was allowed to leave the device.

MV3, no host permissions by default; `activeTab` scoping means the agent only perceives
the tab you point it at. Requires Chrome/Chromium **121+** (WebGPU + offscreen document).

### 3. Try it end-to-end on the demo page

```
open demo/index.html      # in the same Chrome profile (file:// is fine)
```

`demo/index.html` is a self-contained synthetic government form that plants **every**
signal the filter must catch — `type=password` / `autocomplete=cc-number` / `email` /
`tel` fields, visible **checksum-valid** Aadhaar/PAN/card/phone/OTP/IP text, two
skin-toned `<img>` **faces**, and a handwritten `<canvas>` **signature**. Point the
agent at it with a task like *“fill in my email and phone from my profile, then submit
the application”* and watch the privacy receipt. Full walkthrough: [`demo/README.md`](demo/README.md).

### 4. Evaluation scorecard (Node 18+)

```bash
node eval/run_all.js
```

Regenerates the labeled dataset, runs every evaluator, and prints a scorecard mapped to
the five official metrics.

---

## Measured results (on the shipped code)

| # | Official metric | Weight | Result |
|---|-----------------|:------:|--------|
| 1 | Visual context accuracy | 25% | **micro-F1 0.95** (recall **1.00**, mean IoU **0.93**) over 11 labeled screen-truth scenes; faces P/R/F1 = 1.00; grounding-integrity OK |
| 2 | PII detection precision/recall | 20% | **F1 0.99** (P 0.99 / R 1.00) over 101 samples incl. checksum-invalid hard negatives |
| 3 | Redaction precision | 20% | **coverage-recall 1.00**, box-precision 1.00, mean IoU 0.70, over-redaction 0.28 |
| 4 | Client resource use (proxy) | 20% | **≈4,700 chars/ms** local scan, p50 ≈1.4 ms / p95 ≈2.7 ms |
| 5 | End-to-end latency | 15% | server `/plan` **p50 ≈16 ms** (mock backend, n=30) |

Run `node eval/run_all.js` to reproduce all five. The benchmark loads the **same**
detector modules that run in the browser — Metric #1 scores the exact
`detectSensitiveRegions` core the extension ships — so these numbers describe
production behavior, with no separate eval implementation to drift.

---

## Why this design

- **On-device vision for the pixels the DOM can't explain.** Faces and handwritten
  signatures exist only as pixels. A dependency-free CV core (YCbCr skin + dark-ink
  geometry, coarse-grid connected components) runs on a **WebGPU compute shader with a
  CPU fallback** — and the GPU path is trusted only after a runtime self-test matches
  the CPU output, so it degrades safely. An optional `transformers.js`/ONNX neural hook
  drops in when weights are vendored. The screenshot is withheld entirely if vision
  can't run on an image-bearing page.
- **Fail-closed privacy.** Recall is treated as a safety property (“when uncertain,
  redact”). High-risk categories are masked even below the confidence threshold, and if
  vision is unavailable on a page with images, the screenshot is withheld entirely.
- **Correctness through checksums.** Aadhaar (Verhoeff), cards (Luhn) and PAN (holder-type
  character) are *validated*, not shape-matched — which is how precision stays at 0.99
  while recall stays at 1.00 against deliberate hard negatives.
- **Prompt-injection defense.** Page text is untrusted *data*, never instructions. The
  model can only emit actions from a closed allowlist; the client and a server-side
  validator independently sanitize every plan.
- **Robust action loop.** Element-ID bridge + Set-of-Marks prompting, action validation
  against the live DOM, verify-after-act, loop detection, step budgets, destructive-action
  confirmation, and a local secret vault the model never sees.

See [`DESIGN.md`](DESIGN.md) for the complete treatment.

---

## Browser support

| Browser | Status | Notes |
|---|---|---|
| **Chrome / Chromium / Edge 121+** | **Verified target** | MV3 service worker + **offscreen document** host the WebGPU/canvas work; `minimum_chrome_version: 121`. |
| **Firefox** | **Shimmed & documented, not verified** | Entry points use `const ext = globalThis.browser \|\| globalThis.chrome`, so the WebExtension APIs are addressed uniformly. Firefox does **not** implement `chrome.offscreen`; the vision/compositing host must move to an extension **background page** there. The vision core itself is portable (plain WebGPU/CPU) — the port is host plumbing, not algorithm work. We don't claim it runs on Firefox until that fallback is built and tested. |

The Node-scored detector core, the checksum PII logic, fusion, policy and redaction
geometry are browser-independent and covered by the eval regardless of host.

---

## Status & honest gaps

- Detector (DOM + checksum-text + **on-device vision**), fusion, policy, redaction
  geometry and the full action-loop logic are **implemented and benchmarked**. All five
  metrics — including **#1 (visual context)** and **#5 (latency)** — are scored by
  `node eval/run_all.js` on the shipped code.
- The on-device **vision detector** (`vision/vision-detector.js`) ships a dependency-free
  CV core with a **WebGPU compute-shader path and a CPU fallback**. The GPU path is
  trusted only after a runtime probe reproduces the CPU classification, so it fails safe.
  An optional neural hook (`vision/vision-neural.js`, transformers.js/ONNX) is
  code-complete and activates once weights are vendored (the extension CSP forbids CDN
  loads, so this is intentionally off by default).
- **In-browser runtime of the WebGPU shader and `chrome.*` plumbing is not exercised in
  this environment.** It is covered by the Node-tested CPU core (identical algorithm),
  the GPU self-verification probe, syntax/byte checks, and the manual `demo/` page. We do
  not claim in-browser runtime numbers we didn't observe.
- **Firefox is shimmed and documented, not verified** — see *Browser support* above.
- Server decision logic is verified by standalone logic and a live `/plan` run (Metric
  #5); pointing at a real VLM needs `PBA_BACKEND=vlm` + an OpenAI-compatible endpoint.
