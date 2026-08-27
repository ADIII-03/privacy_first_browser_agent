// Throwaway probe: replicate createOnnxYolo() with the WASM EP to see if the
// vendored ORT + model.onnx actually load. WebGPU isn't available in Node, so this
// only proves the weights/runtime are sound; a pass means neural failure is
// browser-specific (WebGPU/CSP/init), a fail names the real load error.
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const ORT_ESM = path.join(ROOT, "extension/lib/vendor/ort/ort-webgpu-api.mjs");
const MODELS = [
  path.join(ROOT, "extension/models/yolov8n-face/model.onnx"),
  path.join(ROOT, "extension/models/yolo-signature/model.onnx"),
];

console.log("importing ORT ESM:", ORT_ESM);
let ort;
try {
  ort = await import(pathToFileURL(ORT_ESM).href);
} catch (e) {
  console.log("FATAL: cannot import ort-webgpu-api.mjs:", String(e && e.stack || e));
  process.exit(2);
}
console.log("ORT exports:", Object.keys(ort).slice(0, 30).join(", "));
console.log("InferenceSession?", !!ort.InferenceSession, " Tensor?", !!ort.Tensor, " env?", !!ort.env);

try {
  if (ort.env && ort.env.wasm) {
    ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, "extension/lib/vendor/ort/") ).href;
    ort.env.wasm.numThreads = 1; // Node: avoid worker/threads complications
  }
} catch (e) { console.log("env.wasm set warn:", String(e)); }

for (const mf of MODELS) {
  console.log("\n=== " + path.basename(path.dirname(mf)) + " ===");
  let buf;
  try { buf = await readFile(mf); } catch (e) { console.log("read fail:", String(e)); continue; }
  console.log("bytes:", buf.byteLength);
  let session = null, ep = null, lastErr = null;
  for (const cand of ["wasm"]) {
    try {
      session = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: [cand] });
      ep = cand; break;
    } catch (e) { lastErr = e; console.log("EP", cand, "failed:", String(e && e.message || e)); }
  }
  if (!session) { console.log("LOAD FAILED:", String(lastErr && lastErr.stack || lastErr)); continue; }
  console.log("LOADED on", ep, "| inputs:", session.inputNames, "| outputs:", session.outputNames);
  // Run once on a gray frame to prove inference works end to end.
  try {
    const size = 640, plane = size * size, chw = new Float32Array(3 * plane).fill(0.45);
    const feeds = {}; feeds[session.inputNames[0]] = new ort.Tensor("float32", chw, [1, 3, size, size]);
    const res = await session.run(feeds);
    const out = res[session.outputNames[0]];
    console.log("RAN OK | output dims:", out.dims);
  } catch (e) { console.log("RUN FAILED:", String(e && e.message || e)); }
}
console.log("\nprobe done");
