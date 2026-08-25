/*
 * redaction_eval.js — Metric #3 (redaction precision) + coverage of Metric #2 geometry.
 *
 * Loads the REAL fusion + policy modules (via a `self` shim) and runs them over
 * synthetic scenes with known ground-truth sensitive boxes. Reports:
 *   coverage_recall   — fraction of sensitive regions that got redacted (privacy)
 *   box_precision     — fraction of redaction boxes that hit a real sensitive region
 *   mean_iou          — tightness of matched redaction boxes
 *   over_redaction    — area redacted that was NOT sensitive / total redacted area
 * The privacy-critical number is coverage_recall (a miss == a leak); over_redaction
 * is the utility cost we trade off against it.
 */
const fs = require("fs");
const path = require("path");

// Shim: the browser modules attach to `self.PBA`. Make `self` == globalThis in Node.
globalThis.self = globalThis;
const L = (f) => require(path.join(__dirname, "..", "extension", "lib", f));
L("protocol.js"); L("privacy/pii-regex.js"); L("privacy/fusion.js"); L("privacy/policy.js");
const PBA = globalThis.PBA;

const area = (b) => Math.max(0, b[2]) * Math.max(0, b[3]);
function inter(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}
const iou = (a, b) => { const i = inter(a, b); const u = area(a) + area(b) - i; return u ? i / u : 0; };

// A scene is a set of on-screen text runs; sensitive runs carry ONLY the PII value
// so the run box is the ground-truth box. Decoys must NOT be redacted. DOM field
// PII (e.g. password) contributes its own ground-truth box too.
function scene(runs, fieldPII) {
  const textNodes = runs.map((r) => ({ text: r.text, bbox: r.bbox }));
  const gt = runs.filter((r) => r.sensitive).map((r) => r.bbox)
    .concat((fieldPII || []).map((f) => f.bbox));
  const map = PBA.fusion.fuse({ textNodes, fieldPII: fieldPII || [], visionDetections: [] });
  const { plan } = PBA.policy.decide(map, { visionReady: true, imageCount: 0 });
  return { gt, pred: plan.map((p) => p.bbox) };
}

const SCENES = [
  scene([
    { text: "user.test@example.com", bbox: [100, 140, 200, 20], sensitive: true },
    { text: "Submit Application", bbox: [100, 200, 140, 30], sensitive: false },
    { text: "9876543210", bbox: [100, 100, 120, 20], sensitive: true },
  ]),
  scene(
    [{ text: "person@okhdfc", bbox: [50, 130, 150, 18], sensitive: true },
     { text: "Welcome back", bbox: [50, 90, 130, 24], sensitive: false }],
    [{ pii_type: "password", bbox: [50, 40, 220, 30], confidence: 0.99, elementId: 3 }]
  ),
  scene([
    { text: "4111 1111 1111 1111", bbox: [10, 10, 220, 22], sensitive: true }, // valid Luhn
    { text: "Pay Later", bbox: [10, 50, 100, 26], sensitive: false },
  ]),
];

function main() {
  let tp = 0, fp = 0, covered = 0, gtTotal = 0, iouSum = 0, iouN = 0;
  let predArea = 0, predHitArea = 0;
  let zeroLeakScenes = 0;
  for (const s of SCENES) {
    gtTotal += s.gt.length;
    const usedGt = new Set();
    let sceneCovered = 0;
    for (const p of s.pred) {
      predArea += area(p);
      let best = -1, bestIoU = 0;
      s.gt.forEach((g, i) => { const v = iou(p, g); if (v > bestIoU) { bestIoU = v; best = i; } });
      predHitArea += s.gt.reduce((acc, g) => acc + inter(p, g), 0);
      if (bestIoU > 0.1) { tp++; iouSum += bestIoU; iouN++; if (!usedGt.has(best)) { usedGt.add(best); covered++; sceneCovered++; } }
      else fp++;
    }
    if (sceneCovered === s.gt.length && s.gt.length > 0) zeroLeakScenes++;
  }
  const result = {
    coverage_recall: gtTotal ? +(covered / gtTotal).toFixed(3) : 1,
    box_precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : 1,
    mean_iou: iouN ? +(iouSum / iouN).toFixed(3) : 0,
    over_redaction: predArea ? +(1 - predHitArea / predArea).toFixed(3) : 0,
    zero_leak_rate: SCENES.length ? +(zeroLeakScenes / SCENES.length).toFixed(3) : 1,
    scenes: SCENES.length,
  };
  console.log("\n=== Metric #3 — Redaction precision ===");
  console.log(`coverage_recall : ${result.coverage_recall}  (privacy: 1.0 = no sensitive region missed)`);
  console.log(`zero_leak_rate  : ${result.zero_leak_rate}  (all-or-nothing per scene; judges' mental model)`);
  console.log(`box_precision   : ${result.box_precision}`);
  console.log(`mean_iou        : ${result.mean_iou}`);
  console.log(`over_redaction  : ${result.over_redaction}  (lower = less collateral masking)`);
  fs.writeFileSync(path.join(__dirname, "out_redaction.json"), JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main();
module.exports = { main };
