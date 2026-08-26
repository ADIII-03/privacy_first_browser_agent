# On-Device Neural Vision Stack (YOLO + ONNX Runtime Web)

This is the deep-dive for the extension's **neural** vision layer — the two YOLO
object detectors that find **faces** and **handwritten signatures** in the captured
screenshot, entirely on-device. It complements the higher-level treatment in
[`DESIGN.md` §4.3](../DESIGN.md) (perception) and the install mechanics in
[`docs/VENDORING.md`](VENDORING.md).

> **One-line invariant (same as everywhere else):** raw pixels never leave the
> device. These models run in the browser's offscreen document; only the *redacted*
> screenshot and a count of what was masked can ever be transmitted.

---

## 1. Two layers, one output space

Vision is **two cooperating layers**, not one:

| Layer | File | Always on? | What it is |
|---|---|:--:|---|
| **Classical CV core** | `vision-detector.js` | **Yes** | Dependency-free RGBA heuristics (YCbCr skin for faces, dark-ink geometry for signatures) + a WebGPU compute-shader accelerator with CPU fallback. Scored by the eval. |
| **Neural YOLO** | `vision-neural.js` | Only when weights are vendored | Two `onnxruntime-web` sessions decoding YOLO detect heads. A no-op until `node tools/vendor-vision.mjs` places the weights. |

Both layers emit the **same record shape** in the **same coordinate space** — boxes in
**image (device) pixels**:

```js
{ pii_type: "face" | "signature", bbox: [x, y, w, h], confidence: 0.0–1.0 }
```

`vision-detector.js` merges the two, converts once to CSS pixels (`÷ devicePixelRatio`),
and hands the union to fusion → policy → redaction. Because the neural boxes already
match the classical core's space, there is exactly **one** device→CSS conversion for
everything (see [`DESIGN.md` §7](../DESIGN.md), coordinate spaces).

---

## 2. The two models

Both are single-purpose Ultralytics-family detect heads exported to ONNX. They share
the **entire pre/post-processing path**, differing only by their `REGISTRY` config in
[`vision-neural.js`](../extension/lib/vision/vision-neural.js).

