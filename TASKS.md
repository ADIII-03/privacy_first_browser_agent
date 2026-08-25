# Project Tasks & Progress — Privacy‑Preserving Browser Agent (SIH 26171)

A living checklist of **every build step**, its **testing status**, what is **done**, and what is
**still to add / test**. Kept from project start → now → future.

**Legend**

| Mark | Meaning |
|---|---|
| `[x]` | Done (implemented in shipped code) |
| `[~]` | Partial / stubbed / works but not production‑grade |
| `[ ]` | Not started / planned |
| ✅ | Covered by an automated test (`node eval/…`) |
| 🧪 | Verified manually only (demo page / in‑browser) |
| ⛔ | Not yet tested — known gap |

---

## 0. Status snapshot (now)

- **Pipeline:** detect → fuse → decide → redact → reason → act — **all stages implemented on‑device.**
- **Backends:** classical CV core (always on) + WebGPU accelerator (self‑verified) + optional YOLOS‑tiny/ONNX neural hook (vendored, off by default).
- **Server:** FastAPI, `mock` planner default (zero deps); `vlm` adapter ready.
- **Eval scorecard** (`node eval/run_all.js`, on shipped code):

| # | Metric | Weight | Result | Test |
|---|---|:--:|---|:--:|
| 1 | Visual context accuracy | 25% | micro‑F1 **0.95**, recall **1.00**, IoU **0.93** | ✅ |
| 2 | PII precision/recall | 20% | F1 **0.99** (P 0.99 / R 1.00) | ✅ |
| 3 | Redaction precision | 20% | coverage‑recall **1.00**, box‑P 1.00 | ✅ |
| 4 | Client resource (proxy) | 20% | ≈**4,700 chars/ms**, p95 ≈2.7 ms | ✅ |
| 5 | End‑to‑end latency | 15% | `/plan` p50 ≈**16 ms** (mock) | ✅ |

---

## 1. Foundations & shared contract

- [x] Repo scaffolding (`extension/`, `server/`, `eval/`, `demo/`, `docs/`, `tools/`)
- [x] `extension/lib/protocol.js` — single source of truth: `PII`, `REDACT`, `ACTIONS`, `STATUS`, `VALUE_STATE`, `DESTRUCTIVE_HINTS`, `newSessionId()`
  - Test: 🧪 loaded first in every context; enums mirrored server‑side (see §7)
- [x] `extension/manifest.json` — MV3, `activeTab`+`offscreen`, CSP `script-src 'self' 'wasm-unsafe-eval'`, COOP/COEP for WebGPU
  - Test: ⛔ in‑browser load verified manually only (not in CI)

---

## 2. Perception — DOM / ARIA signals

- [x] `dom-detector.js` → `scanDOM()`: interactable graph + stable per‑step integer IDs + bbox
- [x] `fieldSensitivity()` — `type=password` (0.99), sensitive `autocomplete` (0.9), `email`/`tel` (0.85), name/id heuristics (0.7)
- [x] `accessibleLabel()`, `roleOf()`, `isVisible()`, live `_index` for the executor
- [x] Visible text‑run extraction (TreeWalker) with bboxes → feeds regex scanner
  - Test: ✅ grounding‑integrity check in `vision_eval.js`; 🧪 live on `demo/index.html`

---

## 3. Perception — Text PII (checksum‑validated)

- [x] `pii-regex.js` → `scan()` with specificity ordering + claimed‑range de‑overlap
- [x] Checksums: **Luhn** (cards), **Verhoeff** (Aadhaar), **PAN** holder‑type char, **Shannon entropy** gate (API keys)
- [x] Detectors: Aadhaar, PAN, card, UPI‑VPA, email, phone, OTP (context‑gated), API key, IPv4
  - Test: ✅ `pii_eval.js` — F1 0.99 over 101 samples **incl. checksum‑invalid hard negatives**

---

## 4. Perception — On‑device vision (classical CV core)

