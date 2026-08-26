#!/usr/bin/env node
/*
 * inspect_onnx.cjs — Print an ONNX model's graph input/output tensor shapes
 * WITHOUT running it (no wasm, no network). Used to verify a downloaded face
 * model matches the contract that extension/lib/vision/vision-neural.js decodes:
 *   input  : [1, 3, 640, 640]  (or dynamic H/W)  — 3-channel image, letterboxed to 640
 *   output : [1, C, N]         with C in {5, 20}  — box(4) + faceScore(idx 4) [+ kpts]
 *
 *   node eval/inspect_onnx.cjs eval/models/yolov8n-face.onnx
 */
const fs = require("node:fs");
const protobuf = require("protobufjs");

const PROTO = `
syntax = "proto3";
package onnx;
message ModelProto { GraphProto graph = 7; }
message GraphProto {
  repeated ValueInfoProto input = 11;
  repeated ValueInfoProto output = 12;
}
message ValueInfoProto { string name = 1; TypeProto type = 2; }
message TypeProto { TensorTypeProto tensor_type = 1; }
message TensorTypeProto { int32 elem_type = 1; TensorShapeProto shape = 2; }
message TensorShapeProto { repeated Dimension dim = 1; }
message Dimension { int64 dim_value = 1; string dim_param = 2; }
`;

const ELEM = { 1: "float32", 2: "uint8", 3: "int8", 6: "int32", 7: "int64", 10: "float16", 11: "double" };

function dims(vi) {
  const s = vi.type?.tensorType?.shape?.dim || [];
  return s.map((d) => {
    const v = d.dimValue != null ? Number(d.dimValue) : 0;
    return v > 0 ? v : (d.dimParam ? `?${d.dimParam}` : "?");
  });
}
function elem(vi) { return ELEM[vi.type?.tensorType?.elemType] || `type#${vi.type?.tensorType?.elemType}`; }

const file = process.argv[2] || "eval/models/yolov8n-face.onnx";
const root = protobuf.parse(PROTO).root;
const ModelProto = root.lookupType("onnx.ModelProto");
const model = ModelProto.decode(fs.readFileSync(file));
const g = model.graph;

console.log(`\nmodel: ${file}\n`);
console.log("INPUTS:");
for (const i of g.input) console.log(`  ${i.name.padEnd(14)} ${elem(i)}  [${dims(i).join(", ")}]`);
console.log("OUTPUTS:");
for (const o of g.output) console.log(`  ${o.name.padEnd(14)} ${elem(o)}  [${dims(o).join(", ")}]`);

// --- contract check --------------------------------------------------------
const inp = g.input[0], out = g.output[0];
const id = dims(inp), od = dims(out).map((x) => (typeof x === "number" ? x : NaN));
const chOK = id.length === 4 && id[1] === 3;
const C = od.slice(1).find((n) => n === 5 || n === 20); // channel dim among trailing dims
const nmsBaked = od.some((n) => n === 6) && od.length === 3; // e.g. [1,300,6] = end2end NMS
console.log("");
if (nmsBaked) {
  console.log("✗ FAIL: output looks like end-to-end NMS ([*, *, 6]); decodeYolo expects the RAW head.");
  process.exit(2);
}
if (chOK && C) {
  console.log(`✓ OK: 3-channel image input and a raw YOLO head with C=${C} (box 0-3, face score @ idx 4).`);
  console.log("  Matches vision-neural.js decodeYolo (scoreIndex 4). Safe to vendor.");
  process.exit(0);
}
console.log("⚠ UNSURE: shapes don't obviously match [1,3,H,W] -> [1,{5|20},N]. Inspect manually before shipping.");
process.exit(1);