| id | PII | Head / output | Input | Score idx | Source | License | Fusion vs classical |
|---|---|---|---|:--:|---|---|---|
| `yolov8n-face` | `FACE` | `[1, 20, 8400]` (4 box + 1 score + 5 kpts×3) | `images [1,3,640,640]` | 4 | Local export of YOLOv8n-face (`eval/models/`) | AGPL-3.0 | **Union** — augments the classical skin detector |
| `yolo-signature` | `SIGNATURE` | `[1, 5, 8400]` (4 box + 1 score) | `images [1,3,640,640]` | 4 | [`liberty666/yolo11n-chinese-signature`](https://huggingface.co/liberty666/yolo11n-chinese-signature) (downloaded) | **MIT** | **Replace** — supersedes the classical heuristic |

The face head carries 15 extra keypoint channels; `decodeYolo` reads only channels 0–3
(box) and channel 4 (score) and ignores the rest, so **one decoder handles both**. The
active set is declared in one place:

```js
const ACTIVE_MODELS = ["yolov8n-face", "yolo-signature"];
```

Adding a third detector is: a `REGISTRY` entry + a `MODELS` entry in the vendor script +
this array (see [`docs/VENDORING.md`](VENDORING.md), "Adding or swapping a detector").

---

## 3. Union vs Replace — and *why* signatures replace

This is the one asymmetry worth understanding.

- **Faces union.** The neural face box is *added* to whatever the classical skin
  detector found. Two independent detectors with uncorrelated error modes → higher
  recall, which is the privacy-safe direction.
- **Signatures replace.** When the signature model is loaded, `vision-detector.js`
  **drops the classical signature boxes** and keeps only the model's. The reason is
  precision: the classical "wide + short + sparse dark ink" rule cannot tell a signature
  from a table rule, an underline, or a line of text — on a receipt page it produced
  **`signature: 51`** false positives. A trained detector doesn't make that mistake.

The switch is a runtime capability check, not a hard-coded branch, so the classical
heuristic **stays as the fallback** when the model isn't vendored:

```js
// vision-detector.js — live merge path only (regionsFromCls / DEFAULT_CFG stay pure,
// so eval/vision_eval.js still scores the classical core unchanged)
if (G.PBA.visionNeural && G.PBA.visionNeural.available) {
  const covers = G.PBA.visionNeural.covers;
  if (typeof covers === "function" && covers(PII.SIGNATURE)) {
    detections = detections.filter((d) => d.pii_type !== PII.SIGNATURE); // drop classical sig
  }
  const extra = await G.PBA.visionNeural.detect(image);                  // add neural boxes
  if (Array.isArray(extra)) detections = detections.concat(extra);
}
```

`covers(type)` is backed by the union of `category` fields of the models that actually
loaded. Each model loads **independently and fail-open**: if the signature weights are
missing but the face weights are present, faces go neural and signatures fall back to
the classical heuristic — no coverage is ever lost.

---

## 4. The decode contract (Node ↔ browser parity)

Every model runs the identical pipeline. It is intentionally the *same code* as the
reference probe `eval/face_probe.js`, so a detection verified in Node behaves the same
in the browser.

1. **Letterbox** to 640×640: scale keeping aspect, pad the remainder with gray
   `rgb(114,114,114)` — the YOLOv8 convention. Record `scale, padX, padY`.
2. **NCHW float**: RGBA → 3 planes of `[0,1]` floats, `[1, 3, 640, 640]`.
3. **Session run** via `onnxruntime-web`, input tensor keyed by the model's `inputName`
   (`"images"`), falling back to `session.inputNames[0]`.
4. **`decodeYolo`** — layout-agnostic. It auto-detects `[1, C, N]` (channels-first) vs
   `[1, N, C]` by comparing `dims[1]` and `dims[2]`, reads `cx,cy,w,h` and the score at
   `scoreIndex`, thresholds at `minScore`, **undoes the letterbox** back to original
   image pixels, then runs **NMS** at `nmsIou`.

```
device-px screenshot ──letterbox(114 pad)──► NCHW[1,3,640,640] ──ORT session──►
   [1,C,8400] ──decodeYolo(auto-layout, score@idx4, ×undo-letterbox)──► NMS ──► boxes(device px)
```

That last step is why boxes come back already in the classical core's space.

---

## 5. Thresholds (and the fail-open invariant)

There are **two** gates a detection must clear: the model's own score cutoff, then the
policy engine's per-category `minConf`.

| Gate | Where | Face | Signature |
|---|---|:--:|:--:|
| Model `minScore` | `vision-neural.js` `REGISTRY` | 0.35 | 0.35 |
| NMS IoU | `vision-neural.js` `REGISTRY` | 0.45 | 0.45 |
| Policy `minConf` | [`policy.js`](../extension/lib/privacy/policy.js) | **0.50** | **0.35** |

> **Invariant — policy `minConf` must be ≤ the model's `minScore` for any category with
> no classical fallback.** Otherwise a detection in the band `[minScore, minConf)` passes
> the detector, appears "found" upstream, and is then **silently dropped** by policy —
> a *fail-open* leak for a fail-closed category. This is exactly what happened when
> `SIGNATURE` sat at 0.5 while the model emitted at 0.35: real signatures scoring in
> 0.35–0.50 vanished from the receipt. `SIGNATURE` is now floored at 0.35 to match, with
> the coupling noted in `policy.js` so future tuning keeps them in sync.

**Why `FACE` keeps the higher 0.50 floor:** faces still *union* with the always-on
classical skin detector, so a sub-0.50 neural-only face is usually also caught
classically — the higher floor trades a little neural recall for fewer over-blackouts,
and there is a fallback to catch the miss. Signatures no longer have that fallback
(they replaced the heuristic), which is *why* their floor had to drop to the model's.
If you want faces fully fail-closed at the model's floor too, lower `FACE` `minConf` to
0.35 — it's a one-line, one-way-safe change.

---

## 6. Where it runs, and why: the offscreen document

The neural stack runs in the **offscreen document**
([`offscreen/offscreen.html`](../extension/offscreen/offscreen.html) →
[`offscreen.js`](../extension/offscreen/offscreen.js)), not the service worker.

- A service worker has no DOM: no `OffscreenCanvas` compositing surface, no
  `createImageBitmap`, and WebGPU access is unreliable. The offscreen document is a full
  DOM page, so `letterbox()` can draw into a canvas and the WebGPU EP can initialize.
- The manifest sets **`cross-origin-embedder-policy: require-corp`** and
  **`cross-origin-opener-policy: same-origin`**, which grant cross-origin isolation, so
  the vendored ONNX Runtime WASM may run **multi-threaded**.
- Load order in `offscreen.html` matters and is fixed: `vision-neural.js` →
  `vision-detector.js` → `offscreen.js`, so the detector's merge step can see the neural
  hook's API when it runs.

The service worker sends a `VISION` message with the captured data URL; `offscreen.js`
calls `PBA.vision.detect(imageDataUrl, { dpr })` and returns the boxes.

### Execution providers & warmup

- Each model tries EPs in order **`["webgpu", "wasm"]`** and keeps the first that loads,
  independently — one model can land on WebGPU and another on WASM.
- Cold start (WebGPU kernel compile + weight upload) is ~3.6 s the first time. `init()`
  runs each model once on a gray frame at startup (**warmup**) so the first *real*
  screenshot doesn't pay it. Total warmup is reported as `visionNeural.warmupMs` (sum
  across loaded models) and surfaced at init.