- [x] `vision-detector.js` → `detectSensitiveRegions()` pure RGBA→boxes core (what ships == what's scored)
- [x] FACE: YCbCr skin + RGB daylight rule → cell grid → 8‑connected components → geometry priors
- [x] SIGNATURE: dark‑ink‑on‑light + horizontal morphological closing (`dilateXInk`) → wide/short/sparse geometry; dark‑theme suppression
- [x] Device‑px → CSS‑px conversion (÷ dpr) so boxes fuse with DOM signals
  - Test: ✅ `vision_eval.js` (faces P/R/F1 = 1.0; signatures R = 1.0)

---

## 5. Perception — WebGPU accelerator

- [x] WGSL compute shader doing the **identical** per‑pixel classification
- [x] `_initGpu()` + `_gpuClassify()` (pack RGBA → dispatch → readback)
- [x] `_verifyGpu()` — 4‑pixel probe must match CPU output or silently fall back to CPU
- [x] CPU path is authoritative; `init()` always ends `ready:true`
  - Test: ⛔ WebGPU runtime not exercised in CI; math validated via identical CPU path (✅) + in‑browser self‑test (🧪)

---

## 6. Perception — Neural hook (YOLOS‑tiny / ONNX) + vendoring

- [x] `vision-neural.js` — transformers.js/ONNX Runtime Web adapter; **no‑op until weights vendored**; unions with (never replaces) CV core
- [x] `REGISTRY` with `Xenova/yolos-tiny` (q8, WebGPU→WASM fallback, `minScore 0.5`), `person → FACE` mapping
- [x] `init()` + warm‑up frame (hides cold‑start) + `detect()` returning device‑px boxes
- [x] `id_document` PII category plumbed end‑to‑end (protocol → policy → redaction)
- [x] `tools/vendor-vision.mjs` — one‑command offline vendoring (pinned transformers 4.2.0 + onnxruntime‑web); `--check` integrity (ONNX/WASM magic bytes); Windows tar/path fixes
- [x] `docs/VENDORING.md` — install, swap‑model recipe, candidates (BlazeFace, YOLOv8‑face, MIDV‑500)
  - Test: ✅ `neural_smoke.js` proves vendored stack **loads + runs offline** + well‑formed output (requires `vendor-vision.mjs` + `npm i @huggingface/transformers`)
- [~] **Placeholder model only** — YOLOS is COCO (no `face` class); `person→FACE` is coarse/over‑broad
- [ ] Swap in dedicated **face** detector (BlazeFace / YOLOv8‑face ONNX) — plumbing ready, model TODO ⛔
- [ ] Add **ID‑document** detector (MIDV‑500 fine‑tune) — category ready, model TODO ⛔

---

## 7. Fusion, policy, redaction, packaging

- [x] `fusion.js` → `fuse()`: union‑biased, IoU>0.3 merge, **noisy‑OR** confidence, text→pixel `sliceBox()`
  - Test: ✅ exercised by `redaction_eval.js`
- [x] `policy.js` → `decide()`: per‑category method+minConf, **fail‑closed** (high‑risk redacts below threshold; no‑vision‑on‑images ⇒ no screenshot), privacy receipt
  - Test: ✅ `redaction_eval.js` — coverage‑recall 1.00
- [x] `redactor.js` → `compose()` (blackout/tokenize/pixelate/blur on offscreen canvas) + **Set‑of‑Marks** overlay + `tokenizeText()` (dual‑modality redaction)
  - Test: 🧪 `demo/redaction-visual.html`; geometry ✅ in `redaction_eval.js`
- [x] `dom-perception.js` → `buildContext()`: assembles v1 sanitized payload (origin‑only URL, tokenized labels, value_state enum, redaction plan, receipt)
  - Test: ✅ shape validated by server schema (§9)

---

## 8. Action loop (trusted browser side)

- [x] `content.js` — `PERCEIVE` / `EXECUTE` / `VIEWPORT` / `PING` bridge
- [x] `validate()` — closed allowlist, ID‑must‑exist, no literal type into sensitive field, cross‑origin nav block
- [x] `execute()` — click/type/`fill_local`/select/scroll/…; React‑safe `setNativeValue()`; verify‑after‑act snapshot
- [x] **Local vault** (email/phone/name) — referenced by key via `fill_local`, never in payload
- [x] Destructive‑intent confirmation (`window.confirm`)
  - Test: 🧪 `demo/index.html` end‑to‑end
- [~] Vault is demo values in code — production: `chrome.storage` + OS keychain + per‑use consent ⛔
- [~] Confirmation uses `window.confirm` — replace with overlay UI (`overlay.css` ready) ⛔

---

## 9. Orchestrator, offscreen, popup

- [x] `service-worker.js` — perceive→plan→act loop; screenshot capture; **loop detection** (repeated signature, no state change); **step budget** (`maxSteps`); offscreen feature‑detect; text‑only fail‑closed downgrade
  - Test: ⛔ in‑browser only (MV3 plumbing not in CI); 🧪 demo
- [x] `offscreen.js` / `offscreen.html` — VISION + COMPOSE host (canvas + WebGPU, off main thread)
  - Test: ⛔ Chromium‑only, manual
- [x] `popup.html` / `popup.js` — task input + **live privacy receipt** (detected/redacted/screenshot‑sent/residual‑risk) + log
  - Test: 🧪 manual

---

## 10. Server (stateless reasoning tier)

- [x] `schemas.py` — Pydantic v2 security boundary; `SanitizedContext`/`ActionPlan`; `Literal` action vocab; token‑must‑be‑`<PLACEHOLDER>`; origin‑only validator
- [x] `security.py` → `sanitize_plan()` — allowlist clamp, target‑must‑exist, force `fill_local` on sensitive, destructive → `requires_confirmation`, `MAX_ACTIONS_PER_STEP`
- [x] `main.py` — `GET /health`, `POST /plan`, **residual‑PII tripwire** → 422 fail‑closed; CORS
- [x] `planner.py` — deterministic `mock` backend (fill sensitive → click primary → scroll → done)
- [x] `vlm_adapter.py` — OpenAI‑compatible VLM client (Qwen2.5‑VL etc.), JSON‑forced, fail‑safe fallback to mock
- [x] `prompts/system_prompt.txt` — injection‑resistant, page‑text‑as‑data, closed action schema
  - Test: ✅ live `/plan` in `latency_bench.js` (p50 ≈16 ms); ⛔ real VLM path needs live endpoint

---

## 11. Evaluation harness

- [x] `run_all.js` — regenerates dataset, runs all evaluators, prints scorecard
- [x] `make_dataset.js` — labeled PII dataset (incl. hard negatives)
- [x] `fixtures/screen_truth.js` — synthetic labeled scenes + grounding sample
- [x] `vision_eval.js` (#1), `pii_eval.js` (#2), `redaction_eval.js` (#3), `latency_bench.js` (#4/#5), `neural_smoke.js` (neural)
  - Test: ✅ all runnable via `node eval/run_all.js` (Node 18+)
- [ ] CI wiring (GitHub Actions) to run `run_all.js` on push ⛔

---

## 12. Demo & docs

- [x] `demo/index.html` — synthetic gov form planting every signal (typed fields, checksum‑valid Aadhaar/PAN/card/phone/OTP/IP, 2 faces, canvas signature)
- [x] `demo/redaction-visual.html` — interactive before/after
- [x] `demo/vision-selftest.html` — in‑browser detector self‑test
- [x] `README.md`, `DESIGN.md`, `RUNBOOK.md`, `REDACTION_VISUAL.md`, `docs/VENDORING.md`
  - Test: 🧪 manual walkthrough

---

## 13. Cross‑cutting / known gaps (to verify)

- [ ] **In‑browser WebGPU + `chrome.*` runtime** — not exercised in CI (covered by CPU‑parity + self‑test + manual demo) ⛔
- [ ] **Firefox** — shimmed & documented, **not verified**; needs offscreen→background‑page fallback for vision ⛔
- [ ] Real **VLM** backend run (`PBA_BACKEND=vlm` + OpenAI‑compatible endpoint) ⛔
- [ ] Multi‑frame / cross‑origin iframe perception (`all_frames:false` today) ⛔

---

## 14. Future work — add & test

- [ ] Dedicated face detector model → drop into `REGISTRY`, re‑run `neural_smoke.js` + add accuracy metric
- [ ] ID‑document detector (MIDV‑500) → add scene truth + redaction test
- [ ] Production vault (encrypted `chrome.storage` + consent prompt) → add unit tests
- [ ] Overlay‑based destructive confirmation (replace `window.confirm`) → manual + snapshot test
- [ ] Firefox background‑page vision host → port + verify vision parity
- [ ] CI pipeline running full eval scorecard on every PR
- [ ] Optional: OCR pass for text baked into images → extend fusion + tests

---

## 15. How to test (quick reference)

```bash
# Full scorecard (Metrics 1–5) — no model, no browser needed
node eval/run_all.js

# Neural stack executes offline on vendored YOLOS‑tiny weights
node tools/vendor-vision.mjs                 # 1. vendor (once, ~10–30 MB)
npm install --prefix eval @huggingface/transformers@4.2.0   # 2. Node runtime
node eval/neural_smoke.js                    # 3. smoke test

# Verify vendored artifacts present + integrity
node tools/vendor-vision.mjs --check

# Server (mock) + latency
cd server && pip install -r requirements.txt && uvicorn main:app --port 8000
node eval/latency_bench.js

# Manual end‑to‑end: load extension/ unpacked in Chrome 121+, open demo/index.html, Run
```

---

_Last updated: 2026‑08‑25 · Reflects shipped code at branch `main` (through “edge cases fixed”, neural‑vision vendoring + `id_document`)._
