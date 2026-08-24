/*
 * screen_truth.js — Synthetic, labeled "screen truth" for Metric #1.
 *
 * Metric #1 (Accuracy of visual context) needs images with KNOWN ground-truth
 * boxes for the visual PII the on-device detector is responsible for: human FACES
 * and handwritten SIGNATURES. We paint them procedurally (deterministically — no
 * RNG) so the exact shipped detector core (vision-detector.js) can be scored in
 * Node with no browser and no model download.
 *
 * Each scene is { name, image:{data,width,height}, truth:[{pii_type,bbox}] }.
 * Scenes deliberately include HARD NEGATIVES (solid colour blocks, a saturated-red
 * button, a dense dark photo block, a text paragraph, a blank page) whose truth is
 * empty — a detector that fires on those loses precision, exactly what the metric
 * should punish. Skin tones span light→dark so the metric rewards fair coverage.
 */
const FACE = "face", SIGNATURE = "signature";

function blank(w, h, shade) {
  const s = shade == null ? 245 : shade;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = s; d[i * 4 + 1] = s; d[i * 4 + 2] = s; d[i * 4 + 3] = 255; }
  return { data: d, width: w, height: h };
}
function px(img, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
}
function rect(img, x0, y0, w, h, r, g, b) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(img, x, y, r, g, b);
}
// Filled ellipse → a face-like solid skin region. Returns its ground-truth bbox.
function face(img, cx, cy, rx, ry, tone) {
  const [r, g, b] = tone;
  for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
    const nx = (x - cx) / rx, ny = (y - cy) / ry;
    if (nx * nx + ny * ny <= 1) px(img, x, y, r, g, b);
  }
  return { pii_type: FACE, bbox: [cx - rx, cy - ry, 2 * rx, 2 * ry] };
}
// Sparse dark stroke(s) → a handwritten signature. Returns its ground-truth bbox.
function signature(img, x0, y0, w, amp, period, thick, segments) {
  segments = segments || [[0, w]];
  let minY = 1e9, maxY = -1e9;
  for (const [sa, sb] of segments) {
    for (let t = sa; t < sb; t++) {
      const x = x0 + t;
      const y = Math.round(y0 + amp * Math.sin(t / period));
      for (let k = -thick; k <= thick; k++) {
        const yy = y + k;
        px(img, x, yy, 20, 20, 45);
        if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
      }
    }
  }
  return { pii_type: SIGNATURE, bbox: [x0, minY, w, maxY - minY + 1] };
}
// A dense block of small dark glyphs → printed text (NOT a signature).
function textParagraph(img, x0, y0, rows, rowW, gap) {
  for (let r = 0; r < rows; r++) {
    const ry = y0 + r * gap;
    for (let cx = 0; cx < rowW; cx += 7) rect(img, x0 + cx, ry, 5, 8, 35, 35, 35);
  }
}

const TONES = { light: [233, 196, 166], medium: [198, 134, 66], dark: [141, 85, 36] };

function scenes() {
  const S = [];
  const add = (name, image, truth) => S.push({ name, image, truth });

  // ---- faces -------------------------------------------------------------
  let s;
  s = blank(480, 320); add("single_face_medium", s, [face(s, 130, 140, 46, 56, TONES.medium)]);

  s = blank(560, 320);
  add("two_faces_row", s, [
    face(s, 150, 150, 44, 54, TONES.light),
    face(s, 380, 150, 44, 54, TONES.dark),
  ]);

  s = blank(480, 320);
  add("face_light_and_dark", s, [
    face(s, 130, 150, 42, 52, TONES.light),
    face(s, 330, 150, 42, 52, TONES.dark),
  ]);

  // ---- signatures --------------------------------------------------------
  s = blank(560, 300); add("single_signature", s, [signature(s, 80, 170, 320, 12, 12, 2)]);

  s = blank(560, 300);
  // pen-lift: two segments with a small gap the horizontal closing should bridge
  add("penlift_signature", s, [signature(s, 90, 170, 300, 12, 11, 2, [[0, 120], [140, 300]])]);

  // ---- mixed -------------------------------------------------------------
  s = blank(600, 360);
  add("face_and_signature", s, [
    face(s, 140, 120, 44, 54, TONES.medium),
    signature(s, 300, 240, 250, 10, 12, 2),
  ]);

  // ---- hard negatives (truth = []) --------------------------------------
  s = blank(480, 320); rect(s, 90, 90, 130, 130, 40, 90, 200); add("neg_blue_block", s, []);
  s = blank(480, 320); rect(s, 90, 90, 150, 60, 220, 25, 25); add("neg_red_button", s, []);
  s = blank(480, 320); rect(s, 80, 70, 220, 140, 22, 22, 22); add("neg_dark_photo", s, []);
  s = blank(560, 320); textParagraph(s, 50, 70, 7, 440, 18); add("neg_text_paragraph", s, []);
  s = blank(480, 320); add("neg_blank_page", s, []);

  return S;
}

// A synthetic Set-of-Marks payload for the grounding-integrity check (see
// vision_eval.js). Mirrors the shape dom-perception.js produces in the browser.
function groundingSample() {
  const viewport = { w: 1280, h: 720 };
  const elements = [
    { id: 0, role: "textbox", bbox: [40, 60, 220, 32] },
    { id: 1, role: "textbox", bbox: [40, 110, 220, 32] },
    { id: 2, role: "button", bbox: [40, 160, 140, 36] },
    { id: 3, role: "link", bbox: [300, 60, 90, 20] },
  ];
  const marks = elements.map((e) => ({ id: e.id, bbox: e.bbox, sensitive: false }));
  return { viewport, elements, marks };
}

module.exports = { scenes, groundingSample, TONES };
