#!/usr/bin/env node
/*
 * vendor-vision.mjs — One-command vendoring of the on-device neural vision stack.
 *
 * The extension CSP (`script-src 'self' 'wasm-unsafe-eval'`) forbids loading
 * libraries or weights from a CDN at runtime — that is the privacy point. So the
 * transformers.js bundle, its ONNX-Runtime WASM backend, and the model weights
 * must be downloaded ONCE at build time and packaged INSIDE the extension.
 *
 *   node tools/vendor-vision.mjs             # download whatever is missing
 *   node tools/vendor-vision.mjs --check     # verify presence + integrity only
 *
 * Everything lands in paths that are already .gitignore'd (binaries stay out of
 * VCS) and already wired into the extension:
 *   extension/lib/vendor/transformers/transformers.min.js
 *   extension/lib/vendor/ort/*.wasm *.mjs
 *   extension/models/<model-id>/config.json preprocessor_config.json onnx/model_quantized.onnx
 *
 * After vendoring, vision-neural.js picks the stack up automatically on next
 * load (it is a no-op until then). See docs/VENDORING.md.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// On Windows, `new URL(import.meta.url).pathname` yields "/C:/Users/..." — the
// leading slash makes path.resolve prepend the current drive ("C:\C:\Users\...").
// fileURLToPath() converts a file:// URL to a real OS path on every platform.
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const EXT = path.join(ROOT, "extension");
const VENDOR_TS = path.join(EXT, "lib", "vendor", "transformers");
const VENDOR_ORT = path.join(EXT, "lib", "vendor", "ort");
const MODELS_DIR = path.join(EXT, "models");

// ---- pinned artifact versions -------------------------------------------------
// Bump deliberately: weights + runtime must stay mutually compatible.
const TRANSFORMERS_VERSION = "4.2.0";
const NPM_TARBALL = `https://registry.npmjs.org/@huggingface/transformers/-/transformers-${TRANSFORMERS_VERSION}.tgz`;
// transformers.js 4.x no longer bundles ORT's .wasm binaries in its own tarball;
// they live in the exact onnxruntime-web build it depends on (package.json).
const ORT_WEB_VERSION = "1.26.0-dev.20260416-b7804b056c";
const ORT_NPM_TARBALL = `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${ORT_WEB_VERSION}.tgz`;

// Model registry — mirrors REGISTRY in extension/lib/vision/vision-neural.js.
// Each entry: HF repo id → the exact files the object-detection pipeline needs.
const MODELS = [
  {
    id: "Xenova/yolos-tiny",
    dtype: "q8",
    files: [
      "config.json",
      "preprocessor_config.json",
      ["onnx/model_quantized.onnx", "onnx/model_quantized.onnx"], // [repoPath, destRel]
    ],
    sizeWarnMB: 30,
  },
];

const CHECK_ONLY = process.argv.includes("--check");

function hr(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

// Integrity probes: catches truncated/corrupt downloads cheaply (no deps).
function looksLikeOnnx(head) {
  // ONNX is protobuf; model files start with field-1 varint (ir_version) = 0x08.
  return head.length >= 4 && head[0] === 0x08;
}
function looksLikeWasm(buf) {
  return buf.length > 8 && buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d; // "\0asm"
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
    // NOTE: rm here is the node:fs/promises (async) variant — MUST be awaited,
    // otherwise it fires concurrently and deletes the dir recreated below.
    await rm(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    let buf;
    for (let attempt = 1; ; attempt++) {
      try {
        if (!buf) {
          buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 1024) throw new Error(`tarball suspiciously small (${buf.length} B)`);
        }
        await writeFile(tmpTgz, buf);
        // Run tar with cwd=work and a RELATIVE filename. A Windows absolute path
        // ("C:\...") on tar's command line is misread by GNU tar as a remote host
        // ("host:path" syntax) → "Cannot connect to C:". Relative + cwd avoids the
        // drive-letter colon entirely and works for both GNU tar and bsdtar.
        execFileSync("tar", ["-xzf", `${label}.tgz`], { cwd: work }); // throws if file vanished
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
  // ---- summary -------------------------------------------------------------
  console.log("");
  if (failures) {
    console.log(`${failures} problem(s). Re-run without --check to (re)download.`);
    process.exit(1);
  }
  console.log(
    CHECK_ONLY
      ? "All vendored artifacts present.\nNeural detector will activate on next extension load."
      : "Done. Reload the extension at chrome://extensions — vision-neural.js now augments\nthe classical core automatically (union-biased fusion, fail-closed)."
  );
}

async function run() {
  let failures = 0;

  // ---- 1. transformers.js ESM bundle + ORT runtime ------------------------
  const tsJs = path.join(VENDOR_TS, "transformers.min.js");
  const ortHasWasm = existsSync(VENDOR_ORT) && readdirSync(VENDOR_ORT).some((f) => f.endsWith(".wasm"));
  const needBundle = !existsSync(tsJs);
  const needOrt = !ortHasWasm;
  if (needBundle || needOrt) {
    if (CHECK_ONLY) {
      if (needBundle) { console.log(`✗ MISSING ${path.relative(ROOT, tsJs)}`); failures++; }
      if (needOrt) { console.log(`✗ no .wasm under lib/vendor/ort/`); failures++; }
    } else {
      try {
        // transformers.js tarball: ESM bundle + its patched ORT loader (.mjs)
        const dist = await fetchTarballExtract(NPM_TARBALL, `transformers-${TRANSFORMERS_VERSION}`);
        mkdirSync(VENDOR_TS, { recursive: true });
        if (needBundle) {
          const n = statSync(path.join(dist, "transformers.min.js")).size;
          await writeFile(tsJs, await readFile(path.join(dist, "transformers.min.js")));
          console.log(`✓ transformers.min.js (${hr(n)})`);
        }
        if (needOrt) {
          mkdirSync(VENDOR_ORT, { recursive: true });
          let ortCount = 0;
          for (const f of readdirSync(dist)) {
            // ORT loader + wasm only; skip transformers' own node-target bundles
            if (/^ort-.*\.wasm$/.test(f) || /^ort-.*\.mjs$/.test(f)) {
              await writeFile(path.join(VENDOR_ORT, f), await readFile(path.join(dist, f)));
              ortCount++;
            }
          }
          // onnxruntime-web tarball: the actual .wasm binaries (not bundled in
          // transformers.js ≥4.x — must match the pinned dependency exactly).
          const ortDist = await fetchTarballExtract(ORT_NPM_TARBALL, `onnxruntime-web-${ORT_WEB_VERSION}`);
          for (const f of readdirSync(ortDist)) {
            if (/^ort-.*\.wasm$/.test(f) && !existsSync(path.join(VENDOR_ORT, f))) {
              await writeFile(path.join(VENDOR_ORT, f), await readFile(path.join(ortDist, f)));
              ortCount++;
            }
          }
          console.log(`✓ ${ortCount} ORT runtime files → lib/vendor/ort/`);
        }
      } catch (e) {
        console.log(`✗ transformers bundle failed: ${e.message}`); failures++;
      }
    }
  } else {
    console.log(`• present  ${path.relative(ROOT, tsJs)} (${hr(statSync(tsJs).size)}) + ORT wasm`);
  }

  // ---- 2. model weights ----------------------------------------------------
  for (const m of MODELS) {
    const modelRoot = path.join(MODELS_DIR, ...m.id.split("/"));
    const onnxRel = m.files.find((f) => Array.isArray(f))[1];
    const onnxPath = path.join(modelRoot, onnxRel);
    if (!existsSync(onnxPath)) {
      if (CHECK_ONLY) { console.log(`✗ MISSING ${path.relative(ROOT, onnxPath)}`); failures++; continue; }
      try {
        let total = 0;
        for (const f of m.files) {
          const [repoPath, destRel] = Array.isArray(f) ? f : [f, f];
          const url = `https://huggingface.co/${m.id}/resolve/main/${repoPath}`;
          total += await downloadTo(url, path.join(modelRoot, destRel));
        }
        const warn = total > m.sizeWarnMB * 1048576 ? "  (⚠ larger than expected)" : "";
        console.log(`✓ ${m.id} (${hr(total)})${warn}`);
      } catch (e) {
        console.log(`✗ ${m.id} failed: ${e.message}`); failures++;
      }
    } else {
      console.log(`• present  models/${m.id}/${onnxRel} (${hr(statSync(onnxPath).size)})`);
    }
    // integrity probe on whatever is on disk
    if (existsSync(onnxPath)) {
      const head = (await readFile(onnxPath)).subarray(0, 16);
      if (!looksLikeOnnx(head)) { console.log(`✗ ${onnxRel}: bad magic bytes (not ONNX/protobuf)`); failures++; }
    }
  }

  return failures;
}

main().catch((e) => { console.error(e); process.exit(1); });
