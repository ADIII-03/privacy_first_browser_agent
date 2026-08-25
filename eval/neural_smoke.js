/*
 * neural_smoke.js — Proves the VENDORED neural detector actually EXECUTES.
 *
 * Metric #1 (vision_eval.js) scores the classical CV core — the shipped, default,
 * dependency-free detector. The OPTIONAL neural hook (extension/lib/vision/
 * vision-neural.js → transformers.js → ONNX Runtime) only AUGMENTS it. This
 * harness loads the SAME vendored weights (extension/models/) with a Node build
 * of transformers.js, forces fully-offline inference, runs the model on a
 * synthetic frame, verifies it loads + runs + emits well-formed detections, and
 * reports load / inference latency.
 *
 * It deliberately does NOT report a "neural PII accuracy" number: yolos-tiny is a
 * COCO object detector (person / car / …), a coarse placeholder that maps
 * person -> FACE via union-biased fusion (recall-safe: it can only ADD coverage,
 * never remove a classical detection). Real face/ID accuracy needs a PII-specific
 * model dropped into the REGISTRY in vision-neural.js — the plumbing already waits.
 *
 *   node tools/vendor-vision.mjs                       # 1. vendor weights (once)
 *   npm install --prefix eval @huggingface/transformers  # 2. Node runtime (once)
 *   node eval/neural_smoke.js                          # 3. run this
 */
const path = require("path");

const MODELS_DIR = path.join(__dirname, "..", "extension", "models");
const MODEL_ID = "Xenova/yolos-tiny";
const DTYPE = "q8"; // mirrors REGISTRY in vision-neural.js → loads onnx/model_quantized.onnx
const LABEL_TO_PII = { person: "face" }; // mirrors REGISTRY.labels in vision-neural.js

// Synthetic RGBA frame: a dark head+torso figure on a light ground. yolos may or
// may not fire on a non-photographic shape — the SMOKE TEST proves the engine
// runs and returns structured output either way; a real hit is a bonus, not the
// point (accuracy on the wrong class family would be meaningless anyway).
function syntheticFrame(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 235; data[i * 4 + 1] = 235; data[i * 4 + 2] = 235; data[i * 4 + 3] = 255;
  }
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  };
  const cx = (w / 2) | 0;
  const halfBody = (w * 0.12) | 0;
  for (let y = (h * 0.35) | 0; y < (h * 0.9) | 0; y++)
    for (let x = cx - halfBody; x < cx + halfBody; x++) put(x, y, 40, 60, 90);   // torso
  const hr = (w * 0.09) | 0, hy = (h * 0.28) | 0;
  for (let y = -hr; y <= hr; y++) for (let x = -hr; x <= hr; x++)
    if (x * x + y * y <= hr * hr) put(cx + x, hy + y, 60, 45, 40);               // head
  return { data, width: w, height: h };
}

async function main() {
  let mod;
  try {
    mod = await import("@huggingface/transformers");
  } catch (_) {
    console.error("[skip] Node transformers.js not installed. Run:");
    console.error("    npm install --prefix eval @huggingface/transformers@4.2.0");
    process.exit(2);
  }
  const { pipeline, env, RawImage } = mod;

  // Force fully-offline: use ONLY the vendored weights, never touch the network.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODELS_DIR;

  console.log(`neural smoke test — ${MODEL_ID} (dtype=${DTYPE}), backend: onnxruntime-node`);
  console.log(`weights: extension/models/${MODEL_ID}  (offline: allowRemoteModels=false)\n`);

  const t0 = Date.now();
  let detector;
  try {
    detector = await pipeline("object-detection", MODEL_ID, { dtype: DTYPE });
  } catch (e) {
    console.error("✗ model failed to load:", e.message);
    console.error("  did you run:  node tools/vendor-vision.mjs  ?");
    process.exit(1);
  }
  console.log(`✓ model loaded in ${Date.now() - t0} ms (ONNX weights + preprocessor)`);

  const img = syntheticFrame(320, 320);
  const raw = new RawImage(img.data, img.width, img.height, 4);

  await detector(raw, { threshold: 0.5, percentage: false }).catch(() => {}); // warm-up
  const runs = [];
  let out = [];
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    out = await detector(raw, { threshold: 0.5, percentage: false });
    runs.push(Date.now() - s);
  }
  runs.sort((a, b) => a - b);

  const wellFormed = Array.isArray(out) && out.every(
    (d) => d && typeof d.label === "string" && typeof d.score === "number" &&
      d.box && ["xmin", "ymin", "xmax", "ymax"].every((k) => typeof d.box[k] === "number")
  );

  console.log(`✓ inference ran: p50 ${runs[2]} ms/frame over ${runs.length} runs (${img.width}×${img.height} RGBA)`);
  console.log(`✓ output well-formed (label+score+box): ${wellFormed}`);
  console.log(`  detections returned: ${out.length}`);
  for (const d of out.slice(0, 5)) {
    const pii = LABEL_TO_PII[(d.label || "").toLowerCase()];
    console.log(`    - ${d.label} ${d.score.toFixed(3)}${pii ? `  → unions as PII '${pii}'` : "  (ignored: no PII mapping)"}`);
  }
  if (!out.length) console.log("    (none on this synthetic frame — expected; the engine executed correctly)");

  console.log("\nVERDICT: the vendored neural stack EXECUTES offline on the shipped weights.");
  console.log("Metric #1 headline stays the classical core; neural is union-fused, recall-safe augmentation.");
  process.exit(wellFormed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
