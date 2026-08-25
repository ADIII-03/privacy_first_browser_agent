/*
 * yolos_probe.js — Qualitative gut-check of the CURRENT neural model (Xenova/yolos-tiny).
 *
 * Answers "how good is the yolos-tiny hook actually doing?" by running the EXACT model id
 * the extension registers (vision-neural.js REGISTRY) on a real image and printing what it
 * detects, at what confidence, where, and how long it takes.
 *
 * This is a QUALITATIVE probe, not a scored metric — it needs no labels. It exists to show,
 * with your own eyes, (a) that YOLOS-tiny only knows COCO classes (no face/signature/id), and
 * (b) roughly how fast/accurate the person->face path is, so we can decide one-model vs hybrid.
 *
 * Node has internet, so this downloads the weights from HuggingFace on first run. NOTE: the
 * browser extension can NEVER do that (CSP) — it still requires `node tools/vendor-vision.mjs`.
 * This script is only for evaluating on your dev machine.
 *
 * Usage:
 *   node yolos_probe.js path\to\screenshot.png
 *   node yolos_probe.js path\to\photo.jpg 0.3        (optional 2nd arg = score threshold)
 */
async function main() {
  const file = process.argv[2];
  const threshold = process.argv[3] ? Number(process.argv[3]) : 0.3;
  if (!file) {
    console.error("Usage: node yolos_probe.js <image.png|jpg> [threshold]");
    process.exit(1);
  }

  let T;
  try {
    T = await import("@huggingface/transformers");
  } catch (e) {
    console.error("Could not load @huggingface/transformers.");
    console.error("Run this in eval/ first:  npm i");
    process.exit(1);
  }
  const { pipeline, RawImage, env } = T;
  env.allowRemoteModels = true; // Node may fetch weights from HF; the browser never can.

  const MODEL = "Xenova/yolos-tiny"; // the exact id in vision-neural.js REGISTRY
  console.log(`loading ${MODEL} (q8) ...`);
  const tLoad = Date.now();
  let detector;
  try {
    detector = await pipeline("object-detection", MODEL, { dtype: "q8" });
  } catch (e) {
    console.error("pipeline() failed:", e.message);
    console.error("If it complains about dtype, tell me and I'll switch it to fp32.");
    process.exit(1);
  }
  console.log(`model ready in ${Date.now() - tLoad} ms`);

  let img;
  try {
    img = await RawImage.read(file); // uses sharp under the hood in Node
  } catch (e) {
    console.error("Could not read image:", e.message);
    console.error("If it mentions sharp, run:  npm i sharp");
    process.exit(1);
  }
  console.log(`image: ${img.width} x ${img.height}`);

  const t1 = Date.now();
  const out = await detector(img, { threshold, percentage: false });
  const ms = Date.now() - t1;

  console.log(`\ninference: ${ms} ms  —  ${out.length} detections at threshold ${threshold}`);

  const byLabel = {};
  for (const d of out) byLabel[d.label] = (byLabel[d.label] || 0) + 1;
  console.log("classes found:", JSON.stringify(byLabel, null, 0));

  console.log("\ntop detections (highest score first):");
  out.sort((a, b) => b.score - a.score).slice(0, 15).forEach((d) => {
    const b = d.box;
    const box = [Math.round(b.xmin), Math.round(b.ymin), Math.round(b.xmax - b.xmin), Math.round(b.ymax - b.ymin)];
    console.log(`  ${String(d.label).padEnd(12)} score=${d.score.toFixed(2)}  box=[${box.join(", ")}]`);
  });

  const persons = out.filter((d) => (d.label || "").toLowerCase() === "person").length;
  console.log(`\nWhat the extension would actually USE from this: ${persons} "person" box(es) -> coarse FACE region(s).`);
  console.log('YOLOS-tiny is COCO-trained: NO "face", "signature", or "id_document" class exists.');
  console.log("So on a page whose only sensitive content is a signature or an ID card, this model finds NOTHING.");
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
});
