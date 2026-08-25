/*
 * run_all.js — one command to produce the SIH scorecard.
 *
 *   node eval/run_all.js
 *
 * Regenerates the dataset if needed, runs all evaluators, and prints a table
 * mapped to the five official metrics with their weights. Metric #1 (accuracy of
 * visual context) is scored on the SHIPPED on-device detector core against a
 * synthetic labeled screen-truth set (eval/vision_eval.js).
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function run(cmd) { execSync(cmd, { stdio: "inherit", cwd: path.join(__dirname, "..") }); }
function read(f) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8")); } catch { return null; } }

if (!fs.existsSync(path.join(__dirname, "dataset", "pii_samples.jsonl"))) run("node eval/make_dataset.js");
run("node eval/vision_eval.js");
run("node eval/pii_eval.js");
run("node eval/redaction_eval.js");
run("node eval/latency_bench.js");

const vis = read("out_vision.json"), pii = read("out_pii.json"), red = read("out_redaction.json"), lat = read("out_latency.json");

console.log("\n================ SIH 26171 SCORECARD ================");
console.log("metric                                     weight  measured");
if (vis) console.log(`1. Visual context accuracy                  25%    F1=${vis.micro.f.toFixed(2)} R=${vis.micro.r.toFixed(2)} meanIoU=${vis.micro.iou.toFixed(2)} (${vis.scenes} scenes, grounding ${vis.grounding_integrity.pass ? "OK" : "FAIL"})`);
if (pii) console.log(`2. PII detection precision/recall           20%    P=${pii.micro.p.toFixed(2)} R=${pii.micro.r.toFixed(2)} F1=${pii.micro.f.toFixed(2)}`);
if (red) console.log(`3. Redaction precision                      20%    coverage=${red.coverage_recall} zero_leak=${red.zero_leak_rate} boxP=${red.box_precision} IoU=${red.mean_iou}`);
if (lat) console.log(`4. Client resource utilization (proxy)      20%    ${lat.local.chars_per_ms} chars/ms local scan, p95 ${lat.local.p95_ms}ms`);
if (lat) console.log(`5. End-to-end latency                       15%    server /plan p50 ${lat.server ? lat.server.p50_ms + "ms" : "n/a (server down)"}`);
console.log("=====================================================\n");
console.log("Artifacts: eval/out_vision.json, out_pii.json, out_redaction.json, out_latency.json");
