/*
 * vision_eval.js — Metric #1 (Accuracy of visual context).
 *
 * Scores the SHIPPED on-device detector core (extension/lib/vision/vision-detector.js,
 * the exact code that runs in the browser) against the synthetic, labeled screen
 * truth in fixtures/screen_truth.js. No browser, no model download — the detector
 * core is a pure function over an RGBA buffer, so what we ship is what we score.
 *
 * Reports, for the visual-PII classes the detector owns (FACE, SIGNATURE):
 *   precision / recall / F1  — IoU-matched at THR (a miss is a privacy leak)
 *   mean_iou                 — tightness of matched boxes
 *   grounding_integrity      — Set-of-Marks id↔box contract holds (secondary)
 * The headline Metric #1 number is the micro-F1 across classes.
 */
const fs = require("fs");
const path = require("path");
const V = require(path.join(__dirname, "..", "extension", "lib", "vision", "vision-detector.js"));
const { scenes, groundingSample } = require(path.join(__dirname, "fixtures", "screen_truth.js"));

const THR = 0.5; // IoU threshold for a true-positive detection

const area = (b) => Math.max(0, b[2]) * Math.max(0, b[3]);
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = area(a) + area(b) - inter;
  return uni <= 0 ? 0 : inter / uni;
}

// Greedy IoU matching within one class: each prediction (highest confidence first)
// claims the best unused ground-truth box above THR.
function matchClass(preds, gts) {
  const used = new Set();
  let tp = 0, fp = 0, iouSum = 0;
  for (const p of preds.slice().sort((a, b) => b.confidence - a.confidence)) {
    let best = -1, bestIoU = THR;
    gts.forEach((g, i) => { if (used.has(i)) return; const v = iou(p.bbox, g.bbox); if (v >= bestIoU) { bestIoU = v; best = i; } });
    if (best >= 0) { tp++; used.add(best); iouSum += bestIoU; } else { fp++; }
  }
  return { tp, fp, fn: gts.length - used.size, iouSum, matched: used.size };
}

function grounding() {
  const { viewport, elements, marks } = groundingSample();
  const ids = new Set(elements.map((e) => e.id));
  const idsUnique = ids.size === elements.length;
  const marksSubset = marks.every((m) => ids.has(m.id));
  const oneToOne = marks.length === elements.length;
  const inViewport = elements.every((e) => {
    const [x, y, w, h] = e.bbox;
    return x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= viewport.w && y + h <= viewport.h;
  });
  const pass = idsUnique && marksSubset && oneToOne && inViewport;
  return { pass, idsUnique, marksSubset, oneToOne, inViewport };
}

function main() {
  const CLASSES = ["face", "signature"];
  const agg = { face: { tp: 0, fp: 0, fn: 0, iouSum: 0, matched: 0 }, signature: { tp: 0, fp: 0, fn: 0, iouSum: 0, matched: 0 } };
  const perScene = [];

  for (const sc of scenes()) {
    const preds = V.detectSensitiveRegions(sc.image);
    const row = { name: sc.name, detected: preds.length, truth: sc.truth.length, byClass: {} };
    for (const c of CLASSES) {
      const p = preds.filter((d) => d.pii_type === c);
      const g = sc.truth.filter((t) => t.pii_type === c);
      const m = matchClass(p, g);
      agg[c].tp += m.tp; agg[c].fp += m.fp; agg[c].fn += m.fn; agg[c].iouSum += m.iouSum; agg[c].matched += m.matched;
      row.byClass[c] = { tp: m.tp, fp: m.fp, fn: m.fn };
    }
    perScene.push(row);
  }

  const prf = (a) => {
    const p = a.tp + a.fp ? a.tp / (a.tp + a.fp) : 1;
    const r = a.tp + a.fn ? a.tp / (a.tp + a.fn) : 1;
    const f = p + r ? (2 * p * r) / (p + r) : 0;
    return { p: +p.toFixed(3), r: +r.toFixed(3), f: +f.toFixed(3), iou: a.matched ? +(a.iouSum / a.matched).toFixed(3) : 0 };
  };
  const micro = prf({
    tp: agg.face.tp + agg.signature.tp, fp: agg.face.fp + agg.signature.fp,
    fn: agg.face.fn + agg.signature.fn, iouSum: agg.face.iouSum + agg.signature.iouSum,
    matched: agg.face.matched + agg.signature.matched,
  });
  const g = grounding();

  const result = {
    thr_iou: THR,
    face: prf(agg.face),
    signature: prf(agg.signature),
    micro,
    grounding_integrity: g,
    scenes: perScene.length,
    per_scene: perScene,
    backend: "cpu (authoritative; WebGPU path self-verifies against this in-browser)",
  };

  console.log("\n=== Metric #1 — Visual context accuracy (on-device detector) ===");
  console.log(`faces      : P=${result.face.p} R=${result.face.r} F1=${result.face.f} IoU=${result.face.iou}`);
  console.log(`signatures : P=${result.signature.p} R=${result.signature.r} F1=${result.signature.f} IoU=${result.signature.iou}`);
  console.log(`micro      : P=${micro.p} R=${micro.r} F1=${micro.f} meanIoU=${micro.iou}  over ${perScene.length} scenes`);
  console.log(`grounding  : ${g.pass ? "OK (Set-of-Marks id↔box contract holds)" : "FAIL " + JSON.stringify(g)}`);
  fs.writeFileSync(path.join(__dirname, "out_vision.json"), JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main();
module.exports = { main, iou };
