/*
 * vision-neural.js — OPTIONAL neural detector hook (transformers.js / ONNX Runtime Web).
 *
 * The built-in classical detector (vision-detector.js) is always active and needs
 * zero downloads. This module ADDS a neural detector when weights are vendored —
 * it AUGMENTS (unions with) the built-in detections, it never replaces them.
 * Union-biased fusion + fail-closed policy means a neural false positive only
 * costs over-redaction, while the classical core guarantees baseline coverage.
 *
 * It is a no-op until vendored: init() sets `available:false` if the transformers.js
 * bundle isn't present, and vision-detector.js simply skips it. Nothing here runs,
 * and nothing is downloaded, unless you complete the VENDORING steps below.
 *
 * ── WHY IT MUST BE VENDORED ────────────────────────────────────────────────
 * The extension CSP is `script-src 'self' 'wasm-unsafe-eval'` (see manifest.json):
 * loading a library or weights from a CDN at runtime is forbidden by design — that
 * is the whole privacy point. Vendor everything with ONE command:
 *
 *     node tools/vendor-vision.mjs
 *
 * which populates (all .gitignore'd, packaged same-origin at load time):
 *   lib/vendor/transformers/transformers.min.js   (ESM bundle)
 *   lib/vendor/ort/*.wasm *.mjs                   (ONNX Runtime Web backends)
 *   models/<model-id>/...                         (quantized weights)
 *
 * ── MODEL REGISTRY ─────────────────────────────────────────────────────────
 * ACTIVE_MODEL selects from REGISTRY below. The default ships today; to swap in
 * a dedicated face detector later (e.g. a BlazeFace/YOLOv8-face ONNX converted
 * for transformers.js), add an entry and flip ACTIVE_MODEL — no other code
 * changes. See docs/VENDORING.md for the conversion recipe.
 *
 * Output stays in IMAGE (device) pixels — the same space as the built-in core —
 * so vision-detector.js merges then converts to CSS px once.
 */
(function () {
  const G = (typeof globalThis !== "undefined") ? globalThis : this;
  G.PBA = G.PBA || {};
  const PII = (G.PBA.PII) || {
    FACE: "face", SIGNATURE: "signature", PERSON: "person", ID_DOCUMENT: "id_document",
  };

  // Model → PII category mapping is per-model so different detectors can coexist.
  // Anything not listed is ignored; unknown-but-plausible classes should be ADDED
  // here (fail-closed), not dropped silently.
  const REGISTRY = {
    // Guaranteed-available default: YOLOS-tiny int8 (~6 MB q8). COCO has no 'face'
    // class, so full-person boxes map to a coarse FACE region — deliberately
    // over-broad, because fusion+policy tolerate over-redaction, not leaks.
    "Xenova/yolos-tiny": {
      task: "object-detection",
      dtype: "q8",
      device: "webgpu",            // auto-falls back to WASM if WebGPU unavailable
      minScore: 0.5,
      labels: { person: PII.FACE },
      warmup: true,
      note: "COCO person→coarse face region; swap to dedicated face ONNX when available.",
    },
  };

  const ACTIVE_MODEL = "Xenova/yolos-tiny";

  const BUNDLE_URL = "lib/vendor/transformers/transformers.min.js";

  let _available = false;
  let _detector = null;
  let _initTried = false;
  let _warmupMs = null;

  // Resolve a packaged file to a same-origin URL (browser-extension context).
  function pkgUrl(rel) {
    try {
      const ext = G.chrome || G.browser;
      if (ext && ext.runtime && ext.runtime.getURL) return ext.runtime.getURL(rel);
    } catch (_) {}
    return rel;
  }

  function loadMod() {
    return import(pkgUrl(BUNDLE_URL));
  }

  async function createDetector() {
    const mod = await loadMod();
    const { pipeline, env } = mod;
    const cfg = REGISTRY[ACTIVE_MODEL];

    // Force fully-offline, on-device inference. No network, ever.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = pkgUrl("models/");
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = pkgUrl("lib/vendor/ort/");
      env.backends.onnx.wasm.proxy = true; // keep WASM off the UI thread
    }
    return { mod, pipe: await pipeline(cfg.task, ACTIVE_MODEL, { device: cfg.device, dtype: cfg.dtype }) };
  }

  // Tiny gray frame: runs the full graph once so shader compile / wasm warm-up /
  // weight upload happen before the first REAL screenshot (hides cold-start).
  function warmupFrame(RawImage) {
    const w = 64, h = 64;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = data[i + 2] = 200;
      data[i + 3] = 255;
    }
    return new RawImage(data, w, h, 4);
  }

  async function init() {
    if (_initTried) return { available: _available };
    _initTried = true;
    const cfg = REGISTRY[ACTIVE_MODEL];
    try {
      const { mod, pipe } = await createDetector();
      _detector = pipe;

      if (cfg.warmup) {
        try {
          const t0 = Date.now();
          await _detector(warmupFrame(mod.RawImage), { threshold: 1.1 }); // full graph, yields nothing
          _warmupMs = Date.now() - t0;
        } catch (_) { /* warm-up is best-effort */ }
      }
      _available = true;
      G.PBA.visionNeural._model = ACTIVE_MODEL;
    } catch (_) {
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
    const cfg = REGISTRY[ACTIVE_MODEL];
    const mod = await loadMod();
    const raw = new mod.RawImage(image.data, image.width, image.height, 4);
    const out = await _detector(raw, { threshold: cfg.minScore, percentage: false });

    const dets = [];
    for (const r of out || []) {
      const cat = cfg.labels[(r.label || "").toLowerCase()];
      if (!cat) continue;
      if ((r.score || 0) < cfg.minScore) continue;
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
    get model() { return _available ? ACTIVE_MODEL : null; },
    get warmupMs() { return _warmupMs; },
    REGISTRY, ACTIVE_MODEL,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = G.PBA.visionNeural;
})();
