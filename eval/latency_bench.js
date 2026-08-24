/*
 * latency_bench.js — Metric #5 (end-to-end latency) + a proxy for Metric #4
 * (client resource cost) via local detector throughput.
 *
 * Measures:
 *   - local PII scan latency over a realistic page-text blob (p50/p95, chars/ms)
 *   - server /plan round-trip latency percentiles (skipped if server is down)
 * Node 18+ (global fetch) required for the server portion.
 */
const path = require("path");
const pii = require(path.join(__dirname, "..", "extension", "lib", "privacy", "pii-regex.js"));

const SERVER = process.env.PBA_SERVER || "http://localhost:8000";

function pct(arr, p) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function benchLocal() {
  const blob = ("Name: A. User  Email: a.user@example.com  Phone: 9876543210  " +
    "Aadhaar 2234 5678 9012  PAN ABCPU1234K  Card 4111 1111 1111 1111  " +
    "Some ordinary paragraph text repeated. ").repeat(40); // ~ several KB
  const times = [];
  for (let i = 0; i < 200; i++) { const t = performance.now(); pii.scan(blob); times.push(performance.now() - t); }
  return { chars: blob.length, p50_ms: +pct(times, 50).toFixed(3), p95_ms: +pct(times, 95).toFixed(3),
    chars_per_ms: Math.round(blob.length / pct(times, 50)) };
}

async function benchServer() {
  const ctx = {
    protocol_version: "1.0", session_id: "bench", step: 1, task: "submit the form",
    url_origin: "https://example.gov.in",
    viewport: { w: 1280, h: 720, scroll_x: 0, scroll_y: 0, dpr: 1 },
    screenshot: null, screenshot_included: false,
    elements: [
      { id: 0, role: "textbox", label: "Email", bbox: [10, 10, 200, 30], enabled: true, value_state: "empty", sensitive: true, pii_type: "email" },
      { id: 1, role: "button", label: "Submit Application", bbox: [10, 60, 160, 36], enabled: true, value_state: "empty", sensitive: false },
    ],
    redactions: [], privacy_receipt: { detected: 1, redacted: 1, residual_risk: "low", send_screenshot: false, fail_closed_triggered: false, categories: { email: 1 } },
  };
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    const r = await fetch(SERVER + "/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ctx) });
    await r.json();
    times.push(performance.now() - t);
  }
  return { n: times.length, p50_ms: +pct(times, 50).toFixed(1), p95_ms: +pct(times, 95).toFixed(1) };
}

async function main() {
  const local = benchLocal();
  console.log("\n=== Metric #5/#4 — latency & local throughput ===");
  console.log(`local PII scan : p50 ${local.p50_ms}ms  p95 ${local.p95_ms}ms  (${local.chars_per_ms} chars/ms over ${local.chars} chars)`);
  let server = null;
  try { server = await benchServer(); console.log(`server /plan   : p50 ${server.p50_ms}ms  p95 ${server.p95_ms}ms  (n=${server.n})`); }
  catch (e) { console.log(`server /plan   : SKIPPED (${SERVER} unreachable — start the server to measure)`); }
  const fs = require("fs");
  fs.writeFileSync(path.join(__dirname, "out_latency.json"), JSON.stringify({ local, server }, null, 2));
  return { local, server };
}

if (require.main === module) main();
module.exports = { main, benchLocal };
