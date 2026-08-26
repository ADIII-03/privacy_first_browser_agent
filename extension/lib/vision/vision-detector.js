/*
 * vision-detector.js — On-device visual perception (built-in, dependency-free).
 *
 * Implements "Local Vision Processing" from the problem statement: a client-side
 * detector that evaluates the current screen pixels and returns bounding boxes for
 * visual PII the DOM can't explain — human FACES and handwritten SIGNATURES —
 * entirely on the device. No network, no model download, no external library.
 *
 * WHY CLASSICAL CV (and not only a neural net):
 *   - It runs anywhere with zero weights to ship (CSP forbids CDN scripts; a
 *     neural model must be vendored — see vision-neural.js, which this file uses
 *     automatically when present).
 *   - The ALGORITHM CORE is a pure function over an RGBA buffer, so the exact code
 *     that runs in the browser is what eval/vision_eval.js scores in Node. What we
 *     ship == what we benchmark (Metric #1), with no separate reimplementation.
 *   - WebGPU is used as an ACCELERATOR over the identical per-pixel classification;
 *     the CPU path is authoritative and the GPU path is only trusted after a
 *     runtime self-test proves it matches the CPU output (see _verifyGpu).
 *
 * PIPELINE (per frame):
 *   pixels ──classify──► per-pixel class (skin | ink | none)
 *          ──aggregate─► coarse cell grid (cheap connected components)
 *          ──filter────► regions passing face / signature geometry priors
 *   Boxes come out in IMAGE (device) pixels; detect() converts them to CSS pixels
 *   (÷ dpr) so they live in the same coordinate space as the DOM signals that
 *   fusion.js and policy.js expect.
 *
 * Detections feed the UNION-biased fusion layer, so this detector is tuned to
 * favour recall (a missed face is a privacy leak; an over-redaction is a utility
 * cost the policy engine and server tolerate) — consistent with the fail-closed
 * stance of the whole system.
 */
