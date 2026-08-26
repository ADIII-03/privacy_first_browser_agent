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
- **Backends:** classical CV core (always on) + WebGPU accelerator (self‑verified) + **neural stack ON by default** — `yolov8n-face` (union) + `tech4humans` YOLOv8s‑signature (neural‑only) via raw onnxruntime‑web (WebGPU→WASM), ~674 ms cold warm‑up. Legacy transformers.js YOLOS‑tiny retained as a fallback entry only.
- **Server:** FastAPI, `mock` planner default (zero deps); `vlm` adapter ready.
- **Eval scorecard** (`node eval/run_all.js`, on shipped code):

| # | Metric | Weight | Result | Test |
|---|---|:--:|---|:--:|
| 1 | Visual context accuracy | 25% | micro‑F1 **0.95**, recall **1.00**, IoU **0.93** | ✅ |
| 2 | PII precision/recall | 20% | F1 **0.99** (P 0.99 / R 1.00) | ✅ |
| 3 | Redaction precision | 20% | coverage‑recall **1.00**, box‑P 1.00 | ✅ |
| 4 | Client resource (proxy) | 20% | ≈**4,700 chars/ms**, p95 ≈2.7 ms | ✅ |
| 5 | End‑to‑end latency | 15% | `/plan` p50 ≈**16 ms** (mock) | ✅ |

> The scorecard is the **automated** harness (`run_all.js`) over synthetic labeled scenes — it exercises the classical CV core + fusion + policy (all **unchanged** by the neural work). The **neural** face + signature detectors run only in‑browser / via offline probes, so their accuracy is validated separately (§6) and **not yet folded into this scorecard** — tracked as a labeled real‑world set in §14. Real‑page testing also exposed a gap the synthetic scenes don't: the *classical* signature heuristic over‑fires badly on body text (33–84 false boxes/frame), which is exactly why signatures moved to **neural‑only** (§4, §6).

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
  - Test: ✅ `vision_eval.js` (faces P/R/F1 = 1.0; signatures R = 1.0 **on synthetic scenes**)
- [x] **Runtime fusion with the neural stack** (§6): FACES **union‑merge** classical + neural; SIGNATURES are **neural‑only** — while the signature model is loaded, `detect()` drops the classical signature boxes (gated on `visionNeural.covers(SIGNATURE)`). The classical signature code **stays** and still ships as the **fallback** when no model is loaded.
  - Why: real‑page testing showed the classical signature heuristic carpet‑bombs text (33–84 FP/frame) and localizes poorly; the neural model is high‑precision. The synthetic `vision_eval.js` (R = 1.0) doesn't surface this over‑firing — see §14.
  - Test: 🧪 in‑browser on real pages (Kohli / Turing wiki) — classical suppression + neural fire confirmed via the offscreen debug log

---

## 5. Perception — WebGPU accelerator

- [x] WGSL compute shader doing the **identical** per‑pixel classification
- [x] `_initGpu()` + `_gpuClassify()` (pack RGBA → dispatch → readback)
- [x] `_verifyGpu()` — 4‑pixel probe must match CPU output or silently fall back to CPU
- [x] CPU path is authoritative; `init()` always ends `ready:true`
  - Test: ⛔ WebGPU runtime not exercised in CI; math validated via identical CPU path (✅) + in‑browser self‑test (🧪)

---

## 6. Perception — Neural detectors (ONNX YOLO) + vendoring

