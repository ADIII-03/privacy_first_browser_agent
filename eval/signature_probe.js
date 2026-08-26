/*
 * signature_probe.js — validate the vendored SIGNATURE model the same way
 * face_probe.js validated YOLOv8n-face, so the numbers are directly comparable and
 * the pre/post here is IDENTICAL to the in-browser path (vision-neural.js).
 *
 * Why this exists: the signature model (HF liberty666/yolo11n-chinese-signature,
 * YOLOv11n, single-class [1,5,N] head) was INTEGRATED but never PROBED. It is
 * ChiSig-trained (CHINESE handwritten signatures); the integration ASSUMES it
 * generalizes to Latin/cursive signatures, with zero evidence. On the Alan Turing
 * Wikipedia page the live receipt showed 0 signatures even though the page contains
 * his signature — which could be a RECALL MISS, not a precision win.
 *
 * Three separable reasons the live run could read 0:
 *   (1) FRAMING — captureVisibleTab grabs only the viewport; the sig may not have
 *       been on-screen in the frames where the face fired.
 *   (2) SCALE   — the frame is downscaled to fit 640 (a ~1920px viewport shrinks ~3x),
 *       so a small on-page signature reaches the model tiny (~17px tall) + JPEG'd.
 *   (3) SCRIPT  — a Chinese-trained model may simply not fire on Latin cursive.
 *
 * THIS probe isolates (3) from (1)+(2): it feeds CLEAN, FRAME-FILLING signature
 * crops (letterbox upscales them to fill 640), removing all framing/scale confounds.
 *   • If the model FIRES here  -> it CAN do Latin sigs; the live miss was framing/scale
 *     (fixable in the capture pipeline: higher-res capture, tiling, or region upscale).
 *   • If it stays SILENT here  -> it's the script problem; no pipeline tuning helps,
 *     swap the model (train/collect a Latin-signature YOLOv8n, or a different weight).
 *
 * It runs in Node via onnxruntime-node + sharp (same as face_probe.js). Unlike
 * face_probe it prints the TOP RAW candidates BEFORE any threshold + a threshold
 * SWEEP, because minScore (0.35) is UNTUNED — the single most informative number for
 * recall is "what is the highest-confidence signature box the model produced anywhere".
 *
 * Usage (run in eval/):
 *   npm i onnxruntime-node sharp          # already present in eval/node_modules
 *   node signature_probe.js               # default model + signature.png & signature2.png
 *   node signature_probe.js signature2.png
 *   node signature_probe.js --conf 0.20 --iou 0.45 signature.png signature2.png
 *   node signature_probe.js --model ../extension/models/yolo-signature/model.onnx img.png
 */
const { showBoxes } = require("./show_boxes"); // draw boxes + open the image (see --no-show)

async function main() {
  // ---- arg parsing: --model/--conf/--iou flags + positional image paths ----
  const argv = process.argv.slice(2);
  let modelPath = "../extension/models/yolo-signature/model.onnx"; // the VENDORED weights
  let CONF = 0.35;   // matches REGISTRY minScore (vision-neural.js) — the shipping floor
  let IOU = 0.45;
  let SHOW = true; // pop up each image with its boxes (green >= conf, red below); --no-show disables
  const images = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") modelPath = argv[++i];
    else if (a === "--conf") CONF = Number(argv[++i]);
    else if (a === "--iou") IOU = Number(argv[++i]);
    else if (a === "--no-show") SHOW = false;
    else images.push(a);
  }
  if (images.length === 0) images.push("signature.png", "signature2.png"); // clean + Turing

  const fs = require("fs");
  let ort, sharp;
  try { ort = require("onnxruntime-node"); }
  catch { console.error("Missing dep. In eval/ run:  npm i onnxruntime-node"); process.exit(1); }
  try { sharp = require("sharp"); }
  catch { console.error("Missing dep. In eval/ run:  npm i sharp"); process.exit(1); }

  if (!fs.existsSync(modelPath)) {
    console.error(`Model not found: ${modelPath}`);
    console.error("Vendor it first:  node tools/vendor-vision.mjs   (from the repo root)");
    console.error("Or pass one:      node signature_probe.js --model <path> <image>");
    process.exit(1);
  }

  const SIZE = 640; // same letterbox square as the browser path (vision-neural.js)

  // ---- session (load once, reuse across images) ----
  const tLoad = Date.now();
  let session;
  try { session = await ort.InferenceSession.create(modelPath); }
  catch (e) { console.error("Could not load model:", e.message); process.exit(1); }
  console.log(`model : ${modelPath}`);
  console.log(`loaded in ${Date.now() - tLoad} ms   inputs=${JSON.stringify(session.inputNames)}  outputs=${JSON.stringify(session.outputNames)}`);
  console.log(`thresholds: conf>=${CONF}  nms_iou<${IOU}\n`);

  const SWEEP = [0.05, 0.10, 0.15, 0.20, 0.25, 0.35, 0.50];

  for (const imgPath of images) {
    if (!fs.existsSync(imgPath)) { console.log(`--- ${imgPath}: NOT FOUND, skipping ---\n`); continue; }
    await probeOne(ort, sharp, session, imgPath, SIZE, CONF, IOU, SWEEP, SHOW);
  }

  console.log("READING THE RESULT:");
  console.log("  • max raw score is the key recall number. High (>=~0.35) on a clean sig => model");
  console.log("    CAN detect it; the live 0 was framing/scale (fix the capture, not the model).");
  console.log("  • max raw score ~0 on BOTH clean sigs => script mismatch (ChiSig blind to Latin);");
  console.log("    swap the model. signature2.png is the actual Turing signature — weight it most.");
}

