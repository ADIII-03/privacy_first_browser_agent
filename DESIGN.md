# DESIGN — On-Device Visual Perception for Light-Weight Browser Agents

**Smart India Hackathon · Problem Statement 26171**

This is the production design document for the Privacy-Preserving Browser Agent. It
covers the rationale, threat model, algorithms, the on-device vision pipeline, the
sanitized client↔server protocol, the hardened action loop, and the evaluation
methodology behind every number in the README scorecard.

The guiding invariant, stated once:

> **Raw personally identifiable information — pixels or text — never leaves the
> device.** Everything that could identify the user is detected, decided upon, and
> redacted *inside the browser*. The server sees only a sanitized, structured,
> tokenized description of the page and returns only a *validated action*.

---

## 1. Problem and goals

A useful browser agent must *see* a page (to handle canvases, images, signatures,
maps, anything the DOM doesn't spell out) and *act* on it. The naïve implementation
ships a screenshot to a cloud VLM — which means the user's Aadhaar card, face,
bank details and passwords leave their machine. That is unacceptable for the
citizen-facing government workflows this problem statement targets.

Goals, in priority order:

1. **Privacy as a safety property.** A missed piece of PII is a *leak*, not just a
   metric regression. The system is designed to fail *closed*: when uncertain, it
   redacts; when it cannot see, it withholds.
2. **On-device perception.** Vision and PII detection run in the browser (WebGPU/CPU),
   not on a server.
3. **Genuine utility.** The agent completes real multi-step tasks (fill a form, submit
   an application) under a closed action allowlist.
4. **Light-weight.** Runs on a normal laptop with no discrete GPU required (CPU
   fallback everywhere; WebGPU is an accelerator, never a dependency).
5. **Measurable.** Every claim is scored on the *shipped* code, not a re-implementation.

---

## 2. Threat model and trust boundaries

| Party | Trust | Assumption |
|---|---|---|
| The web page | **Untrusted** | Page text may contain prompt-injection; page DOM may be adversarial. |
| The extension (browser side) | **Trusted** | Runs in the user's browser; this is where privacy is enforced. |
| The reasoning server / VLM | **Untrusted with data, trusted for suggestions** | May be a third-party/cloud model. It must never receive raw PII, and its output is treated as an *untrusted suggestion* that the client re-validates. |
| The network | **Untrusted** | Only sanitized context transits it. |

Two independent consequences drive the architecture:

- **The server is untrusted with data** → all redaction happens client-side, *before*
  transmission, and the server additionally runs a residual-PII **tripwire** that
  fails closed (HTTP 422) if anything identifier-shaped slips through.
- **The server's output is untrusted** → every returned action is checked against a
  fixed allowlist and must reference an element ID that existed in the context we just
  sent; destructive intent is gated by a human click *in the client*, regardless of
  what the server says.

This is a **privacy firewall**, not merely a privacy filter: enforcement exists on
both sides of the boundary and neither side trusts the other with what it shouldn't have.

---

## 3. Architecture overview

```
        BROWSER (trusted)                                 SERVER (untrusted)
 ┌──────────────────────────────────────┐
 │ content script (isolated world)       │   SanitizedContext (JSON)
 │  • enumerate interactable elements     │  ──────────────────────────►  ┌───────────────┐
 │  • DOM + regex+checksum PII detection   │   • origin-only URL           │ POST /plan     │
 │  • local secret vault (never sent)     │   • tokenized labels          │  mock planner  │
 │                                        │   • element geometry + IDs    │   or VLM       │
 │ offscreen document (WebGPU/CPU host)    │   • redacted screenshot*      │  + residual-PII│
 │  • on-device vision (faces / signatures)│   • privacy receipt           │    tripwire    │
 │  • fuse signals → policy → redact       │                               └──────┬────────┘
 │  • Set-of-Marks numbered overlay        │        validated ActionPlan          │
 │                                        │  ◄───────────────────────────────────┘
 │ service worker (orchestrator)           │   {click|type|fill_local|select|…}
 │  • perceive → plan → act loop            │   referenced by element ID
 │  • validate every action, verify effect  │
 │  • loop detection, step budget           │   * screenshot transmitted ONLY if policy
 └──────────────────────────────────────┘     allows; withheld when vision can't run
```

**Design stance:** fail-closed privacy · DOM-primary / vision-secondary · closed-allowlist actions.

The pipeline is four stages, all on-device: **detect → fuse → decide → redact.**

---

## 4. On-device perception

Perception produces two things: the **interactable-element graph** (the "map" the
server points back into) and the **sensitivity map** (what must be redacted). Three
independent detectors feed it, chosen because their error modes are uncorrelated.

### 4.1 DOM / ARIA signals (highest precision)

The DOM is the single most reliable privacy signal we have, and it needs zero ML:

- `input[type=password]` → definitely a secret (confidence 0.99).
- `autocomplete="cc-number | cc-csc | one-time-code | tel | email | street-address | bday | …"`
  → declared-sensitive by the site itself (0.9).
- `input[type=email | tel]` → typed PII (0.85).
- name/id/label heuristics (`aadhaar`, `pan`, `account`, `ifsc`, `upi`, `otp`, …) → 0.7.

These anchor the fusion layer: they are almost never wrong, so a high-confidence DOM
signal can carry a redaction decision on its own. The same walk emits every
interactable element with a **stable per-step integer ID** and its bounding box; the
executor later acts *only* through these IDs.

### 4.2 Text PII — checksum-validated, not shape-matched

Visible text runs are scanned by `pii-regex.js`. The crucial design choice: shape
matching is only the *candidate* stage. Every candidate is then **validated**:

- **Aadhaar** — Verhoeff checksum (the actual UIDAI algorithm).
- **Credit/debit cards** — Luhn checksum, 13–19 digits.
- **PAN** — structural rule incl. the 4th-character holder-type code (P/C/H/…).
- **API keys / secrets** — Shannon-entropy gate to avoid flagging ordinary tokens.

This is *why* precision stays at ~0.99 while recall stays at 1.00 against a benchmark
that deliberately includes checksum-*invalid* look-alikes (order numbers, invoice IDs,
tracking codes). A shape-only detector would fire on all of those.

### 4.3 On-device vision — the pixels the DOM can't explain

Some PII exists only as pixels: a **face** in an uploaded photo, a **handwritten
signature** on a canvas. No DOM parsing recovers these. `vision-detector.js` is the
client-side vision model the problem statement asks for. It is deliberately built as
three layers with a single algorithm and a hard availability guarantee:

**(a) Pure algorithmic core — `detectSensitiveRegions({data,width,height})`.**
A dependency-free function over an RGBA buffer returning `[{pii_type, bbox,
confidence}]`. This is the exact code scored by the evaluator (see §11), so *what
ships is what is measured*.

- **FACE.** Per-pixel skin classification in **YCbCr** (Cb ∈ [77,127], Cr ∈ [133,173])
  combined with an RGB daylight rule, aggregated on a coarse cell grid, 8-connected
  component labeling, then geometry filters: minimum dimension, fill-ratio ≥ 0.45,
  aspect 0.5–2.0, minimum area fraction of the frame. Confidence blends fill and a
  size prior.
- **SIGNATURE.** Dark-ink-on-light classification (luma < 95 on a light background),
  same grid + connected components, plus a **horizontal morphological closing**
  (`dilateXInk`) that bridges pen-lift gaps. Kept only if wide, short and sparse
  (aspect ≥ 2.4, low fill 0.03–0.34) — the geometry of a signature, not a paragraph.
  A frame that is > 55 % ink cells is assumed to be a dark theme and signatures are
  suppressed to protect precision.

**(b) WebGPU accelerator.** A WGSL compute shader performs the *identical* per-pixel
classification into a storage buffer; the shared CPU code then does connected
components and geometry. Because the two paths run the same algorithm, the Node-tested
CPU path validates the GPU path's math. Critically, the GPU path is trusted **only
after a runtime self-test** (`_verifyGpu`) reproduces the CPU classification on a
4-pixel probe; any mismatch or error falls back to CPU silently. This lets us ship a
WebGPU path with confidence even though WebGPU cannot be exercised in a headless Node
CI.

**(c) Neural detectors — `vision-neural.js`.** Two ONNX Runtime Web detectors run in
the offscreen document once weights are vendored (`node tools/vendor-vision.mjs`):
`yolov8n-face` → FACE and `yolo-signature` → SIGNATURE, both YOLO detect heads decoded
by a shared `decodeYolo`. Faces **union** with the CV core (recall-leaning); signatures
**replace** the classical heuristic, which over-fired on text (a receipt page produced
`signature: 51`). Each model loads independently and fail-open — a missing one simply
falls back to the classical core for its category. The extension's CSP is
`script-src 'self' 'wasm-unsafe-eval'`, so no CDN import is possible: weights are
vendored at build time, never fetched at runtime. Full deep-dive:
[`docs/VISION.md`](docs/VISION.md).

**Availability guarantee.** `init()` probes `navigator.gpu` but **always** ends
`ready:true`, because the CPU core is always available. This matters for privacy: the
policy engine withholds the screenshot entirely when vision is *unavailable* on an
image-bearing page. A stub that reported `ready:false` would permanently withhold
screenshots; a real detector that guarantees readiness unlocks the (redacted)
screenshot path safely.

### 4.4 Fusion

`fusion.js` unions the three signal sources. Same-category boxes are merged by IoU
(> 0.3) and their confidences combined with **noisy-OR** (evidence accumulates —
two weak signals for the same region become one strong one). Fusion is *union-biased*
on purpose: in a privacy system, the union of "might be PII" is the safe set.

---

## 5. Fail-closed policy engine

`policy.js` turns the fused sensitivity map into decisions. Per category it defines a
redaction **method** and a minimum confidence:

- **FACE** → `BLACKOUT`, reversible-OK, minConf 0.5.
- **SIGNATURE** → `BLACKOUT`, non-reversible, minConf 0.35 (kept ≤ the signature model's
  score floor so no model hit is silently dropped — see [`docs/VISION.md`](docs/VISION.md) §5).
- Text categories → `TOKENIZE` (replace with `‹email_1›`-style placeholders so the
  model can still reason about *structure* without seeing *values*).

Two fail-closed rules dominate:

1. **High-risk-below-threshold still redacts.** For the most damaging categories,
   uncertainty resolves toward masking.
2. **No-vision-on-images ⇒ no screenshot.** If the page has images and the vision
   layer is not ready, `send_screenshot` is forced false. The text-only sanitized
   context still goes out; the pixels stay home.

The engine emits a **privacy receipt**: counts of detected/redacted regions, per
category, whether the screenshot was sent, and a residual-risk rating. This is the
user-facing, auditable proof of what happened — surfaced live in the popup.

---

## 6. Redaction and Set-of-Marks

`redactor.js` composes the outbound screenshot on an offscreen canvas:

- **BLACKOUT / REMOVE** — opaque fill over faces/signatures.
- **PIXELATE / BLUR** — for softer categories where reversibility is acceptable.
- **TOKENIZE** — text regions overpainted and represented as tokens in the payload.

It then draws the **Set-of-Marks** overlay: each interactable element gets a numbered
badge whose number *is* its protocol ID. This is what makes grounded action reliable —
the model refers to "element 7", not to fragile pixel coordinates or CSS selectors.

---

## 7. Coordinate spaces (a correctness note)

Three coordinate systems meet here and getting them wrong silently misaligns every
redaction box on HiDPI displays:

- `captureVisibleTab` returns a **device-pixel** image.
- `getBoundingClientRect` (DOM) returns **CSS pixels**.
- The vision core operates on the captured image, so it returns **device-pixel** boxes.

Resolution: the content script reports `devicePixelRatio` via a `VIEWPORT` query; the
worker passes it to the offscreen `detect()`, which divides vision boxes by `dpr` to
land them in the **CSS-pixel** space the DOM signals use, so fusion compares like with
like. The redactor multiplies back by `dpr` when painting on the device-pixel canvas.
One space for reasoning (CSS px), one for painting (device px), an explicit conversion
between them.

---

## 8. Sanitized Context Protocol (v1.0)

The only thing that crosses the trust boundary:

```jsonc
{
  "protocol": "1.0",
  "task": "…",                     // user goal (scanned by the server tripwire too)
  "url_origin": "https://…",        // ORIGIN ONLY — never the full path/query
  "viewport": { "w":…, "h":…, "dpr":… },
  "elements": [                      // the interactable graph
    { "id": 7, "role": "textbox", "label": "Email",
      "bbox": [x,y,w,h], "sensitive": true, "pii_type": "email",
      "value_state": "empty" }
  ],
  "screenshot": "data:image/…",      // REDACTED, and only if policy allows
  "receipt": { "detected":…, "redacted":…, "categories":{…}, "residual_risk":"…" }
}
```

Note what is *absent*: no raw field values, no full URL, no un-redacted pixels, no
cookies, no storage. Labels are sanitized; sensitive values are never present.

---

## 9. Server reasoning tier (stateless)

A small FastAPI service, deliberately stateless (no session storage, no logging of
context):

- `GET /health` — liveness + active backend.
- `POST /plan` — `SanitizedContext` → validated `ActionPlan`.

Backends (env `PBA_BACKEND`):

- **`mock`** (default) — a deterministic heuristic planner. No GPU, no model, no
  network — the whole loop runs on any laptop, which is what CI and the demo use.
- **`vlm`** — delegates to any OpenAI-compatible VLM endpoint (`PBA_VLM_BASE_URL`,
  `PBA_VLM_MODEL`); for the offline requirement, run the same open-weights model
  (e.g. Qwen2.5-VL) locally under vLLM and only change the base URL.

Independent server-side defenses: the **residual-PII tripwire** re-scans inbound
`task` and element labels for email/Aadhaar/PAN/long-number patterns and returns
**422 fail-closed** if any survive; `security.sanitize_plan` clamps the returned plan
to the allowlist, strips destructive suggestions the client would reject anyway, and
enforces caps. The system prompt is injection-resistant and treats page text as data.

---

## 10. Action loop and hardening

The service worker runs **perceive → plan → act**, and every action is treated as
hostile until proven safe (in `content.js`, on the trusted side):

- **Closed allowlist** — `click | type | fill_local | select | scroll | scroll_to |
  navigate | wait`. Anything else is rejected.
- **ID must exist in the context we just sent** — no acting on stale or invented IDs.
- **No literal typing into sensitive fields** — those must be `fill_local`, sourced
  from the **local vault** (email/phone/name live only on-device, are referenced by
  key, and are never placed in the payload).
- **Destructive intent gated by a human click** — "transfer/pay/delete/…" always
  prompts, regardless of what the server proposed.
- **No cross-origin navigation without approval; never eval, never inject
  server-provided HTML/JS.**
- **Verify-after-act, loop detection, step budget** — the loop notices no-ops and
  bails instead of thrashing.

---

## 11. Evaluation methodology

Everything is scored against the **shipped modules** (Node `require()`s the exact
browser code via a dual-export shim), so there is no separate eval implementation to
drift from production.

| # | Metric | Weight | How it is measured |
|---|---|:--:|---|
| 1 | Visual context accuracy | 25% | `vision_eval.js` runs the shipped `detectSensitiveRegions` core over a synthetic, labeled **screen-truth** set (faces across light→dark skin tones, single & pen-lift signatures, and hard negatives: solid-colour blocks, a red button, a dark photo block, a text paragraph, a blank page). IoU-matched precision/recall/F1 + mean IoU, plus a **grounding-integrity** check on the Set-of-Marks (IDs unique, marks ⊆ elements, boxes within viewport). |
| 2 | PII detection precision/recall | 20% | `pii_eval.js` over a generated dataset that includes checksum-*invalid* hard negatives. |
| 3 | Redaction precision | 20% | `redaction_eval.js` — coverage-recall (privacy), box-precision, IoU, over-redaction. |
| 4 | Client resource use (proxy) | 20% | `latency_bench.js` — local scan throughput (chars/ms) and percentiles. |
| 5 | End-to-end latency | 15% | `latency_bench.js` against a live `/plan`. |

**Why synthetic screen-truth for #1.** Real screenshots cannot be labeled and shipped
without either leaking real PII or requiring a browser+model in CI. Painting scenes
procedurally in Node gives pixel-exact ground-truth boxes and lets the *shipped
detector core* be scored deterministically. The hard negatives are the important part:
they punish a detector that over-fires, so the precision number is honest. Recall is
reported as the privacy-critical figure (a miss is a leak).

Representative results (see the README scorecard for the live run): faces P/R/F1 = 1.0,
signatures R = 1.0 with the only precision cost coming from a pen-lift signature being
split into two fully-redacted boxes (over-redaction — the *safe* direction), micro
F1 ≈ 0.95, mean IoU ≈ 0.93, grounding OK.

---

## 12. Cross-browser support

Entry points use a shim — `const ext = globalThis.browser || globalThis.chrome` — so
the `browser.*` (Firefox) and `chrome.*` (Chromium) APIs are addressed uniformly.
Chromium/Chrome (MV3, `minimum_chrome_version` 121 for WebGPU + offscreen) is the
verified target. Firefox does not implement `chrome.offscreen`; the WebGPU/canvas host
would move to an extension background page there. That fallback is **documented, not
claimed working** — see the README "Browser support" section. The vision core itself
is portable (plain WebGPU/CPU), so the port is host-plumbing, not algorithm work.

---

## 13. Compliance by construction

The privacy layer is not only a security feature — it is a **legal safeguard**:

- **UIDAI Masked Aadhaar** — The redactor supports `XXXX XXXX 1234` display (last 4 digits)
  as per UIDAI circular on masked Aadhaar sharing, instead of the full 12-digit number.
  The detector validates Aadhaar via the Verhoeff checksum mandated by UIDAI for AUA
  client-side validation.
- **DPDP Act 2023 §8(5) & DPDP Rules 2025 Rule 6(1)(a)** — Data Fiduciaries must implement
  *reasonable security safeguards* including *masking / tokenization / virtual tokens*.
  The extension implements Rule 6 literally — PII is replaced by `<CATEGORY_n>` tokens
  and blackout boxes **before any network transmission** (see `policy.js:57` fail-closed
  default and `schemas.py:62` token placeholder enforcement).
- **RBI & IT Dept** — No full Aadhaar storage; PAN holder-type validation per Income Tax
  Dept. format `ABCDE1234F`.

Citing these in the SIH presentation signals to ISRO judges that the system is not
just technically private, but **legally compliant by design**.

## 14. Limitations and honest gaps

- **In-browser runtime of the WebGPU shader and `chrome.*` plumbing is not exercised in
  CI.** It is covered by (a) the Node-tested CPU core running the identical algorithm,
  (b) the GPU self-verification probe that falls back on any mismatch, (c) syntax/byte
  checks, and (d) the manual demo page. We do not claim in-browser runtime numbers we
  did not observe.
- **The neural YOLO detectors activate once weights are vendored** (one command; CSP
  forbids CDN loads, so nothing is fetched at runtime). The Node metric scores the
  always-on CV core; the neural models (faces + signatures) are verified in-browser and
  via `eval/face_probe.js`, not in the Node metric. See [`docs/VISION.md`](docs/VISION.md).
- **The CV detector is intentionally conservative** — tuned for the fail-closed
  direction (rather over-redact a paragraph edge than miss a signature). This shows up
  as over-redaction in Metric #3 and the occasional split-box in Metric #1, both of
  which are privacy-safe.
- **Firefox is shimmed and documented, not verified**; the offscreen host needs a
  background-page fallback there.

---

## 15. File map

| Area | Files |
|---|---|
| Shared enums | `extension/lib/protocol.js` |
| Perception | `extension/lib/privacy/dom-detector.js`, `pii-regex.js`, `extension/lib/vision/vision-detector.js`, `vision-neural.js` |
| Fusion / policy | `extension/lib/privacy/fusion.js`, `policy.js` |
| Redaction | `extension/lib/redactor.js` |
| Context assembly | `extension/lib/dom-perception.js` |
| Orchestration / action | `extension/background/service-worker.js`, `extension/content/content.js`, `extension/offscreen/*` |
| UI | `extension/popup/*` |
| Server | `server/main.py`, `planner.py`, `vlm_adapter.py`, `security.py`, `schemas.py`, `prompts/system_prompt.txt` |
| Evaluation | `eval/*.js`, `eval/fixtures/screen_truth.js` |
| Demo &amp; visual | `demo/index.html`, `demo/redaction-visual.html`, `demo/README.md`, `REDACTION_VISUAL.md` |
