# Vendoring the Neural Vision Stack

The extension's neural detector (`extension/lib/vision/vision-neural.js`) is a
**no-op until weights are vendored**. The classical CV core (skin/ink geometry,
WebGPU-shader accelerated) always runs. For **faces**, the neural detector *unions*
with the classical core via the fusion layer (recall-leaning). For **signatures**,
the neural model *replaces* the classical heuristic when vendored — that heuristic
over-fires badly on text (underlines/rules/text-lines all look like "wide + short +
sparse dark ink"), so `vision-detector.js` drops classical signature boxes once the
signature model is loaded (and keeps them as a fallback when it isn't). Nothing is
ever fetched at runtime — the extension CSP forbids CDN scripts, which is precisely
the privacy guarantee (build-time downloads by the vendor script are fine).

## One command

```bash
node tools/vendor-vision.mjs          # download missing artifacts (~30–45 MB)
node tools/vendor-vision.mjs --check  # verify presence + integrity only
```

Then reload the extension at `chrome://extensions`. The popup and `VISION` init
response report the neural backend once active.

## What gets installed (all `.gitignore`'d)

| Path | Contents |
|---|---|
| `extension/lib/vendor/ort/*.wasm *.mjs` | ONNX Runtime Web backends (CPU SIMD + WebGPU/JSEP) |
| `extension/models/yolov8n-face/model.onnx` | YOLOv8n-face → **FACE** (locally exported, ~11.6 MB, AGPL-3.0) |
| `extension/models/yolo-signature/model.onnx` | YOLOv11n → **SIGNATURE** ([liberty666/yolo11n-chinese-signature](https://huggingface.co/liberty666/yolo11n-chinese-signature), downloaded, ~10 MB, **MIT**) |
| `extension/lib/vendor/transformers/transformers.min.js` | transformers.js ESM bundle — only for the LEGACY `yolos-tiny` fallback |

### Active models (`ACTIVE_MODELS` in `vision-neural.js`)

Two `onnx-yolo` detectors load at init and run concatenated, both a single-class
YOLO detect head (`images [1,3,640,640]` → `[1,5,8400]`, score at index 4) decoded
by the shared `decodeYolo`:

- **`yolov8n-face`** → `FACE`. Locally exported (`yolo export model=yolov8n-face.pt
  format=onnx imgsz=640 opset=12` → `eval/models/`), copied in by the vendor script.
- **`yolo-signature`** → `SIGNATURE`. Downloaded from HuggingFace at build time.
  **Trained on ChiSig** (Chinese handwritten signature *regions*); signatures are
  script-agnostic ink shapes, so it generalizes, and it is far more precise than the
  old classical heuristic. Model is **ungated + MIT**, so the one-command download
  needs no HF account or token.

> **Licenses:** the face model inherits **AGPL-3.0** from Ultralytics YOLOv8; the
> signature model is **MIT**. Both are fine for personal/hackathon use. AGPL is
> strong copyleft if the extension is ever redistributed — swap the face model for a
> permissively-licensed one before any commercial distribution.

`Xenova/yolos-tiny` remains in the registry as a **legacy** transformers.js
fallback (COCO person→coarse face region, ~1 s, noisy); it is not in `ACTIVE_MODELS`.

## Adding or swapping a detector

1. Add an entry to `REGISTRY` in `vision-neural.js`:
   - **`onnx-yolo`** (preferred, raw YOLO head): `modelFile`, `size`, `scoreIndex`,
     `nmsIou`, `minScore`, `category: PII.*`, `ep: ["webgpu","wasm"]`, `warmup`.
   - **`transformers`** (legacy DETR/YOLOS): `task`, `dtype`, `device`, `minScore`,
     `labels: { <class>: PII.* }`.
2. Add matching files to `MODELS` in `tools/vendor-vision.mjs` (`localSource` to copy
   a local export in, or `hfRepo` + `files` to download from HuggingFace at build
   time — gated repos need a token and won't work with the bare fetch).
3. Add the id to the `ACTIVE_MODELS` array and re-run the vendor script. Verify the
   I/O shape first with `node eval/inspect_onnx.cjs <model.onnx>`.

### Face-detector candidates (post-selection work)

- **BlazeFace short-range**: convert MediaPipe's TFLite to ONNX (`tf2onnx` /
  `onnx2tf`), then add the preprocessor/postprocessor config so transformers.js's
  object-detection pipeline accepts it. ~400 KB, real-time on iGPUs.
- **YOLOv8/11n-face** (e.g. Ultralytics export): needs NMS baked into the graph or
  custom decode — transformers.js's pipeline supports YOLOS-style heads natively,
  so prefer ports with a compatible head or export via `ultralytics-export-onnx`
  community tooling.
- **ID documents** (MIDV-500 fine-tune): train YOLO11n-seg on converted MIDV-500
  quads (+ synthetic Aadhaar/PAN composites), export int8 ONNX, map the class to
  `PII.ID_DOCUMENT` (already plumbed end-to-end: protocol → policy → redaction).

## Verifying

```bash
node tools/vendor-vision.mjs --check   # magic-byte + presence checks
```

In-browser: load any image-heavy page, open the popup → privacy receipt shows
neural detections merged under source `"vision"`; the service-worker log records
the warm-up latency (`visionNeural.warmupMs`, summed across loaded models) at init.

## Why binaries stay out of git

Weights are multi-megabyte blobs that churn with every quantization tweak.
Vendoring is reproducible from pinned URLs in one command, keeping review diffs
readable while remaining fully offline after setup (air-gap friendly).
