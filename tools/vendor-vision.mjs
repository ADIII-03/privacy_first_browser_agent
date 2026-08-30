#!/usr/bin/env node
/*
 * vendor-vision.mjs — One-command vendoring of the on-device neural vision stack.
 *
 * The extension CSP (`script-src 'self' 'wasm-unsafe-eval'`) forbids loading
 * libraries or weights from a CDN at runtime — that is the privacy point. So the
 * ONNX runtime and the model weights must be placed INSIDE the extension at build
 * time. The active detector (vision-neural.js → yolov8n-face) uses onnxruntime-web
 * DIRECTLY (raw YOLO head), so we vendor onnxruntime-web's ESM API + WASM backends,
 * plus the locally-exported face model.
 *
 *   node tools/vendor-vision.mjs             # place whatever is missing
 *   node tools/vendor-vision.mjs --check     # verify presence + integrity only
 *
 * Everything lands in paths that are already .gitignore'd (binaries stay out of VCS)
 * and loaded same-origin from the offscreen document:
 *   extension/lib/vendor/ort/ort-webgpu-api.mjs   (onnxruntime-web ESM API entry)
 *   extension/lib/vendor/ort/ort-*.wasm *.mjs     (WASM/JSEP backends)
 *   extension/models/yolov8n-face/model.onnx      (copied from eval/models/, see below)
 *
 * The face model is produced on YOUR machine, not downloaded:
 *   (in ml_env)  yolo export model=yolov8n-face.pt format=onnx imgsz=640 opset=12
 * which writes eval/models/yolov8n-face.onnx — this script copies it in.
 *
 * After vendoring, reload the extension at chrome://extensions; vision-neural.js
 * activates automatically (union-biased fusion, fail-closed).
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// On Windows, `new URL(import.meta.url).pathname` yields "/C:/Users/..." — the
// leading slash makes path.resolve prepend the current drive. fileURLToPath()
// converts a file:// URL to a real OS path on every platform.
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const EXT = path.join(ROOT, "extension");
const VENDOR_ORT = path.join(EXT, "lib", "vendor", "ort");
const MODELS_DIR = path.join(EXT, "models");

// ---- pinned artifact version -------------------------------------------------
// Bump deliberately: the ESM API and the .wasm backends must stay mutually
// compatible, so both come from THIS single onnxruntime-web tarball.
const ORT_WEB_VERSION = "1.26.0-dev.20260416-b7804b056c";
const ORT_NPM_TARBALL = `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${ORT_WEB_VERSION}.tgz`;

// Preference order for the ESM API entry we import (copied to a fixed name).
// Self-contained ".bundle." variants first; all are backed by the vendored .wasm.
const ORT_API_CANDIDATES = [
  "ort.webgpu.bundle.min.mjs",
  "ort.webgpu.min.mjs",
  "ort.bundle.min.mjs",
  "ort.all.bundle.min.mjs",
  "ort.min.mjs",
];
const ORT_API_DEST = path.join(VENDOR_ORT, "ort-webgpu-api.mjs");

// Model registry — mirrors REGISTRY in extension/lib/vision/vision-neural.js.
// localSource → copied in (not fetched); HF `files` → downloaded at build time
// (fine — the CSP only forbids fetching at RUNTIME; vendored weights are same-origin).
// `id` is the local dir under extension/models/; `hfRepo` (optional) is the source
// repo, kept separate so a clean local id can pull from an org/name HF path.
const MODELS = [
  {
    id: "yolov8n-face",
    localSource: path.join(ROOT, "eval", "models", "yolov8n-face.onnx"),
    destRel: "model.onnx", // → extension/models/yolov8n-face/model.onnx
    sizeWarnMB: 20,
  },
  {
    // Handwritten-signature detector (tech4humans YOLOv8s). Copied from the local
    // export in eval/models/ (same pattern as the face model) if present; falls back
    // to downloading from Hugging Face if missing. Single-class ("signature")
    // Ultralytics detect head → SAME [1,5,N] layout decoded by SAME decodeYolo.
    // LICENSE: AGPL-3.0 (Ultralytics-derived; accepted for now, revisit before release).
    // Source repo: tech4humans/yolov8s-signature-detector on Hugging Face.
    id: "yolo-signature",
    localSource: path.join(ROOT, "eval", "models", "sig-tech4humans.onnx"),
    hfRepo: "tech4humans/yolov8s-signature-detector",
    files: [["onnx/model.onnx", "model.onnx"]],
    destRel: "model.onnx", // → extension/models/yolo-signature/model.onnx
    sizeWarnMB: 50, // YOLOv8s fp32 ONNX ≈ 44.6 MB (larger than the nano models)
  },
];

const CHECK_ONLY = process.argv.includes("--check");

function hr(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

async function downloadTo(url, dest) {
  // A UA header avoids a class of HF/CDN 403s that reject the default runtime UA.
  // (Gated repos still 401 regardless — those need an auth token, not a UA.)
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "pba-vendor/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

// Integrity probe: catches truncated/corrupt ONNX cheaply (no deps).
function looksLikeOnnx(head) {
  // ONNX is protobuf; model files start with field-1 varint (ir_version) = 0x08.
  return head.length >= 4 && head[0] === 0x08;
}

async function fetchTarballExtract(tarballUrl, label, distSub) {
  console.log(`• downloading ${label} ...`);
  const res = await fetch(tarballUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${tarballUrl}`);
  // Extract INSIDE the repo (.vendor-tmp, gitignored): immune to external /tmp
  // cleaners racing mid-extract; removed again in finally.
  const work = path.join(ROOT, ".vendor-tmp");
  const tmpTgz = path.join(work, `${label}.tgz`);
  try {
    await rm(work, { recursive: true, force: true }); // async variant — MUST await
    mkdirSync(work, { recursive: true });
    let buf;
    for (let attempt = 1; ; attempt++) {
      try {
        if (!buf) {
          buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 1024) throw new Error(`tarball suspiciously small (${buf.length} B)`);
        }
        await writeFile(tmpTgz, buf);
        // Relative filename + cwd avoids GNU tar misreading "C:\..." as host:path.
        execFileSync("tar", ["-xzf", `${label}.tgz`], { cwd: work });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        console.log(`  retry ${attempt}/2 after: ${e.message.split("\n")[0]}`);
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    return path.join(work, "package", distSub || "dist");
  } catch (e) {
    await rm(work, { recursive: true, force: true });
    throw e;
  }
}

async function main() {
  console.log(`PBA neural-vision vendor ${CHECK_ONLY ? "(check)" : "(install)"}\n`);
  let failures = 0;
  try {
    failures = await run();
  } finally {
    await rm(path.join(ROOT, ".vendor-tmp"), { recursive: true, force: true });
  }
  console.log("");
  if (failures) {
    console.log(`${failures} problem(s). Re-run without --check to (re)place missing artifacts.`);
    process.exit(1);
  }
  console.log(
    CHECK_ONLY
      ? "All vendored artifacts present.\nNeural face detector will activate on next extension load."
      : "Done. Reload the extension at chrome://extensions — vision-neural.js now augments\nthe classical core automatically (union-biased fusion, fail-closed)."
  );
}

async function run() {
  let failures = 0;

  // ---- 1. onnxruntime-web: ESM API entry + WASM/JSEP backends --------------
  const ortHasWasm = existsSync(VENDOR_ORT) && readdirSync(VENDOR_ORT).some((f) => /^ort-.*\.wasm$/.test(f));
  const needOrt = !existsSync(ORT_API_DEST) || !ortHasWasm;
  if (!needOrt) {
    console.log(`• present  ${path.relative(ROOT, ORT_API_DEST)} + ORT wasm`);
  } else if (CHECK_ONLY) {
    if (!existsSync(ORT_API_DEST)) { console.log(`✗ MISSING ${path.relative(ROOT, ORT_API_DEST)}`); failures++; }
    if (!ortHasWasm) { console.log(`✗ no ort-*.wasm under lib/vendor/ort/`); failures++; }
  } else {
    try {
      const dist = await fetchTarballExtract(ORT_NPM_TARBALL, `onnxruntime-web-${ORT_WEB_VERSION}`);
      mkdirSync(VENDOR_ORT, { recursive: true });
      const distFiles = readdirSync(dist);
      // ESM API entry files are named "ort.*.mjs" (DOT after ort); internal backend/
      // glue files are "ort-*.mjs" (HYPHEN). That naming split is stable across ORT
      // versions, so prefer our ordered candidates, then fall back to the best
      // "ort.*.mjs" present (webgpu > bundle > min > all) if the layout shifted.
      const entryFiles = distFiles.filter((f) => /^ort\..*\.mjs$/.test(f));
      const score = (f) => (/webgpu/.test(f) ? 8 : 0) + (/bundle/.test(f) ? 4 : 0) + (/\.min\./.test(f) ? 2 : 0) + (/all/.test(f) ? 1 : 0);
      const apiName =
        ORT_API_CANDIDATES.find((n) => distFiles.includes(n)) ||
        entryFiles.slice().sort((a, b) => score(b) - score(a) || a.length - b.length)[0];
      if (!apiName) throw new Error(`no ESM API entry (ort.*.mjs) in dist; .mjs present: ${distFiles.filter((f) => f.endsWith(".mjs")).join(", ") || "none"}`);
      await writeFile(ORT_API_DEST, await readFile(path.join(dist, apiName)));
      // All ORT backends: .wasm binaries + .mjs glue (covers bundle & non-bundle entries).
      // Sibling-relative imports inside the entry resolve fine — glue keeps its dist name,
      // only the entry is renamed, and both live in the same vendored dir.
      let n = 0;
      for (const f of distFiles) {
        if (/^ort-.*\.(wasm|mjs)$/.test(f)) { await writeFile(path.join(VENDOR_ORT, f), await readFile(path.join(dist, f))); n++; }
      }
      console.log(`✓ ort-webgpu-api.mjs (from ${apiName}) + ${n} backend file(s) → lib/vendor/ort/`);
      if (!n) console.log(`  ⚠ no ort-*.wasm/.mjs backends found in dist — WebGPU/WASM EP will fail to load.`);
    } catch (e) {
      console.log(`✗ onnxruntime-web vendoring failed: ${e.message}`); failures++;
    }
  }

  // ---- 2. model weights ----------------------------------------------------
  for (const m of MODELS) {
    const modelRoot = path.join(MODELS_DIR, ...m.id.split("/"));
    const destPath = path.join(modelRoot, m.destRel);
    if (existsSync(destPath)) {
      console.log(`• present  ${path.relative(ROOT, destPath)} (${hr(statSync(destPath).size)})`);
    } else if (CHECK_ONLY) {
      console.log(`✗ MISSING ${path.relative(ROOT, destPath)}`); failures++;
    } else if (m.localSource && existsSync(m.localSource)) {
      try {
        mkdirSync(modelRoot, { recursive: true });
        const buf = await readFile(m.localSource);
        await writeFile(destPath, buf);
        const warn = buf.length > m.sizeWarnMB * 1048576 ? "  (⚠ larger than expected)" : "";
        console.log(`✓ ${m.id} ← ${path.relative(ROOT, m.localSource)} (${hr(buf.length)})${warn}`);
      } catch (e) { console.log(`✗ ${m.id} copy failed: ${e.message}`); failures++; }
    } else if (m.files) {
      // Remote (HuggingFace) download. `hfRepo` overrides the local `id` as the repo path.
      try {
        let total = 0;
        for (const f of m.files) {
          const [repoPath, destRel] = Array.isArray(f) ? f : [f, f];
          total += await downloadTo(`https://huggingface.co/${m.hfRepo || m.id}/resolve/main/${repoPath}`, path.join(modelRoot, destRel));
        }
        console.log(`✓ ${m.id} (${hr(total)}) [downloaded from HF]`);
      } catch (e) { console.log(`✗ ${m.id} failed: ${e.message}`); failures++; }
    } else if (m.localSource) {
      console.log(`✗ ${m.id}: local source not found at ${path.relative(ROOT, m.localSource)}`);
      console.log(`   export it first (in ml_env):  yolo export model=yolov8n-face.pt format=onnx imgsz=640 opset=12`);
      failures++;
    }
    // integrity probe on whatever is on disk
    if (existsSync(destPath)) {
      const head = (await readFile(destPath)).subarray(0, 16);
      if (!looksLikeOnnx(head)) { console.log(`✗ ${m.destRel}: bad magic bytes (not ONNX/protobuf)`); failures++; }
    }
  }

  return failures;
}

main().catch((e) => { console.error(e); process.exit(1); });
