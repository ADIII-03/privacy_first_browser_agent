/*
 * pii_eval.js — Metric #2 (PII precision/recall/F1).
 *
 * Runs the SHIPPED detector (extension/lib/privacy/pii-regex.js) over the labeled
 * benchmark and reports per-category + micro-averaged precision/recall/F1.
 * A prediction counts as a true positive iff it overlaps a ground-truth span of
 * the same category. This is the exact code path that runs in the browser, so
 * the score is honest (no separate "eval-only" reimplementation to drift).
 */
const fs = require("fs");
const path = require("path");
const pii = require(path.join(__dirname, "..", "extension", "lib", "privacy", "pii-regex.js"));

function loadDataset() {
  const p = path.join(__dirname, "dataset", "pii_samples.jsonl");
  return fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const overlap = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

function evaluate(rows) {
  const stat = {}; // type -> {tp,fp,fn}
  const bump = (t, k) => { (stat[t] = stat[t] || { tp: 0, fp: 0, fn: 0 })[k]++; };

  for (const row of rows) {
    const preds = pii.scan(row.text).map((p) => ({ type: p.type, s: p.index, e: p.index + p.length, used: false }));
    const gold = row.spans.map((g) => ({ ...g, matched: false }));

    for (const p of preds) {
      const g = gold.find((g) => !g.matched && g.type === p.type && overlap(p.s, p.e, g.start, g.end));
      if (g) { g.matched = true; p.used = true; bump(p.type, "tp"); }
      else bump(p.type, "fp");
    }
    for (const g of gold) if (!g.matched) bump(g.type, "fn");
  }
  return stat;
}

function prf(s) {
  const p = s.tp + s.fp ? s.tp / (s.tp + s.fp) : 1;
  const r = s.tp + s.fn ? s.tp / (s.tp + s.fn) : 1;
  const f = p + r ? (2 * p * r) / (p + r) : 0;
  return { p, r, f };
}

function main() {
  const rows = loadDataset();
  const stat = evaluate(rows);
  const micro = { tp: 0, fp: 0, fn: 0 };
  console.log("\n=== Metric #2 — PII detection (precision / recall / F1) ===");
  console.log("category        prec   rec    F1     tp  fp  fn");
  for (const t of Object.keys(stat).sort()) {
    const s = stat[t]; micro.tp += s.tp; micro.fp += s.fp; micro.fn += s.fn;
    const { p, r, f } = prf(s);
    console.log(`${t.padEnd(14)} ${p.toFixed(2)}  ${r.toFixed(2)}  ${f.toFixed(2)}   ${s.tp}   ${s.fp}   ${s.fn}`);
  }
  const m = prf(micro);
  console.log("-".repeat(48));
  console.log(`${"MICRO".padEnd(14)} ${m.p.toFixed(2)}  ${m.r.toFixed(2)}  ${m.f.toFixed(2)}   ${micro.tp}   ${micro.fp}   ${micro.fn}`);
  const result = { micro: m, per_type: Object.fromEntries(Object.entries(stat).map(([k, v]) => [k, prf(v)])) };
  fs.writeFileSync(path.join(__dirname, "out_pii.json"), JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main();
module.exports = { evaluate, prf, loadDataset };
