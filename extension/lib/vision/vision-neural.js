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
 * ACTIVE_MODELS (below) loads MORE THAN ONE detector; detect() runs each and
 * concatenates. Both defaults are onnx-yolo with the SAME [1,5,N] head, so they share
 * letterbox→NCHW→decode(score@idx)→NMS unchanged, differing only in REGISTRY cfg:
 *   • yolov8n-face   → FACE       (~33 ms WASM / ~46 ms WebGPU; tight boxes, no COCO junk)
 *   • yolo-signature → SIGNATURE  (YOLOv11n, MIT/ChiSig; REPLACES the classical heuristic)
 * Face timings measured by eval/face_probe.js and eval/webgpu_face_probe.html. A model
 * that COVERS a PII type lets the classical layer drop its own noisier boxes (see covers()).
 *
 * ── VENDORING (CSP `script-src 'self' 'wasm-unsafe-eval'` forbids CDN at runtime) ─
 *     node tools/vendor-vision.mjs
 * populates (all .gitignore'd, packaged same-origin, loaded from the offscreen doc):
 *   lib/vendor/ort/ort-webgpu-api.mjs + ort-*.wasm/.mjs   (onnxruntime-web ESM + backends)
 *   models/yolov8n-face/model.onnx     (FACE; local export, copied in)
 *   models/yolo-signature/model.onnx   (SIGNATURE; downloaded, MIT/ChiSig YOLOv11n)
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
    // ── signature detector, raw onnxruntime-web (REPLACES the classical heuristic) ──
    // YOLOv11n single-class detect head → output [1,5,8400] = 4 box + 1 score
    // (index 4). SAME [1,5,N] shape and decode as the face model. MIT-licensed,
    // ChiSig-trained (handwritten signature regions); precise where the classical
    // "wide+short+sparse dark ink" heuristic drowned in text false-positives.
    "yolo-signature": {
      runtime: "onnx-yolo",
      modelFile: "models/yolo-signature/model.onnx",
      inputName: "images",         // confirmed via eval/inspect_onnx.cjs
      size: 640,                   // letterbox square
      scoreIndex: 4,               // channel holding the signature confidence
      minScore: 0.35,              // tune: ↑ fewer FPs on web pages, ↓ more recall
      nmsIou: 0.45,
      category: PII.SIGNATURE,
      ep: ["webgpu", "wasm"],
      warmup: true,
      note: "handwritten-signature detector; single class → SIGNATURE; replaces classical.",
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

  const ACTIVE_MODELS = ["yolov8n-face", "yolo-signature"];

  const ORT_ESM = "lib/vendor/ort/ort-webgpu-api.mjs";
  const ORT_DIR = "lib/vendor/ort/";
  const TRANSFORMERS_BUNDLE = "lib/vendor/transformers/transformers.min.js";

  let _available = false;
  let _initTried = false;
  // Per-model runtime records, keyed by REGISTRY id — each holds its own loaded
  // session/detector + the EP it landed on, so models load and fail independently.
  //   onnx-yolo:    { id, runtime, cfg, ort, session, ep, warmupMs }
  //   transformers: { id, runtime, cfg, mod, detector, ep, warmupMs }
  const _models = new Map();
  // PII categories the loaded models cover — the hook the classical layer reads to
  // know a type is handled neurally (so it can drop its noisier classical boxes).
  let _categories = new Set();

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
  async function createOnnxYolo(id, cfg) {
    const ort = await import(pkgUrl(ORT_ESM));
    try { if (ort.env && ort.env.wasm) ort.env.wasm.wasmPaths = pkgUrl(ORT_DIR); } catch (_) {}
    const buf = await (await fetch(pkgUrl(cfg.modelFile))).arrayBuffer();
    let session = null, ep = null, lastErr = null;
    for (const cand of cfg.ep) {
      try { session = await ort.InferenceSession.create(buf, { executionProviders: [cand] }); ep = cand; break; }
      catch (e) { lastErr = e; }
    }
    if (!session) throw new Error("no execution provider could load the model" + (lastErr ? ": " + lastErr.message : ""));
    return { id, runtime: "onnx-yolo", cfg, ort, session, ep };
  }

  async function detectOnnxYolo(rec, image) {
    const { cfg, ort, session } = rec;
    const { chw, scale, padX, padY } = await letterbox(image, cfg.size);
    const name = (session.inputNames && session.inputNames.includes(cfg.inputName)) ? cfg.inputName : session.inputNames[0];
    const feeds = {}; feeds[name] = new ort.Tensor("float32", chw, [1, 3, cfg.size, cfg.size]);
    const results = await session.run(feeds);
    const out = results[session.outputNames[0]];
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
  async function warmupOnnxYolo(rec) {
    const w = rec.cfg.size, h = rec.cfg.size, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 200; data[i + 3] = 255; }
    await detectOnnxYolo(rec, { data, width: w, height: h });
  }

  // ── transformers runtime (legacy fallback) ─────────────────────────────────
  async function createTransformers(id, cfg) {
    const mod = await import(pkgUrl(TRANSFORMERS_BUNDLE));
    const { pipeline, env } = mod;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = pkgUrl("models/");
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = pkgUrl(ORT_DIR);
      env.backends.onnx.wasm.proxy = true;
    }
    const detector = await pipeline(cfg.task, id, { device: cfg.device, dtype: cfg.dtype });
    return { id, runtime: "transformers", cfg, mod, detector, ep: cfg.device };
  }

  function tfWarmupFrame(RawImage) {
    const w = 64, h = 64, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 200; data[i + 3] = 255; }
    return new RawImage(data, w, h, 4);
  }

  async function detectTransformers(rec, image) {
    const { cfg, mod, detector } = rec;
    const raw = new mod.RawImage(image.data, image.width, image.height, 4);
    const out = await detector(raw, { threshold: cfg.minScore, percentage: false });
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
    // Load every ACTIVE model independently — a missing/broken one is skipped, the
    // rest still load, and its PII type simply falls back to the classical core.
    for (const id of ACTIVE_MODELS) {
      const cfg = REGISTRY[id];
      if (!cfg) continue;
      try {
        let rec;
        if (cfg.runtime === "onnx-yolo") {
          rec = await createOnnxYolo(id, cfg);
          if (cfg.warmup) { try { const t0 = Date.now(); await warmupOnnxYolo(rec); rec.warmupMs = Date.now() - t0; } catch (_) {} }
        } else {
          rec = await createTransformers(id, cfg);
          if (cfg.warmup) { try { const t0 = Date.now(); await rec.detector(tfWarmupFrame(rec.mod.RawImage), { threshold: 1.1 }); rec.warmupMs = Date.now() - t0; } catch (_) {} }
        }
        _models.set(id, rec);
      } catch (_) {
        // This model isn't vendored (or failed to load) → skip it. Fail-open per
        // model; the classical core still guarantees baseline coverage for its type.
      }
    }
    _available = _models.size > 0;
    // Cache the union of covered PII types once (models are fixed after init).
    _categories = new Set();
    for (const rec of _models.values()) {
      if (rec.cfg.category) _categories.add(rec.cfg.category);
      if (rec.cfg.labels) for (const v of Object.values(rec.cfg.labels)) _categories.add(v);
    }
    return { available: _available };
  }

  /**
   * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} image RGBA raster (device px)
   * @returns {Promise<Array<{pii_type,bbox,confidence}>>} boxes in IMAGE (device) pixels, all models concatenated
   */
  async function detect(image) {
    if (!_models.size) return [];
    const all = [];
    // Sequential (not Promise.all): the models share the offscreen thread and one
    // GPU/WASM backend, so serial runs avoid EP contention. Two nano models ≈ 80ms.
    for (const rec of _models.values()) {
      try {
        const dets = rec.runtime === "onnx-yolo" ? await detectOnnxYolo(rec, image) : await detectTransformers(rec, image);
        for (const d of dets) all.push(d);
      } catch (_) { /* one model failing must not sink the others */ }
    }
    return all;
  }

  // Does a loaded model handle this PII type? The classical layer calls this to
  // decide whether to drop its own (noisier) boxes of that type. False when the
  // relevant model isn't vendored → the classical branch stays as the fallback.
  function covers(piiType) { return _categories.has(piiType); }

  G.PBA.visionNeural = {
    init, detect, covers,
    get available() { return _available; },
    get models() { return [..._models.keys()]; },
    get categories() { return [..._categories]; },
    // Sum of per-model cold-starts (total warmup paid at init); null if none warmed.
    get warmupMs() { let s = 0, any = false; for (const r of _models.values()) if (r.warmupMs != null) { s += r.warmupMs; any = true; } return any ? s : null; },
    // Representative execution provider (first loaded); the models usually share one.
    get ep() { for (const r of _models.values()) return r.ep; return null; },
    REGISTRY, ACTIVE_MODELS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = G.PBA.visionNeural;
})();