---

## 7. Vendoring — build-time, never runtime (this *is* the privacy point)

The extension CSP is `script-src 'self' 'wasm-unsafe-eval'`. That **forbids loading any
script or weight from a CDN at runtime** — which is precisely the guarantee that nothing
phones home. So the ONNX runtime and the model weights are placed *inside* the extension
at **build time** by one command:

```bash
node tools/vendor-vision.mjs          # download/copy whatever is missing (~30–45 MB)
node tools/vendor-vision.mjs --check  # verify presence + ONNX magic bytes only
```

- The face model is a **local export** copied from `eval/models/yolov8n-face.onnx`.
- The signature model is **downloaded** from an **ungated, MIT** HuggingFace repo, so the
  one command needs no account or token. (A *gated* repo would 401 without an auth token —
  that is why the ungated model was chosen.)
- Everything lands in `.gitignore`'d paths (`extension/lib/vendor/ort/`,
  `extension/models/*/model.onnx`) — multi-MB binaries stay out of git; the build is
  reproducible from pinned URLs and fully offline after setup.

Full install table, licenses, and the "adding a detector" checklist:
[`docs/VENDORING.md`](VENDORING.md).

---

## 8. End-to-end placement

```
service-worker: captureVisibleTab({format:"jpeg", quality:80})  ──► device-px JPEG data URL
        │  VISION message { imageDataUrl, dpr }
        ▼
offscreen.js ──► PBA.vision.detect(dataUrl, { dpr })          [vision-detector.js]
        ├─ classical core  detectSensitiveRegions(rgba)  → FACE + SIGNATURE (device px)
        ├─ neural          visionNeural.detect(rgba)      → per ACTIVE model, concatenated
        │       • yolov8n-face   → FACE
        │       • yolo-signature → SIGNATURE
        ├─ gate: covers(SIGNATURE)? drop classical SIGNATURE, then concat neural boxes
        └─ convert device px → CSS px  (÷ dpr)
        │  boxes back to service-worker
        ▼
content.js: fuse (DOM + regex + vision)  →  policy.decide  →  redactor  →  privacy receipt
```

The neural layer changes only the *source and quality* of the face/signature boxes;
fusion, policy, redaction, and the receipt treat them exactly as before.

---

## 9. Verification & honest gaps

- **The Node eval scores the classical core, not the neural stack.** `eval/vision_eval.js`
  runs the pure `detectSensitiveRegions` over labeled synthetic scenes; the neural models
  need a browser/ONNX runtime and are therefore **not** in that metric. They are verified
  separately by `eval/face_probe.js` (real `onnxruntime-node` inference, same
  letterbox→decode→NMS) and by the manual `demo/` page. We do not report in-browser neural
  numbers we didn't observe.
- **The models are trained on real faces/signatures.** The `demo/` page draws *synthetic*
  assets (an SVG avatar, a canvas ink stroke) that were originally tuned for the classical
  heuristic; a real-trained detector may score those differently than a photographed face
  or a genuine handwritten signature. The classical fallback (when weights aren't vendored)
  still covers the synthetic demo assets.
- **`yolo-signature` is trained on ChiSig** (Chinese handwritten signature *regions*).
  Signatures are script-agnostic ink shapes, so it generalizes to Latin signatures, but
  it is a region detector, not an OCR/verifier.
- **AGPL note:** the face model inherits AGPL-3.0 from Ultralytics YOLOv8; fine for
  personal/hackathon use, but swap it for a permissively-licensed face model before any
  commercial redistribution. The signature model is MIT.
```
