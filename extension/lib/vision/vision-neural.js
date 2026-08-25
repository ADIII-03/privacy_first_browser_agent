/*
 * vision-neural.js — OPTIONAL neural detector hook. It AUGMENTS the always-on
 * classical core (vision-detector.js); it never replaces it. Union-biased fusion +
 * fail-closed means a neural false positive only costs over-redaction, while the
 * classical core guarantees baseline coverage. No-op until weights are vendored.
 *
 * Runs in the OFFSCREEN DOCUMENT (offscreen/offscreen.html) — a full DOM page with
 * WebGPU, OffscreenCanvas and createImageBitmap, and (via the manifest's COEP/COOP)
 * cross-origin isolation, so vendored WASM may run multi-threaded.
 *
 * ── TWO RUNTIMES (per REGISTRY entry) ──────────────────────────────────────
 *   runtime:"onnx-yolo"    — RAW onnxruntime-web session decoding a YOLOv8 head.
 *                            This is the default. The transformers.js object-detection
 *                            pipeline is DETR-shaped and CANNOT decode a YOLO output
 *                            tensor, so a dedicated face detector needs this path.
 *   runtime:"transformers" — @huggingface/transformers pipeline (kept for the legacy
 *                            yolos-tiny fallback; superseded and not the default).
 *
 * Default = YOLOv8n-face (onnx-yolo): on real screenshots ~33 ms (WASM) / ~46 ms
 * (WebGPU) with tight face boxes and no COCO hallucinations, vs ~1 s + donut/plant
 * junk for yolos-tiny. Measured by eval/face_probe.js and eval/webgpu_face_probe.html;
 * the pre/post below is the SAME letterbox→NCHW→decode(score@idx)→NMS as those probes.
 *
 * ── VENDORING (CSP `script-src 'self' 'wasm-unsafe-eval'` forbids CDN at runtime) ─
 *     node tools/vendor-vision.mjs
 * populates (all .gitignore'd, packaged same-origin, loaded from the offscreen doc):
 *   lib/vendor/ort/ort-webgpu-api.mjs + ort-*.wasm/.mjs   (onnxruntime-web ESM + backends)
 *   models/yolov8n-face/model.onnx                        (local export, copied in)
 *
 * Output stays in IMAGE (device) pixels — same space as the classical core — so
 * vision-detector.js merges then converts to CSS px once (÷dpr).
 */
