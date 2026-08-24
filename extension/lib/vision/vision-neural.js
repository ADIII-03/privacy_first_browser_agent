/*
 * vision-neural.js — OPTIONAL neural detector hook (transformers.js / ONNX Runtime Web).
 *
 * The built-in classical detector (vision-detector.js) is always active and needs
 * zero downloads. This module ADDS a neural detector when you vendor a model — it
 * augments (unions with) the built-in detections, it does not replace them.
 *
 * It is a no-op until vendored: init() sets `available:false` if the transformers.js
 * bundle isn't present, and vision-detector.js simply skips it. Nothing here runs,
 * and nothing is downloaded, unless you complete the VENDORING steps below.
 *
 * ── WHY IT MUST BE VENDORED ────────────────────────────────────────────────
 * The extension CSP is `script-src 'self' 'wasm-unsafe-eval'` (see manifest.json):
 * loading a library or weights from a CDN at runtime is forbidden by design — that
 * is the whole privacy point. So the library, its WASM, and the model weights must
 * be packaged INSIDE the extension and loaded same-origin.
 *
 * ── VENDORING (one-time, offline afterwards) ───────────────────────────────
 *  1. npm i @huggingface/transformers  (or download a release build)
 *  2. Copy the ESM bundle to:            extension/lib/vendor/transformers/transformers.min.js
 *  3. Copy its ONNX Runtime WASM to:     extension/lib/vendor/ort/*.wasm
 *  4. Download a quantized detector to:  extension/models/<model-id>/...
 *       • Faces:  a BlazeFace / MediaPipe face-detection ONNX (~1–2 MB), or
 *       • General object detection: Xenova/yolos-tiny (int8) — 'person' boxes
 *  5. All of extension/models/ and extension/lib/vendor/ are same-origin to the
 *     offscreen document, so they load under `'self'`. (models/* is already listed
 *     in web_accessible_resources.)
 *
 * The adapter keeps output in IMAGE (device) pixels — the same space as the
 * built-in core — so vision-detector.js can merge then convert to CSS px once.
 */
(function () {
  const G = (typeof globalThis !== "undefined") ? globalThis : this;
  G.PBA = G.PBA || {};
  const PII = (G.PBA.PII) || { FACE: "face", SIGNATURE: "signature", PERSON: "person" };

  // Map a model's class labels → our PII categories. Anything not listed is ignored.
  // A dedicated face model is preferable; with a generic object detector, 'person'
  // boxes are treated as a coarse person/face region (still redacted, fail-closed).
  const LABEL_MAP = {
    face: PII.FACE,
    person: PII.FACE,
    signature: PII.SIGNATURE,
    handwriting: PII.SIGNATURE,
  };

  const MIN_SCORE = 0.5;
  const MODEL_ID = "Xenova/yolos-tiny"; // change to your vendored model id

  let _available = false;
  let _detector = null;
  let _initTried = false;

  // Resolve a packaged file to a same-origin URL (browser-extension context).
  function pkgUrl(rel) {
    try {
      const ext = G.chrome || G.browser;
      if (ext && ext.runtime && ext.runtime.getURL) return ext.runtime.getURL(rel);
    } catch (_) {}
    return rel;
  }

  async function init() {
    if (_initTried) return { available: _available };
    _initTried = true;
    try {
      // Dynamic import so the extension still loads when nothing is vendored.
      // (A static top-level import would hard-fail the classic script.)
      const mod = await import(pkgUrl("lib/vendor/transformers/transformers.min.js"));
      const { pipeline, env } = mod;

      // Force fully-offline, on-device inference. No network, ever.
      env.allowRemoteModels = false;
      env.localModelPath = pkgUrl("models/");
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = pkgUrl("lib/vendor/ort/");
        env.backends.onnx.wasm.proxy = true; // keep WASM off the UI thread
      }

      _detector = await pipeline("object-detection", MODEL_ID, { device: "webgpu", dtype: "q8" });
      _available = true;
      G.PBA.visionNeural._model = MODEL_ID;
    } catch (e) {
      // Not vendored (or failed to load) → stay silent; the built-in detector runs.
      _available = false;
    }
    return { available: _available };
  }

  /**
   * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} image RGBA raster
   * @returns {Promise<Array<{pii_type,bbox,confidence}>>} boxes in IMAGE (device) pixels
   */
  async function detect(image) {
    if (!_available || !_detector) return [];
    // transformers.js accepts a RawImage built from raw RGBA bytes.
    const mod = await import(pkgUrl("lib/vendor/transformers/transformers.min.js"));
    const RawImage = mod.RawImage;
    const raw = new RawImage(image.data, image.width, image.height, 4);
    const out = await _detector(raw, { threshold: MIN_SCORE, percentage: false });

    const dets = [];
    for (const r of out || []) {
      const cat = LABEL_MAP[(r.label || "").toLowerCase()];
      if (!cat) continue;
      if ((r.score || 0) < MIN_SCORE) continue;
      const b = r.box || {};
      const x = Math.round(b.xmin), y = Math.round(b.ymin);
      const w = Math.round(b.xmax - b.xmin), h = Math.round(b.ymax - b.ymin);
      if (w <= 0 || h <= 0) continue;
      dets.push({ pii_type: cat, bbox: [x, y, w, h], confidence: +Number(r.score).toFixed(3) });
    }
    return dets;
  }

  G.PBA.visionNeural = {
    init, detect,
    get available() { return _available; },
    LABEL_MAP, MODEL_ID,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = G.PBA.visionNeural;
})();
