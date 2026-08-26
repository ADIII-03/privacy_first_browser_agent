/*
 * face_probe.js — Path A: measure a REAL face model (YOLOv8-face) the same way
 * yolos_probe.js measured Xenova/yolos-tiny, so the numbers are directly comparable.
 *
 * Why this exists: YOLOS-tiny was ~1.0-1.2 s/frame, hallucinated COCO junk (donuts,
 * plants) on UI screenshots, and knew no "face" class. Before committing to a hybrid
 * we want hard numbers for a purpose-built face detector: how fast, how tight are the
 * boxes, does it stay quiet on non-faces.
 *
 * This runs in Node via onnxruntime-node (NOT transformers.js — YOLOv8-face is not a
 * supported pipeline). That is deliberate: the pre/post-processing below
 * (letterbox -> NCHW float -> YOLOv8 decode -> NMS) is the SAME logic we will reuse
 * in-browser with onnxruntime-web for Path C. So this probe is not throwaway — it is
 * the reference implementation for the extension integration.
 *
 * Node/WASM CPU timing here is the apples-to-apples comparison against the YOLOS Node
 * number. The real WebGPU-in-browser number we confirm later during integration.
 *
 * Usage (run in eval/):
 *   node face_probe.js models\yolov8n-face.onnx person.png
 *   node face_probe.js models\yolov8n-face.onnx signature.png 0.35 0.45
 *                                                  ^conf      ^nms-iou (both optional)
 */
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--no-show");
  const SHOW = !process.argv.includes("--no-show"); // pop up the image with boxes (default on)
  const modelPath = args[0];
  const imgPath = args[1];
  const CONF = args[2] ? Number(args[2]) : 0.35;
  const IOU = args[3] ? Number(args[3]) : 0.45;
  if (!modelPath || !imgPath) {
    console.error("Usage: node face_probe.js <model.onnx> <image.png|jpg> [conf=0.35] [nms_iou=0.45] [--no-show]");
    process.exit(1);
  }

  let ort, sharp;
  try { ort = require("onnxruntime-node"); }
  catch { console.error("Missing dep. In eval/ run:  npm i onnxruntime-node"); process.exit(1); }
  try { sharp = require("sharp"); }
  catch { console.error("Missing dep. In eval/ run:  npm i sharp"); process.exit(1); }
  const { showBoxes } = require("./show_boxes");

  const SIZE = 640; // standard YOLOv8 input. If your model rejects this, paste me the error.

  // ---- load + letterbox to SIZExSIZE, keep aspect, pad with 114 gray (YOLOv8 convention)
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

  // HWC RGB uint8 -> NCHW float32 [0,1]
  const chw = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++) {
    chw[i] = rgb[i * 3] / 255;
    chw[plane + i] = rgb[i * 3 + 1] / 255;
    chw[2 * plane + i] = rgb[i * 3 + 2] / 255;
  }
  console.log(`image: ${W}x${H}  ->  letterboxed ${SIZE}x${SIZE} (scale ${scale.toFixed(3)}, pad ${padX},${padY})`);

  // ---- session
  const tLoad = Date.now();
  let session;
  try { session = await ort.InferenceSession.create(modelPath); }
  catch (e) { console.error("Could not load model:", e.message); process.exit(1); }
  console.log(`model loaded in ${Date.now() - tLoad} ms`);
  console.log("inputs :", session.inputNames);
  console.log("outputs:", session.outputNames);

  const input = new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]);
  const feeds = {}; feeds[session.inputNames[0]] = input;

  // one warmup (first run pays graph-init cost), then a timed run — same as a real per-frame call
  await session.run(feeds);
  const t1 = Date.now();
  const results = await session.run(feeds);
  const ms = Date.now() - t1;

  const out = results[session.outputNames[0]];
  console.log(`\ninference: ${ms} ms   output dims: [${out.dims.join(", ")}]`);

  // ---- decode YOLOv8 head: either [1, C, N] (channels-first) or [1, N, C]
  const dims = out.dims;
  if (dims.length !== 3) {
    console.error("Unexpected output rank. Paste the 'output dims' line above and I'll adjust the decoder.");
    process.exit(1);
  }
  let C, N, channelsFirst;
  if (dims[1] <= dims[2]) { C = dims[1]; N = dims[2]; channelsFirst = true; }  // [1,C,N], C small (5 for 1-class)
  else { C = dims[2]; N = dims[1]; channelsFirst = false; }                    // [1,N,C]
  const d = out.data;
  const at = (c, n) => (channelsFirst ? d[c * N + n] : d[n * C + c]); // batch=1

  // rows 0..3 = cx,cy,w,h in letterboxed px; row 4 = face score (single class; landmarks, if any, follow)
  const cand = [];
  for (let n = 0; n < N; n++) {
    const score = at(4, n);
    if (score < CONF) continue;
    const cx = at(0, n), cy = at(1, n), w = at(2, n), h = at(3, n);
    const x = (cx - w / 2 - padX) / scale; // undo letterbox -> original image px
    const y = (cy - h / 2 - padY) / scale;
    cand.push({ x, y, w: w / scale, h: h / scale, score });
  }

  // ---- NMS
  cand.sort((a, b) => b.score - a.score);
  const iou = (a, b) => {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const uni = a.w * a.h + b.w * b.h - inter;
    return uni <= 0 ? 0 : inter / uni;
  };
  const keep = [];
  for (const b of cand) if (keep.every((k) => iou(k, b) < IOU)) keep.push(b);

  console.log(`\n${keep.length} face(s) after NMS  (conf>=${CONF}, nms_iou<${IOU}; ${cand.length} raw over threshold):`);
  keep.slice(0, 20).forEach((b, i) =>
    console.log(`  #${i}  score=${b.score.toFixed(2)}  box=[${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.w)}, ${Math.round(b.h)}]`));

  if (SHOW) await showBoxes(sharp, imgPath, keep, { conf: CONF });

  console.log("\nCompare vs YOLOS-tiny:");
  console.log("  (1) inference ms  — expect FAR below ~1000ms (CNN vs transformer).");
  console.log("  (2) tight FACE boxes around heads, not whole-person boxes.");
  console.log("  (3) no donut/plant/table hallucinations on a UI screenshot.");
  console.log("  (4) on signature.png expect 0 — it's a face model; signatures+IDs still need classical+OCR.");
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  console.error("If it's a shape/name mismatch, paste the inputs/outputs/output-dims lines and I'll fix the decoder.");
});
