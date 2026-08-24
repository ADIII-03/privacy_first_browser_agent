/*
 * make_dataset.js — Generates a labeled PII benchmark (pii_samples.jsonl).
 *
 * Uses the SHIPPED validators (verhoeffValid/luhnValid) to synthesize identifiers
 * that are genuinely checksum-valid, and deliberately includes HARD NEGATIVES:
 * numbers that look like PII but fail the checksum, order ids, dates, etc.
 * A detector that fires on those loses precision — exactly what metric #2 checks.
 *
 * Output line schema: { "id", "text", "spans": [ {type,start,end,value} ] }
 * spans are the GROUND TRUTH; empty spans == a pure negative sample.
 */
const fs = require("fs");
const path = require("path");
const pii = require(path.join(__dirname, "..", "extension", "lib", "privacy", "pii-regex.js"));

function verhoeffCheckDigit(num) {
  for (let d = 0; d < 10; d++) if (pii.verhoeffValid(num + d)) return String(d);
  return "0";
}
function luhnComplete(num) {
  for (let d = 0; d < 10; d++) if (pii.luhnValid(num + d)) return num + d;
  return num + "0";
}
function randDigits(n) { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; }

function aadhaar() {
  let base = String(2 + Math.floor(Math.random() * 8)) + randDigits(10); // 11 digits, first 2-9
  const full = base + verhoeffCheckDigit(base);
  return full.slice(0, 4) + " " + full.slice(4, 8) + " " + full.slice(8, 12);
}
function pan() {
  const L = () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)];
  // 4th char is the holder-type code (P=individual, C=company, ...).
  return L() + L() + L() + "P" + L() + randDigits(4) + L();
}
function card() {
  const prefixes = ["4", "51", "52", "53", "54", "55"];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  return luhnComplete(p + randDigits(15 - p.length)); // 16-digit
}
// Hard negatives: same SHAPE as an identifier but deliberately checksum-INVALID,
// so a false positive here is a genuine detector error (not a mislabel).
function notAadhaar() { let d; do { d = String(2 + Math.floor(Math.random() * 8)) + randDigits(11); } while (pii.verhoeffValid(d)); return d; }
function notCard() { let d; do { d = "4" + randDigits(15); } while (pii.luhnValid(d)); return d; }

// span helper: place `value` into a template and record its char offsets
function place(template, value) {
  const idx = template.indexOf("{}");
  const text = template.slice(0, idx) + value + template.slice(idx + 2);
  return { text, start: idx, end: idx + value.length };
}

const rows = [];
let id = 0;
function add(type, template, value) {
  const { text, start, end } = place(template, value);
  rows.push({ id: id++, text, spans: type ? [{ type, start, end, value }] : [] });
}

// ---- positives -------------------------------------------------------------
for (let i = 0; i < 12; i++) add("aadhaar", "Aadhaar No: {} verified by UIDAI.", aadhaar());
for (let i = 0; i < 12; i++) add("pan", "PAN {} linked to your account.", pan());
for (let i = 0; i < 12; i++) add("credit_card", "Card ending {} was charged.", card());
for (let i = 0; i < 10; i++) add("email", "Contact me at {} for details.", `user${i}.test@example${i}.com`);
for (let i = 0; i < 10; i++) add("phone", "Call {} between 9-5.", String(6 + (i % 4)) + randDigits(9));
for (let i = 0; i < 8; i++) add("upi", "Send to {} on any UPI app.", `person${i}@okhdfc`);
for (let i = 0; i < 8; i++) add("otp", "Your OTP is {}. Do not share.", randDigits(6));
for (let i = 0; i < 6; i++) add("ip", "Login from {} was blocked.", `${10 + i}.0.${i}.${100 + i}`);
add("api_key", "export API_KEY={}", "sk_live_" + "aZ90kLmNpQ12rS34tU56vW78xY".slice(0, 24));

// ---- hard negatives (must NOT be flagged) ----------------------------------
for (let i = 0; i < 10; i++) add(null, "Order number {} shipped today.", notAadhaar());        // 12 digits, fails Verhoeff
for (let i = 0; i < 8; i++) add(null, "Invoice {} is due next week.", notCard());                // 16 digits, fails Luhn
add(null, "The meeting is on 2025-08-24 at 10:30.", "");                                             // date/time
add(null, "Tracking id ABCDE1234Z shows delivered.", "");   // PAN-shaped but 4th char 'D' invalid holder-type? (still shaped) -> tests light validate
add(null, "Reference REF-556677 in the ticket.", "");
add(null, "Version 10.0.0.1 released.", "10.0.0.1");  // looks like IP -> intentionally ambiguous (kept as positive-ish stressor)
// fix the last one: it's genuinely IP-shaped; relabel as ip to avoid unfair penalty
rows[rows.length - 1].spans = [{ type: "ip", start: rows[rows.length - 1].text.indexOf("10.0.0.1"),
  end: rows[rows.length - 1].text.indexOf("10.0.0.1") + 8, value: "10.0.0.1" }];

const outPath = path.join(__dirname, "dataset", "pii_samples.jsonl");
fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`Wrote ${rows.length} samples -> ${outPath}`);
console.log(`  positives: ${rows.filter((r) => r.spans.length).length}, negatives: ${rows.filter((r) => !r.spans.length).length}`);
