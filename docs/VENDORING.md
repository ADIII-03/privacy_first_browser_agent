# Vendoring the Neural Vision Stack

The extension's neural detector (`extension/lib/vision/vision-neural.js`) is a
**no-op until weights are vendored**. The classical CV core (skin/ink geometry,
WebGPU-shader accelerated) always runs; the neural detector **unions** with it via
the fusion layer. Nothing is ever fetched at runtime — the extension CSP forbids
CDN scripts, which is precisely the privacy guarantee.

## One command

```bash
node tools/vendor-vision.mjs          # download missing artifacts (~10–30 MB)
node tools/vendor-vision.mjs --check  # verify presence + integrity only
```

Then reload the extension at `chrome://extensions`. The popup and `VISION` init
response report the neural backend once active.

## What gets installed (all `.gitignore`'d)

| Path | Contents |
|---|---|
| `extension/lib/vendor/transformers/transformers.min.js` | transformers.js ESM bundle (pinned version in script) |
| `extension/lib/vendor/ort/*.wasm *.mjs` | ONNX Runtime Web backends (CPU SIMD + WebGPU/JSEP) |
| `extension/models/<model-id>/…` | Quantized weights + configs for each registry model |

Default registry model: **`Xenova/yolos-tiny` q8** (~6 MB) — COCO-trained, so it
has no native `face` class; full-person boxes map to a coarse FACE region. That is
deliberately over-broad: union-biased fusion plus the fail-closed policy engine
treat over-redaction as a mild cost and leaks as an incident.

## Swapping in a dedicated face/document detector

1. Add an entry to `REGISTRY` in `vision-neural.js`
   (`task`, `dtype`, `device`, `minScore`, `labels: { <class>: PII.* }`).
2. Add matching files to `MODELS` in `tools/vendor-vision.mjs`.
3. Set `ACTIVE_MODEL` and re-run the vendor script.

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
the warm-up latency (`_warmupMs`) reported at init.

## Why binaries stay out of git

Weights are multi-megabyte blobs that churn with every quantization tweak.
Vendoring is reproducible from pinned URLs in one command, keeping review diffs
readable while remaining fully offline after setup (air-gap friendly).
