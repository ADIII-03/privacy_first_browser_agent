/*
 * show_boxes.js — shared probe helper: draw detection boxes on an image and OPEN it in
 * the OS default image viewer, WITHOUT saving into the repo. It writes a transient PNG to
 * the OS temp dir (os.tmpdir()) — cleaned up by the OS, never a workspace file — then
 * launches the platform viewer (start / open / xdg-open). Used by face_probe.js and
 * signature_probe.js so a run pops up the picture with boxes drawn, instead of only
 * printing coordinates. Disable with --no-show. Best-effort: never throws into the caller.
 *
 * boxes: [{ x, y, w, h, score }] in ORIGINAL image pixels (the probes already un-letterbox).
 * opts:  { conf } — boxes with score >= conf draw GREEN, below draw RED (so a near-miss is
 *                    visible as a red box with its score, e.g. the 0.33 signature case).
 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function showBoxes(sharp, imgPath, boxes, opts = {}) {
  try {
    const conf = opts.conf != null ? opts.conf : 0;
    const meta = await sharp(imgPath).metadata();
    const W = meta.width, H = meta.height;
    const parts = (boxes || []).map((b) => {
      const col = b.score >= conf ? "#00c853" : "#ff5252"; // green if it would ship, red if below
      const x = Math.round(b.x), y = Math.round(b.y), w = Math.round(b.w), h = Math.round(b.h);
      const ty = y - 5 > 14 ? y - 5 : y + 18; // keep the label on-canvas
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${col}" stroke-width="3"/>`
        + `<text x="${x + 3}" y="${ty}" font-size="18" font-family="sans-serif" font-weight="bold" fill="${col}">${esc(b.score.toFixed(3))}</text>`;
    });
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`);
    const png = await sharp(imgPath).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
    const base = path.basename(imgPath).replace(/\.[^.]+$/, "");
    const tmp = path.join(os.tmpdir(), `probe_${base}_${Date.now()}.png`);
    fs.writeFileSync(tmp, png);
    openInViewer(tmp);
    console.log(`  [shown] ${(boxes || []).length} box(es) drawn -> opened ${tmp}`);
  } catch (e) {
    console.log(`  [show skipped: ${e.message}]`);
  }
}

function openInViewer(file) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [file], { detached: true, stdio: "ignore" }).unref();
  } catch (_) { /* headless / no viewer — the temp path was printed above */ }
}

module.exports = { showBoxes };