- [x] `vision-neural.js` — refactored into a **multi‑model stack**: `ACTIVE_MODELS = ["yolov8n-face", "yolo-signature"]`, per‑model records in a `Map` (each loads + **fails independently**, fail‑open), `detect()` runs them **sequentially** on the shared offscreen frame, and a `covers(piiType)` API tells the classical layer which categories are handled neurally
- [x] **RAW onnxruntime‑web runtime** (`runtime:"onnx-yolo"`) — letterbox → NCHW → YOLO decode (`scoreIndex 4`) → NMS; handles both `[1,C,N]` and `[1,N,C]` heads; pre/post identical to the eval probes so Node and browser agree
- [x] **FACE — `yolov8n-face` (ACTIVE):** dedicated face detector, tight boxes, ~33–46 ms; **union‑merged** with the classical core. Validated by `eval/face_probe.js` + in‑browser (0.84–0.87 on real pages)
- [x] **SIGNATURE — `tech4humans/yolov8s-signature-detector` (ACTIVE, neural‑only):** Latin/Western handwritten‑signature detector, single‑class `[1,5,8400]` head (same decode as the face model); **replaces** the classical heuristic while loaded via the `covers(SIGNATURE)` drop. Validated by `eval/signature_probe.js` (~0.77–0.80 on Kohli's real sig, **0 FPs** on text) + in‑browser
  - ⚠️ **LICENSE: AGPL‑3.0** (Ultralytics‑derived weight) — **accepted for now**; revisit before any closed‑source distribution
- [x] `id_document` PII category plumbed end‑to‑end (protocol → policy → redaction) — **detector still TODO**
- [x] `tools/vendor-vision.mjs` — offline vendoring; face + signature vendor from a **`localSource`** (`eval/models/*.onnx`); `--check` integrity (ONNX/WASM magic bytes); Windows tar/path fixes
- [x] `eval/face_probe.js`, `eval/signature_probe.js`, `eval/show_boxes.js` — Node probes (onnxruntime‑node + sharp) that score any candidate weight the same way the browser path does before it's wired in
- [x] `docs/VENDORING.md` — install + swap‑model recipe
  - Test: ✅ probes runnable offline; 🧪 both models load + run in‑browser (popup vision panel, ~674 ms cold warm‑up on WebGPU)
- [~] **Weights are `.gitignore`'d** → not committed; a fresh clone must run `node tools/vendor-vision.mjs` (which copies from `eval/models/`, themselves local‑only). Packaging the weights for graders/teammates = open item ⛔
- [~] **Faint / small signatures missed** — e.g. Alan Turing's wiki sig (~0.07, below the 0.35 floor once the viewport downscales to 640); classical no longer masks this. Fix path = higher‑res capture / region‑upscale, **not** the classical noise ⛔
- [ ] **ID‑document** detector (MIDV‑500 fine‑tune or similar) — category ready, model TODO ⛔
- [ ] **OCR** for text baked into images (IDs, screenshots) — extends fusion; model TODO ⛔
- [ ] Legacy `Xenova/yolos-tiny` (transformers.js) kept as a **fallback REGISTRY entry only** — not in `ACTIVE_MODELS`

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
- [x] `popup.html` / `popup.js` — task input + **live privacy receipt** (detected/redacted + **per‑category breakdown**/screenshot‑sent/residual‑risk) + **on‑device vision panel** (active neural models, execution provider, cold warm‑up ms) + log
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
- [x] `face_probe.js`, `signature_probe.js`, `show_boxes.js` — offline **model** probes (onnxruntime‑node + sharp): measure a candidate weight's recall / precision / latency exactly as the browser path does, and draw the boxes for eyeballing
  - Test: ✅ e.g. `node eval/signature_probe.js --model <path> <img>` (needs `npm i onnxruntime-node sharp` in `eval/`)
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

- [x] ~~Dedicated face detector model~~ → **`yolov8n-face` shipped** (§6)
- [x] ~~Signature detector~~ → **`tech4humans` YOLOv8s shipped, neural‑only** (§6)
- [ ] **Labeled real‑world test set** for the neural stack (pages with & without sigs, varied sizes / scripts) → quantify face + signature precision/recall and fold into the scorecard
- [ ] **Higher‑res capture / region‑upscale** so faint sigs reach the 640 model large enough to score (recovers the Turing‑style miss)
- [ ] **Resolve AGPL** on the signature weight (accept project‑wide AGPL, or find a permissive / non‑Ultralytics detector)
- [ ] **ID‑document** detector (MIDV‑500) → add scene truth + redaction test
- [ ] **OCR** pass for text baked into images → extend fusion + tests
- [ ] Production vault (encrypted `chrome.storage` + consent prompt) → add unit tests
- [ ] Overlay‑based destructive confirmation (replace `window.confirm`) → manual + snapshot test
- [ ] Firefox background‑page vision host → port + verify vision parity
- [ ] CI pipeline running full eval scorecard on every PR

---

## 15. How to test (quick reference)

```bash
# Full scorecard (Metrics 1–5) — no model, no browser needed
node eval/run_all.js

# Neural stack: vendor the on‑device weights (face + signature), then probe them offline
node tools/vendor-vision.mjs                 # 1. vendor from eval/models/ (face ~12 MB + sig ~45 MB)
node tools/vendor-vision.mjs --check         #    verify artifacts present + integrity
cd eval && npm i onnxruntime-node sharp      # 2. Node runtime for the probes
node eval/face_probe.js models/yolov8n-face/model.onnx person.png
node eval/signature_probe.js --model ../extension/models/yolo-signature/model.onnx signature.png

# Server (mock) + latency
cd server && pip install -r requirements.txt && uvicorn main:app --port 8000
node eval/latency_bench.js

# Manual end‑to‑end: load extension/ unpacked in Chrome 121+, open demo/index.html, Run
```

---

_Last updated: 2026‑08‑26 · Branch `verify` — neural stack now **active by default**: `yolov8n-face` (union) + `tech4humans` YOLOv8s‑signature (neural‑only, replaces classical while loaded), validated in‑browser. Server residual‑PII 422 tripwire fixed. Pending PR._