async function probeOne(ort, sharp, session, imgPath, SIZE, CONF, IOU, SWEEP, show) {
  // ---- load + letterbox to SIZExSIZE, keep aspect, pad 114 gray (YOLO convention).
  // For these small crops the letterbox UPSCALES to fill 640 -> a clean frame-filling test.
  const meta = await sharp(imgPath).metadata();
  const W = meta.width, H = meta.height;
  const scale = Math.min(SIZE / W, SIZE / H);
  const newW = Math.round(W * scale), newH = Math.round(H * scale);
  const padX = Math.floor((SIZE - newW) / 2), padY = Math.floor((SIZE - newH) / 2);

  const { data: rgb } = await sharp(imgPath)
    .resize(newW, newH)
    .extend({
      top: padY, bottom: SIZE - newH - padY,
      left: padX, right: SIZE - newW - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const chw = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++) {
    chw[i] = rgb[i * 3] / 255;
    chw[plane + i] = rgb[i * 3 + 1] / 255;
    chw[2 * plane + i] = rgb[i * 3 + 2] / 255;
  }

  const input = new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]);
  const feeds = {}; feeds[session.inputNames[0]] = input;
  await session.run(feeds);                 // warmup (graph init)
  const t1 = Date.now();
  const results = await session.run(feeds); // timed
  const ms = Date.now() - t1;
  const out = results[session.outputNames[0]];

  console.log(`=== ${imgPath}  (${W}x${H} -> letterbox ${SIZE}x${SIZE}, scale ${scale.toFixed(3)}, pad ${padX},${padY}) ===`);
  console.log(`inference: ${ms} ms   output dims: [${out.dims.join(", ")}]`);

  const dims = out.dims;
  if (dims.length !== 3) { console.log("  Unexpected output rank — paste the dims line and I'll adjust.\n"); return; }
  // [1,C,N] (C=5 small) or [1,N,C]; scoreIndex 4 = signature confidence (single class)
  let C, N, channelsFirst;
  if (dims[1] <= dims[2]) { C = dims[1]; N = dims[2]; channelsFirst = true; }
  else { C = dims[2]; N = dims[1]; channelsFirst = false; }
  const d = out.data;
  const at = (c, n) => (channelsFirst ? d[c * N + n] : d[n * C + c]);

  // ALL candidates, no threshold (so we see the model's true confidence)
  const cand = [];
  let maxScore = 0;
  for (let n = 0; n < N; n++) {
    const score = at(4, n);
    if (score > maxScore) maxScore = score;
    const cx = at(0, n), cy = at(1, n), w = at(2, n), h = at(3, n);
    cand.push({ x: (cx - w / 2 - padX) / scale, y: (cy - h / 2 - padY) / scale, w: w / scale, h: h / scale, score });
  }
  cand.sort((a, b) => b.score - a.score);

  // threshold sweep — how many boxes survive at each floor
  const counts = SWEEP.map((t) => `${t}:${cand.filter((c) => c.score >= t).length}`).join("  ");
  console.log(`MAX raw score: ${maxScore.toFixed(4)}   (${C} channels, ${N} anchors)`);
  console.log(`sweep (score>=t : #cand):  ${counts}`);

  // top raw candidates regardless of threshold
  console.log("top raw candidates (pre-threshold):");
  cand.slice(0, 8).forEach((b, i) =>
    console.log(`  #${i}  score=${b.score.toFixed(3)}  box=[${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.w)}, ${Math.round(b.h)}]`));

  // NMS at CONF — what would actually ship
  const iou = (a, b) => {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const uni = a.w * a.h + b.w * b.h - inter;
    return uni <= 0 ? 0 : inter / uni;
  };
  const keep = [];
  for (const b of cand) { if (b.score < CONF) continue; if (keep.every((k) => iou(k, b) < IOU)) keep.push(b); }
  const verdict = keep.length ? `DETECTED ${keep.length}` : (maxScore >= CONF ? "??" : "MISS (0 at shipping conf)");
  console.log(`=> at conf>=${CONF}: ${verdict}\n`);

  if (show) {
    // Display: dedupe candidates at a low floor (0.05) so near-misses show too, then draw
    // the top few on the image (green >= conf, red below) and open it in the OS viewer.
    const vis = [];
    for (const b of cand) { if (b.score < 0.05) break; if (vis.every((k) => iou(k, b) < IOU)) vis.push(b); }
    await showBoxes(sharp, imgPath, vis.slice(0, 6), { conf: CONF });
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  console.error("If it's a shape/name mismatch, paste the inputs/outputs/output-dims lines and I'll fix the decoder.");
});