(function () {
  const G = (typeof globalThis !== "undefined") ? globalThis : this;
  G.PBA = G.PBA || {};
  const PII = (G.PBA.PII) || {
    FACE: "face", SIGNATURE: "signature", PERSON: "person", ID_DOCUMENT: "id_document",
  };

  // Anything not mapped to a PII category is ignored; add classes here (fail-closed),
  // never drop silently.
  const REGISTRY = {
    // ── DEFAULT: dedicated face detector, raw onnxruntime-web ──────────────
    // YOLOv8n-face pose/detect head → output [1,20,8400] = 4 box + 1 face score
    // (index 4) + 5 keypoints×3. Single class → FACE.
    "yolov8n-face": {
      runtime: "onnx-yolo",
      modelFile: "models/yolov8n-face/model.onnx",
      inputName: "images",         // from the probe; falls back to session.inputNames[0]
      size: 640,                   // letterbox square
      scoreIndex: 4,               // channel holding the face confidence
      minScore: 0.35,
      nmsIou: 0.45,
      category: PII.FACE,
      ep: ["webgpu", "wasm"],      // try WebGPU, fall back to WASM (both are fine on speed)
      warmup: true,
      note: "dedicated face detector; ~33-46ms, tight boxes, no COCO hallucinations.",
    },
    // ── LEGACY fallback: transformers.js YOLOS-tiny (superseded, not default) ──
    // COCO has no 'face', so full-person boxes map to a coarse FACE region. Slow
    // (~1s) and noisy on UI. Requires the transformers bundle to be vendored.
    "Xenova/yolos-tiny": {
      runtime: "transformers",
      task: "object-detection",
      dtype: "q8",
      device: "webgpu",
      minScore: 0.5,
      labels: { person: PII.FACE },
      warmup: true,
      note: "COCO person→coarse face region; superseded by yolov8n-face.",
    },
  };

  const ACTIVE_MODEL = "yolov8n-face";

  const ORT_ESM = "lib/vendor/ort/ort-webgpu-api.mjs";
  const ORT_DIR = "lib/vendor/ort/";
  const TRANSFORMERS_BUNDLE = "lib/vendor/transformers/transformers.min.js";

  let _available = false;
  let _initTried = false;
  let _warmupMs = null;
  let _epUsed = null;
  // onnx-yolo runtime state
  let _ort = null, _session = null, _yoloCfg = null;
  // transformers runtime state
  let _tfMod = null, _tfDetector = null;

  // Resolve a packaged file to a same-origin URL (extension context).
  function pkgUrl(rel) {
    try {
      const ext = G.chrome || G.browser;
      if (ext && ext.runtime && ext.runtime.getURL) return ext.runtime.getURL(rel);
    } catch (_) {}
    return rel;
  }

  // ── shared YOLO pre/post (mirrors eval/face_probe.js so Node + browser agree) ──

  // Letterbox an RGBA raster to size×size (pad 114 gray, keep aspect) → NCHW float [0,1].
  async function letterbox(image, size) {
    const W = image.width, H = image.height;
    const scale = Math.min(size / W, size / H);
    const nW = Math.round(W * scale), nH = Math.round(H * scale);
    const padX = Math.floor((size - nW) / 2), padY = Math.floor((size - nH) / 2);
    const clamped = image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);
    const bmp = await createImageBitmap(new ImageData(clamped, W, H));
    const cv = new OffscreenCanvas(size, size);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "rgb(114,114,114)"; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(bmp, padX, padY, nW, nH);
    if (bmp.close) bmp.close();
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const plane = size * size, chw = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      chw[i] = rgba[i * 4] / 255;
      chw[plane + i] = rgba[i * 4 + 1] / 255;
      chw[2 * plane + i] = rgba[i * 4 + 2] / 255;
    }
    return { chw, scale, padX, padY };
  }

  // Decode a YOLOv8 output tensor → boxes in ORIGINAL image px, then NMS.
  function decodeYolo(out, cfg, scale, padX, padY) {
    const dims = out.dims, d = out.data;
    let C, N, cf;
    if (dims[1] <= dims[2]) { C = dims[1]; N = dims[2]; cf = true; }   // [1,C,N]
    else { C = dims[2]; N = dims[1]; cf = false; }                     // [1,N,C]
    const at = (c, n) => (cf ? d[c * N + n] : d[n * C + c]);
    const si = cfg.scoreIndex;
    const cand = [];
    for (let n = 0; n < N; n++) {
      const score = at(si, n);
      if (score < cfg.minScore) continue;
      const cx = at(0, n), cy = at(1, n), w = at(2, n), h = at(3, n);
      cand.push({ x: (cx - w / 2 - padX) / scale, y: (cy - h / 2 - padY) / scale, w: w / scale, h: h / scale, score });
    }
    cand.sort((a, b) => b.score - a.score);
    const iou = (a, b) => {
      const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
      const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const uni = a.w * a.h + b.w * b.h - inter;
      return uni <= 0 ? 0 : inter / uni;
    };
    const keep = [];
    for (const b of cand) if (keep.every((k) => iou(k, b) < cfg.nmsIou)) keep.push(b);
    return keep;
  }

  // ── onnx-yolo runtime ──────────────────────────────────────────────────────
  async function createOnnxYolo(cfg) {
    const ort = await import(pkgUrl(ORT_ESM));
    try { if (ort.env && ort.env.wasm) ort.env.wasm.wasmPaths = pkgUrl(ORT_DIR); } catch (_) {}
    const buf = await (await fetch(pkgUrl(cfg.modelFile))).arrayBuffer();
    let session = null, ep = null, lastErr = null;
    for (const cand of cfg.ep) {
      try { session = await ort.InferenceSession.create(buf, { executionProviders: [cand] }); ep = cand; break; }
      catch (e) { lastErr = e; }
    }
    if (!session) throw new Error("no execution provider could load the model" + (lastErr ? ": " + lastErr.message : ""));
    _ort = ort; _session = session; _epUsed = ep; _yoloCfg = cfg;
  }

  async function detectOnnxYolo(image) {
    const cfg = _yoloCfg;
    const { chw, scale, padX, padY } = await letterbox(image, cfg.size);
    const name = (_session.inputNames && _session.inputNames.includes(cfg.inputName)) ? cfg.inputName : _session.inputNames[0];
    const feeds = {}; feeds[name] = new _ort.Tensor("float32", chw, [1, 3, cfg.size, cfg.size]);
    const results = await _session.run(feeds);
    const out = results[_session.outputNames[0]];
    const keep = decodeYolo(out, cfg, scale, padX, padY);
    return keep
      .map((b) => ({
        pii_type: cfg.category,
        bbox: [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)],
        confidence: +Number(b.score).toFixed(3),
      }))
      .filter((d) => d.bbox[2] > 0 && d.bbox[3] > 0);
  }

  // Full graph on a gray frame once so kernel-compile / weight-upload happen before
  // the first REAL screenshot (hides cold-start; ~3.6s the first time on WebGPU).
  async function warmupOnnxYolo(cfg) {
    const w = cfg.size, h = cfg.size, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 200; data[i + 3] = 255; }
    await detectOnnxYolo({ data, width: w, height: h });
  }

  // ── transformers runtime (legacy fallback) ─────────────────────────────────
  async function createTransformers(cfg) {
    _tfMod = await import(pkgUrl(TRANSFORMERS_BUNDLE));
    const { pipeline, env } = _tfMod;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = pkgUrl("models/");
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = pkgUrl(ORT_DIR);
      env.backends.onnx.wasm.proxy = true;
    }
    _tfDetector = await pipeline(cfg.task, ACTIVE_MODEL, { device: cfg.device, dtype: cfg.dtype });
    _epUsed = cfg.device;
  }

  function tfWarmupFrame(RawImage) {
    const w = 64, h = 64, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 200; data[i + 3] = 255; }
    return new RawImage(data, w, h, 4);
  }

  async function detectTransformers(image) {
    const cfg = REGISTRY[ACTIVE_MODEL];
    const raw = new _tfMod.RawImage(image.data, image.width, image.height, 4);
    const out = await _tfDetector(raw, { threshold: cfg.minScore, percentage: false });
    const dets = [];
    for (const r of out || []) {
      const cat = cfg.labels[(r.label || "").toLowerCase()];
      if (!cat || (r.score || 0) < cfg.minScore) continue;
      const b = r.box || {};
      const x = Math.round(b.xmin), y = Math.round(b.ymin);
      const w = Math.round(b.xmax - b.xmin), h = Math.round(b.ymax - b.ymin);
      if (w > 0 && h > 0) dets.push({ pii_type: cat, bbox: [x, y, w, h], confidence: +Number(r.score).toFixed(3) });
    }
    return dets;
  }

  // ── public API ──────────────────────────────────────────────────────────────
  async function init() {
    if (_initTried) return { available: _available };
    _initTried = true;
    const cfg = REGISTRY[ACTIVE_MODEL];
    try {
      if (cfg.runtime === "onnx-yolo") {
        await createOnnxYolo(cfg);
        if (cfg.warmup) { try { const t0 = Date.now(); await warmupOnnxYolo(cfg); _warmupMs = Date.now() - t0; } catch (_) {} }
      } else {
        await createTransformers(cfg);
        if (cfg.warmup) { try { const t0 = Date.now(); await _tfDetector(tfWarmupFrame(_tfMod.RawImage), { threshold: 1.1 }); _warmupMs = Date.now() - t0; } catch (_) {} }
      }
      _available = true;
      G.PBA.visionNeural._model = ACTIVE_MODEL;
      G.PBA.visionNeural._ep = _epUsed;
    } catch (_) {
      // Not vendored (or failed to load) → stay silent; the classical core runs.
      _available = false;
    }
    return { available: _available };
  }

  /**
   * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} image RGBA raster (device px)
   * @returns {Promise<Array<{pii_type,bbox,confidence}>>} boxes in IMAGE (device) pixels
   */
  async function detect(image) {
    if (!_available) return [];
    const cfg = REGISTRY[ACTIVE_MODEL];
    try {
      return cfg.runtime === "onnx-yolo" ? await detectOnnxYolo(image) : await detectTransformers(image);
    } catch (_) {
      return [];
    }
  }

  G.PBA.visionNeural = {
    init, detect,
    get available() { return _available; },
    get model() { return _available ? ACTIVE_MODEL : null; },
    get warmupMs() { return _warmupMs; },
    get ep() { return _epUsed; },
    REGISTRY, ACTIVE_MODEL,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = G.PBA.visionNeural;
})();