(function () {
  // Dual context: browser (self===globalThis, namespace self.PBA) and Node (eval
  // harness require()s this file). Mirrors the pattern in privacy/pii-regex.js.
  const G = (typeof globalThis !== "undefined") ? globalThis : this;
  G.PBA = G.PBA || {};
  const PII = (G.PBA.PII) || { FACE: "face", SIGNATURE: "signature" };

  // ---- tunable thresholds ------------------------------------------------
  // Grouped in one object so eval and callers can override per-call. Defaults are
  // recall-leaning for faces and conservative for signatures (signatures are the
  // easier false-positive source on ordinary text-heavy pages).
  const DEFAULT_CFG = Object.freeze({
    // cell grid: side length is derived from image size but clamped to this range.
    cellMin: 2,
    cellMax: 10,
    cellDivisor: 200, // cell ≈ min(w,h)/cellDivisor, clamped to [cellMin,cellMax]

    // skin (face) classification — YCbCr chrominance box + an RGB daylight rule.
    cbMin: 77, cbMax: 127, crMin: 133, crMax: 173,
    skinCellCoverage: 0.5, // a grid cell counts as skin if ≥ this fraction is skin

    // face region geometry priors
    faceMinDim: 20, // px, min width AND height of a face box
    faceFillMin: 0.45, // skin pixels / bbox area (ellipse fills ~0.55–0.79)
    faceAspectMin: 0.5, faceAspectMax: 2.0, // w/h; portraits-to-slightly-wide
    faceMinAreaFrac: 0.0006, // ignore specks smaller than this fraction of frame

    // ink (signature) classification — dark stroke on a light local background.
    inkLumaMax: 95, // Y below this is "ink"
    bgLumaMin: 150, // frame is treated as light-background; strokes are the dark part
    inkCellMin: 2, // ≥ this many ink px in a cell marks the cell (connects strokes)
    sigDilateX: 3, // horizontal morphological closing (cells) to bridge pen-lift gaps

    // signature region geometry priors (deliberately strict to limit over-fire)
    sigMinWidth: 55, // px; signatures sprawl horizontally
    sigMaxHeight: 130, // px; taller dark blobs are photos/figures, not a signature
    sigMinHeight: 8,
    sigAspectMin: 2.4, // wide-and-short
    sigFillMin: 0.03, sigFillMax: 0.34, // sparse strokes; dense blocks are not signatures
  });

  function cellSizeFor(w, h, cfg) {
    const s = Math.round(Math.min(w, h) / cfg.cellDivisor);
    return Math.max(cfg.cellMin, Math.min(cfg.cellMax, s || cfg.cellMin));
  }

  // ---- per-pixel classification (CPU; authoritative) ---------------------
  // Returns a Uint8Array `cls` (0=none, 1=skin, 2=ink), one entry per pixel.
  // Skin and ink are near-disjoint (skin is bright, ink is dark); skin wins ties.
  function computeMasksCPU(image, cfg) {
    const { data, width, height } = image;
    const n = width * height;
    const cls = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
      if (a < 24) continue; // fully/near transparent → background
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const ycc = cb >= cfg.cbMin && cb <= cfg.cbMax && cr >= cfg.crMin && cr <= cfg.crMax;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const rgb = r > 95 && g > 40 && b > 20 && (mx - mn) > 15 && (r - g) > 15 && r > b;
      if (ycc || rgb) { cls[i] = 1; continue; } // skin
      if (y < cfg.inkLumaMax) cls[i] = 2; // ink (dark)
    }
    return cls;
  }

  // ---- aggregate per-pixel class → coarse cell grid ----------------------
  // Cheap connected-components run on the grid, not the full raster. We keep two
  // counts per cell so region fill ratios can be computed in pixel units.
  function gridFromCls(cls, width, height, S) {
    const gw = Math.ceil(width / S), gh = Math.ceil(height / S);
    const skin = new Int32Array(gw * gh);
    const ink = new Int32Array(gw * gh);
    for (let y = 0; y < height; y++) {
      const gy = (y / S) | 0;
      const row = y * width;
      const grow = gy * gw;
      for (let x = 0; x < width; x++) {
        const c = cls[row + x];
        if (!c) continue;
        const gi = grow + ((x / S) | 0);
        if (c === 1) skin[gi]++; else ink[gi]++;
      }
    }
    return { gw, gh, skin, ink };
  }

  // 8-connected component labelling over a boolean predicate on grid cells.
  // Returns components as {x0,y0,x1,y1 (cell coords, inclusive), cells, sum}
  // where `sum` accumulates the chosen per-cell count (skin or ink pixels).
  function components(grid, on, count) {
    const { gw, gh } = grid;
    const seen = new Uint8Array(gw * gh);
    const out = [];
    const stack = [];
    for (let start = 0; start < gw * gh; start++) {
      if (seen[start] || !on(start)) continue;
      seen[start] = 1;
      stack.length = 0;
      stack.push(start);
      let x0 = gw, y0 = gh, x1 = -1, y1 = -1, cells = 0, sum = 0;
      while (stack.length) {
        const idx = stack.pop();
        const cx = idx % gw, cy = (idx / gw) | 0;
        cells++; sum += count[idx];
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const ni = ny * gw + nx;
            if (seen[ni] || !on(ni)) continue;
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
      out.push({ x0, y0, x1, y1, cells, sum });
    }
    return out;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- region → detection filters ----------------------------------------
  function regionsFromCls(cls, width, height, cfg) {
    const S = cellSizeFor(width, height, cfg);
    const grid = gridFromCls(cls, width, height, S);
    const frameArea = width * height;
    const cellArea = S * S;
    const detections = [];

    // FACES: solid skin blobs of face-like aspect and fill.
    const skinOn = (i) => grid.skin[i] / cellArea >= cfg.skinCellCoverage;
    for (const c of components(grid, skinOn, grid.skin)) {
      const x = c.x0 * S, y = c.y0 * S;
      const w = Math.min(width, (c.x1 + 1) * S) - x;
      const h = Math.min(height, (c.y1 + 1) * S) - y;
      if (w < cfg.faceMinDim || h < cfg.faceMinDim) continue;
      if (w * h < cfg.faceMinAreaFrac * frameArea) continue;
      const aspect = w / h;
      if (aspect < cfg.faceAspectMin || aspect > cfg.faceAspectMax) continue;
      const fill = c.sum / (w * h);
      if (fill < cfg.faceFillMin) continue;
      const sizePrior = clamp((w * h) / (frameArea * 0.08), 0, 1) * 0.15;
      const confidence = clamp(0.55 + 0.35 * ((fill - cfg.faceFillMin) / (1 - cfg.faceFillMin)) + sizePrior, 0.5, 0.97);
      detections.push({ pii_type: PII.FACE, bbox: [x, y, w, h], confidence: +confidence.toFixed(3) });
    }

    // SIGNATURES: wide, short, SPARSE dark-ink components on a light background.
    // The frame must be predominantly light or we skip signature detection (a dark
    // UI theme makes "dark stroke on light bg" meaningless and floods false hits).
    if (frameMeanLuma(cls, grid) >= 0) {
      // Horizontal morphological closing bridges pen-lift gaps along the writing
      // direction so a multi-stroke signature is one component (real signatures
      // have gaps). Vertical structure (text rows) is NOT bridged, so it does not
      // merge paragraphs into a signature.
      const inkDil = dilateXInk(grid, cfg);
      const inkOn = (i) => inkDil[i] === 1;
      for (const c of components(grid, inkOn, grid.ink)) {
        const x = c.x0 * S, y = c.y0 * S;
        const w = Math.min(width, (c.x1 + 1) * S) - x;
        const h = Math.min(height, (c.y1 + 1) * S) - y;
        if (w < cfg.sigMinWidth) continue;
        if (h < cfg.sigMinHeight || h > cfg.sigMaxHeight) continue;
        if (w / h < cfg.sigAspectMin) continue;
        const fill = c.sum / (w * h);
        if (fill < cfg.sigFillMin || fill > cfg.sigFillMax) continue;
        const confidence = clamp(0.55 + 0.2 * (1 - Math.abs(fill - 0.15) / 0.15), 0.5, 0.78);
        detections.push({ pii_type: PII.SIGNATURE, bbox: [x, y, w, h], confidence: +confidence.toFixed(3) });
      }
    }
    return detections;
  }

  // Signature detection only makes sense on light-background frames. We store no
  // separate luma pass; approximate "mostly light" from the ink coverage instead:
  // if a huge fraction of the frame is ink, it's a dark theme, not strokes.
  function frameMeanLuma(cls, grid) {
    let ink = 0, tot = grid.skin.length;
    for (let i = 0; i < tot; i++) if (grid.ink[i]) ink++;
    // return ≥0 (proceed) when ink cells are a minority, <0 (skip) otherwise.
    return ink < tot * 0.55 ? 1 : -1;
  }

  // Horizontal-only dilation of the ink cell mask (a closing along the writing
  // direction). Returns a Uint8Array marking cells that are "on" after bridging
  // gaps up to cfg.sigDilateX cells wide. Kept horizontal so it merges pen lifts
  // but not stacked text rows.
  function dilateXInk(grid, cfg) {
    const { gw, gh, ink } = grid;
    const on = new Uint8Array(gw * gh);
    const r = cfg.sigDilateX | 0;
    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        if (ink[row + x] < cfg.inkCellMin) continue;
        const lo = Math.max(0, x - r), hi = Math.min(gw - 1, x + r);
        for (let nx = lo; nx <= hi; nx++) on[row + nx] = 1;
      }
    }
    return on;
  }

  /**
   * PURE CORE — the function eval/vision_eval.js scores.
   * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} image  RGBA raster
   * @param {object} [opts] threshold overrides (see DEFAULT_CFG)
   * @returns {Array<{pii_type:string, bbox:[number,number,number,number], confidence:number}>}
   *   boxes in IMAGE pixel coordinates.
   */
  function detectSensitiveRegions(image, opts) {
    if (!image || !image.data || !image.width || !image.height) return [];
    const cfg = opts ? Object.assign({}, DEFAULT_CFG, opts) : DEFAULT_CFG;
    const cls = computeMasksCPU(image, cfg);
    return regionsFromCls(cls, image.width, image.height, cfg);
  }

  // ---- WebGPU accelerator (best-effort, self-verified) -------------------
  // The shader performs the SAME per-pixel classification as computeMasksCPU and
  // writes a class byte per pixel. We only ever trust it after _verifyGpu() proves
  // its output matches the CPU classifier on a known probe — so a shader bug can
  // never change what gets redacted; it just falls back to CPU.
  const WGSL = `
struct Cfg { cbMin:f32, cbMax:f32, crMin:f32, crMax:f32, inkLumaMax:f32, w:u32, h:u32, _pad:u32 };
@group(0) @binding(0) var<storage, read> px : array<u32>;      // packed RGBA, one u32/pixel
@group(0) @binding(1) var<storage, read_write> out : array<u32>; // class per pixel
@group(0) @binding(2) var<uniform> cfg : Cfg;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= cfg.w * cfg.h) { return; }
  let v = px[i];
  let r = f32(v & 0xffu);
  let g = f32((v >> 8u) & 0xffu);
  let b = f32((v >> 16u) & 0xffu);
  let a = f32((v >> 24u) & 0xffu);
  if (a < 24.0) { out[i] = 0u; return; }
  let y  = 0.299*r + 0.587*g + 0.114*b;
  let cb = 128.0 - 0.168736*r - 0.331264*g + 0.5*b;
  let cr = 128.0 + 0.5*r - 0.418688*g - 0.081312*b;
  let ycc = cb >= cfg.cbMin && cb <= cfg.cbMax && cr >= cfg.crMin && cr <= cfg.crMax;
  let mx = max(r, max(g, b));
  let mn = min(r, min(g, b));
  let rgb = r > 95.0 && g > 40.0 && b > 20.0 && (mx - mn) > 15.0 && (r - g) > 15.0 && r > b;
  if (ycc || rgb) { out[i] = 1u; return; }
  if (y < cfg.inkLumaMax) { out[i] = 2u; } else { out[i] = 0u; }
}`;

  let _gpu = { device: null, tried: false, ok: false };

  async function _initGpu() {
    if (_gpu.tried) return _gpu.ok;
    _gpu.tried = true;
    try {
      if (!(typeof navigator !== "undefined" && navigator.gpu)) return false;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      _gpu.device = await adapter.requestDevice();
      _gpu.module = _gpu.device.createShaderModule({ code: WGSL });
      _gpu.pipeline = _gpu.device.createComputePipeline({ layout: "auto", compute: { module: _gpu.module, entryPoint: "main" } });
      _gpu.ok = await _verifyGpu();
      return _gpu.ok;
    } catch (_) { return (_gpu.ok = false); }
  }

  // Pack an RGBA raster into one u32 per pixel (little-endian: R in low byte).
  function packRGBA(image) {
    const { data, width, height } = image;
    const out = new Uint32Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24);
    }
    return out;
  }

  async function _gpuClassify(image, cfg) {
    const dev = _gpu.device;
    const n = image.width * image.height;
    const packed = packRGBA(image);
    const inBuf = dev.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(inBuf, 0, packed);
    const outBuf = dev.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const cfgArr = new Float32Array([cfg.cbMin, cfg.cbMax, cfg.crMin, cfg.crMax, cfg.inkLumaMax, 0, 0, 0]);
    const cfgU32 = new Uint32Array(cfgArr.buffer); cfgU32[5] = image.width; cfgU32[6] = image.height;
    const cfgBuf = dev.createBuffer({ size: cfgArr.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(cfgBuf, 0, cfgArr);
    const bind = dev.createBindGroup({
      layout: _gpu.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inBuf } },
        { binding: 1, resource: { buffer: outBuf } },
        { binding: 2, resource: { buffer: cfgBuf } },
      ],
    });
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(_gpu.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    const read = dev.createBuffer({ size: n * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(outBuf, 0, read, 0, n * 4);
    dev.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const u32 = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap();
    const cls = new Uint8Array(n);
    for (let i = 0; i < n; i++) cls[i] = u32[i];
    [inBuf, outBuf, cfgBuf, read].forEach((b) => b.destroy && b.destroy());
    return cls;
  }

  // Probe: 4 pixels covering skin / ink / white / transparent. GPU must agree with CPU.
  async function _verifyGpu() {
    const probe = {
      width: 4, height: 1,
      data: new Uint8ClampedArray([
        198, 134, 66, 255,   // medium skin  → 1
        10, 10, 10, 255,     // dark ink     → 2
        245, 245, 245, 255,  // near-white   → 0
        0, 0, 0, 0,          // transparent  → 0
      ]),
    };
    try {
      const gpu = await _gpuClassify(probe, DEFAULT_CFG);
      const cpu = computeMasksCPU(probe, DEFAULT_CFG);
      for (let i = 0; i < cpu.length; i++) if (gpu[i] !== cpu[i]) return false;
      return true;
    } catch (_) { return false; }
  }

  // ---- image decode (browser/offscreen only) -----------------------------
  async function imageDataFromUrl(dataUrl) {
    const res = await fetch(dataUrl);
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close && bmp.close();
    return { data: img.data, width: img.width, height: img.height };
  }

  // ---- public browser API ------------------------------------------------
  let _ready = false;
  let _backend = "cpu";

  async function init() {
    const gpuOk = await _initGpu();
    _backend = gpuOk ? "webgpu" : "cpu";
    // A neural detector (vision-neural.js), if vendored, augments the built-in one.
    if (G.PBA.visionNeural && G.PBA.visionNeural.init) {
      try { await G.PBA.visionNeural.init(); } catch (_) {}
    }
    _ready = true; // CPU fallback guarantees the detector is always available.
    return { backend: _backend, neural: !!(G.PBA.visionNeural && G.PBA.visionNeural.available), ready: _ready };
  }

  /**
   * @param {string} imageDataUrl  device-pixel screenshot (from captureVisibleTab)
   * @param {{dpr?:number}} [opts]
   * @returns {Promise<{detections:Array<{pii_type,bbox,confidence}>, ready:boolean, backend:string}>}
   *   bbox is in CSS-pixel VIEWPORT coordinates (device px ÷ dpr) to match DOM signals.
   */
  async function detect(imageDataUrl, opts) {
    if (!_ready) await init();
    const dpr = (opts && opts.dpr) || 1;
    let image;
    try { image = await imageDataFromUrl(imageDataUrl); }
    catch (e) { return { detections: [], ready: _ready, backend: _backend, error: String(e && e.message || e) }; }

    // Classify (GPU if verified, else CPU), then run the shared region filters.
    let cls;
    if (_gpu.ok) { try { cls = await _gpuClassify(image, DEFAULT_CFG); } catch (_) { cls = null; } }
    if (!cls) cls = computeMasksCPU(image, DEFAULT_CFG);
    let detections = regionsFromCls(cls, image.width, image.height, DEFAULT_CFG);

    // Optional neural detections (faces + signatures via vendored YOLO models), merged in.
    if (G.PBA.visionNeural && G.PBA.visionNeural.available) {
      try {
        // SIGNATURES: the neural model REPLACES the classical heuristic when vendored.
        // That heuristic (wide + short + sparse dark ink) over-fires massively on text —
        // underlines, rules and text lines all match its shape, e.g. 51 phantom
        // "signatures" on a receipt — so once the model is loaded we drop the classical
        // signature boxes and keep only the model's. Faces stay UNION-merged (recall-
        // leaning by design). If the signature model isn't vendored, covers() is false
        // and the classical branch still runs — no coverage loss (fail-safe).
        const covers = G.PBA.visionNeural.covers;
        if (typeof covers === "function" && covers(PII.SIGNATURE)) {
          detections = detections.filter((d) => d.pii_type !== PII.SIGNATURE);
        }
        const extra = await G.PBA.visionNeural.detect(image);
        if (Array.isArray(extra)) detections = detections.concat(extra);
      } catch (_) {}
    }

    // Convert IMAGE (device) px → CSS px so boxes fuse with getBoundingClientRect.
    // Round to integers: DOM boxes are already Math.round'd, the compositor draws
    // whole pixels, and the wire schema (Redaction.bbox: List[int]) rejects floats —
    // which is exactly what a fractional dpr (e.g. Windows 150% → 1.5) would produce.
    const s = 1 / dpr;
    const scaled = detections.map((d) => ({
      pii_type: d.pii_type,
      bbox: [Math.round(d.bbox[0] * s), Math.round(d.bbox[1] * s),
             Math.round(d.bbox[2] * s), Math.round(d.bbox[3] * s)],
      confidence: d.confidence,
    }));
    return { detections: scaled, ready: _ready, backend: _backend };
  }

  const api = {
    detect, init,
    detectSensitiveRegions, // pure core (used by eval + neural-merge)
    computeMasksCPU, regionsFromCls, // exposed for testing / reuse
    DEFAULT_CFG,
    get ready() { return _ready; },
    get backend() { return _backend; },
  };

  G.PBA.vision = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
