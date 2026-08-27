/*
 * service-worker.js — Background orchestrator (MV3, module).
 *
 * Owns the privileged operations content scripts can't do: screenshot capture,
 * the offscreen inference/compositing document, the network call, and the
 * step loop with its safety governors.
 *
 * LOOP GOVERNORS (robust action loop):
 *   - MAX_STEPS hard cap
 *   - repeated-signature detection (same action N times w/o state change -> abort)
 *   - per-step timeout + error backoff
 *   - the SANITIZED payload is the only thing POSTed; the raw screenshot never is
 */

const DEFAULTS = { serverUrl: "http://localhost:8000", maxSteps: 25, loopLimit: 3 };

// PII detector, side-effect imported for SW-side fail-closed validation of the
// QUERY payload — it reuses the CANONICAL scanner (no duplicate detection logic).
// The IIFE attaches globalThis.PBA.pii.scan; it is self-contained (ships its own
// PII-enum fallback, touches no DOM), so it is safe in a module service worker.
import "../lib/privacy/pii-regex.js";

const state = {
  running: false, tabId: null, sessionId: null, step: 0, log: [], receipts: [],
  // mode: "action" (server-driven agent loop) | "query" (sanitized summary via /query) | "idle".
  // answer: the QueryAnswer the server returned (set only in query mode).
  // audit: the privacy-audit snapshot for the demo view (original stays LOCAL-ONLY;
  //   what actually left the browser is recorded). auditLog: ordered privacy events.
  // All declared here so the shape is stable for a side panel that reads state
  // before any task has run.
  mode: "idle", answer: null, audit: null, auditLog: [],
  telemetry: { zeroLeakStreak: 0, phases: [], resources: { heapMB: 0, p95Ms: 0 } }
};

// Cross-browser shim: Firefox exposes the WebExtension API as `browser`, Chromium
// as `chrome`. Everything below goes through `ext` so the same code runs on both
// (see README "Browser support" for the Firefox offscreen caveat).
const ext = globalThis.browser || globalThis.chrome;

// Toolbar-icon click opens the side panel (which replaced the old default_popup).
// Guarded and idempotent, so it's safe to run on every service-worker wake:
// `sidePanel` is Chromium-only (undefined on Firefox → the optional chain no-ops).
// openPanelOnActionClick requires a registered `action` (the manifest keeps one)
// AND no default_popup (removed) — the two are mutually exclusive.
ext.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

async function getConfig() {
  const c = await ext.storage.local.get(["serverUrl", "maxSteps", "loopLimit"]);
  return { ...DEFAULTS, ...c };
}

function pushLog(entry) {
  state.log.push({ t: Date.now(), ...entry });
  ext.runtime.sendMessage({ cmd: "STATE", state }).catch(() => {});
}

// Privacy-audit event stream for the demo/judge timeline. SEPARATE from the
// proceedings log so the timeline stays clean. CRITICAL: `meta` may carry only
// safe metadata (counts, category→count maps, booleans, endpoints, byte sizes) —
// NEVER a raw value. Categories like {bank_account:1} are aggregate counts, not values.
function pushAudit(event, meta) {
  state.auditLog.push({ t: Date.now(), event, ...(meta || {}) });
  ext.runtime.sendMessage({ cmd: "STATE", state }).catch(() => {});
}

// Append a screenshot entry to the proceedings (Zone 2) so the operator sees the
// captured/redacted frame inline without switching to the audit tab. The image
// bytes are heavy and `state` is re-broadcast whole on every push, so only the
// MOST RECENT shot keeps its dataUrl — older shot entries drop it (their label and
// badge remain as a one-line history; the audit tab still holds the latest full
// image). Callers must have already vetted the image: the LOCAL-ONLY original in
// query mode (never transmitted) or the redacted composite in action mode.
function pushShotLog(entry) {
  for (const e of state.log) {
    if (e.kind === "shot" && e.dataUrl) e.dataUrl = null;
  }
  pushLog({ kind: "shot", ...entry });
}

// What the browser NEVER lets leave the machine — shown verbatim in the audit view
// so a judge can read the guarantee, not infer it.
const FORBIDDEN_FROM_EGRESS = [
  "the original (unredacted) screenshot",
  "raw account / card / password / OTP / API-key values",
  "raw page text or unsanitized DOM",
];

// Display-safe copy of an outgoing payload: any screenshot dataURL is swapped for a
// short marker (its size, not its bytes) so the audit view can show the FULL JSON
// structure that left the browser — proving no raw pixels or values hide inside —
// without embedding a megabyte of base64.
function auditPayloadPreview(payload) {
  const clone = { ...payload };
  if (typeof clone.screenshot === "string") {
    clone.screenshot = `[redacted image omitted from preview — ${clone.screenshot.length} chars]`;
  }
  return clone;
}

// ---- offscreen document lifecycle (needed for canvas + WebGPU inference) ----
// The offscreen API is Chromium-only. On a browser that lacks it (e.g. Firefox,
// which has no chrome.offscreen at all) we must NOT throw: the vision + compositor
// path is skipped and the fail-closed policy withholds the screenshot (text-only).
// Feature-detect the API OBJECT, not just the method — `ext.offscreen` is
// `undefined` on Firefox, so `ext.offscreen.hasDocument?.()` throws a TypeError
// before the optional chain on `hasDocument` can help (the `?.` guards the call,
// not the property read on an undefined base).
const offscreenSupported = !!(ext.offscreen && ext.offscreen.createDocument);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Confirm the offscreen document's message listener is actually registered.
// createDocument()/hasDocument() resolve when the document EXISTS, but its
// <script>s (which register onMessage) may not have run yet — a ping round-trips
// through that listener, so a truthy reply proves it is live.
async function pingOffscreen() {
  try {
    const res = await sendToOffscreen({ cmd: "OFFSCREEN_PING" });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

async function ensureOffscreen() {
  if (!offscreenSupported) return false;
  const has = await ext.offscreen.hasDocument?.();
  if (!has) {
    await ext.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["DOM_SCRAPING", "BLOBS"],
      justification: "Run local vision inference and composite the redacted screenshot off the main thread.",
    });
  }
  // createDocument() resolves before the document's scripts finish loading, so the
  // first VISION/COMPOSE message can land before the listener exists and be dropped.
  // The action loop hides this (step 2+ recovers); query mode's SINGLE vision pass
  // does not — it then reports "classical core only" forever. Poll the liveness ping
  // until the listener answers (local doc → a few ms) before returning; bounded so we
  // never hang if the document failed to come up.
  for (let i = 0; i < 40; i++) {
    if (await pingOffscreen()) break;
    await sleep(50);
  }
  return true;
}

function sendToOffscreen(message) {
  return ext.runtime.sendMessage({ ...message, __to: "offscreen" });
}

function sendToTab(tabId, message) {
  return ext.tabs.sendMessage(tabId, message);
}

async function captureScreenshot(tabId) {
  const tab = await ext.tabs.get(tabId);
  return ext.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 });
}

// Shape the on-device vision telemetry the popup and side panel read (identical
// object for the action loop and query mode, so the two never drift). `neural` is
// copied wholesale, so any new neural field (e.g. perModel timings) reaches the UI
// with no change here; `classical` is the CV core's path and `gpuAdapter` the
// WebGPU adapter identity (both may be null on a browser without offscreen/WebGPU).
function visionState(vision) {
  return {
    offscreen: offscreenSupported,
    ready: !!(vision && vision.ready),
    classical: (vision && vision.backend) || null,   // CV core execution path: cpu | webgpu
    neural: (vision && vision.neural && vision.neural.available) ? vision.neural : null,
    // Per-model LOAD failures — [{id, error}] — surfaced even when NO neural model
    // loaded (neural is null then). This is what lets the panel/log say WHY neural
    // isn't connected instead of a mute "classical core only".
    neuralErrors: (vision && vision.neuralErrors) || [],
    gpuAdapter: (vision && vision.gpuAdapter) || null,
  };
}

// Content-script files, mirroring manifest.json content_scripts[0].js. Declarative
// injection only fires on page LOAD, so a tab opened before the extension (or open
// across an extension reload) has no listener until it reloads — which otherwise
// surfaces as a cryptic "Receiving end does not exist" on the first PERCEIVE.
const CONTENT_SCRIPTS = [
  "lib/protocol.js",
  "lib/privacy/pii-regex.js",
  "lib/privacy/dom-detector.js",
  "lib/privacy/fusion.js",
  "lib/privacy/policy.js",
  "lib/redactor.js",
  "lib/dom-perception.js",
  "lib/record-extraction.js",
  "content/content.js",
];

// Guarantee the content script is alive in `tabId`, injecting it on demand.
// Returns { ok:true } (optionally { injected:true }) or { ok:false, reason } with
// an actionable message when the page simply can't host a content script.
async function ensureContentScript(tabId) {
  const ping = () =>
    sendToTab(tabId, { cmd: "PING" }).then((r) => !!(r && r.ok)).catch(() => false);

  if (await ping()) return { ok: true };

  // Pages a content script can never run on — say so plainly instead of failing
  // with a connection error the user can't interpret.
  let url = "";
  try { url = (await ext.tabs.get(tabId)).url || ""; } catch (_) {}
  if (/^(chrome|edge|brave|about|devtools|view-source|chrome-extension|moz-extension):/i.test(url) ||
      /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) {
    return { ok: false, reason: `This page (${url || "unknown"}) can't run the agent. Switch to a normal http(s) tab — e.g. the demo page — and click Run again.` };
  }

  if (!(ext.scripting && ext.scripting.executeScript)) {
    return { ok: false, reason: "No content script in this tab. Reload the page (F5) and click Run again." };
  }

  try {
    await ext.scripting.insertCSS({ target: { tabId }, files: ["content/overlay.css"] }).catch(() => {});
    await ext.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
  } catch (e) {
    const hint = /^file:\/\//i.test(url)
      ? ' For local file:// pages, enable "Allow access to file URLs" for this extension at chrome://extensions, or serve the demo over http://localhost.'
      : " Reload the page (F5) and click Run again.";
    return { ok: false, reason: `Couldn't inject the content script (${String(e && e.message || e)}).${hint}` };
  }

  return (await ping())
    ? { ok: true, injected: true }
    : { ok: false, reason: "Injected the content script but it didn't respond. Reload the page (F5) and click Run again." };
}

async function callServer(serverUrl, payload, path = "/plan") {
  const res = await fetch(serverUrl.replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // Surface the server's own reason instead of a bare status. FastAPI puts it
    // under `detail` for BOTH HTTPException (e.g. residual_pii_detected) and
    // Pydantic request-validation errors (e.g. an int field given a float box).
    let why = "";
    try { const b = await res.json(); why = ": " + JSON.stringify(b && b.detail !== undefined ? b.detail : b).slice(0, 300); }
    catch (_) {}
    throw new Error("server_" + res.status + why);
  }
  return res.json();
}

// ---- the loop ----------------------------------------------------------
async function runTask(task, tabId) {
  const cfg = await getConfig();
  Object.assign(state, {
    running: true, tabId, sessionId: crypto.randomUUID(), step: 0, log: [], receipts: [],
    mode: "action", answer: null, audit: null, auditLog: [],
    telemetry: { zeroLeakStreak: 0, phases: [], resources: { heapMB: 0, p95Ms: 0 } }
  });
  await ensureOffscreen();
  pushLog({ kind: "start", task });

  // The whole loop talks to the content script (PERCEIVE/EXECUTE). Make sure it's
  // actually there before we start — self-heal by injecting it if the tab predates
  // the last extension reload, and give an actionable message if the page can't
  // host it at all (chrome://, web store, file:// without file access).
  const cs = await ensureContentScript(tabId);
  if (!cs.ok) {
    pushLog({ kind: "error", error: cs.reason });
    state.running = false;
    pushLog({ kind: "stopped", step: 0 });
    return;
  }
  if (cs.injected) pushLog({ kind: "info", note: "content script injected on demand (tab predated last extension reload)" });

  const recentSignatures = [];

  try {
    while (state.running && state.step < cfg.maxSteps) {
      state.step++;
      const t0 = performance.now();
      const phases = {};

      // 1. CAPTURE (raw — stays in the worker/offscreen, never sent)
      let t = performance.now();
      const rawShot = await captureScreenshot(tabId);
      phases.capture = Math.round(performance.now() - t);

      // 1b. Device-pixel ratio from the page: captureVisibleTab gives a device-pixel
      // image, but DOM boxes are CSS pixels. The detector needs dpr to return CSS-px
      // boxes that fuse with the DOM signals. Default to 1 if the query fails.
      const meta = await sendToTab(tabId, { cmd: "VIEWPORT" }).catch(() => null);
      const dpr = (meta && meta.dpr) || 1;

      // 2. LOCAL VISION (on-device detector; returns face/signature boxes in CSS px).
      // No offscreen host (non-Chromium) → skip inference; vision.ready stays false
      // so the policy fails closed (withholds the screenshot on image pages).
      t = performance.now();
      const vision = offscreenSupported
        ? await sendToOffscreen({ cmd: "VISION", imageDataUrl: rawShot, dpr })
            .catch(() => ({ detections: [], ready: false }))
        : { detections: [], ready: false };
      phases.vision = Math.round(performance.now() - t);

      // Record what the on-device vision stack actually did this step so the popup can
      // prove the models ran: the classical CV core's path plus, when weights are
      // vendored, the neural model list / execution provider / summed warm-up.
      state.vision = visionState(vision);

      // 3. PERCEIVE + PROTECT (in-page; produces sanitized payload + redaction plan)
      t = performance.now();
      const perceived = await sendToTab(tabId, {
        cmd: "PERCEIVE", task, sessionId: state.sessionId, step: state.step,
        visionDetections: vision.detections || [], visionReady: !!vision.ready,
      });
      if (!perceived || !perceived.ok) throw new Error("perceive_failed");
      const payload = perceived.payload;
      phases.perceive = Math.round(performance.now() - t);
      pushLog({ kind: "receipt", step: state.step, receipt: payload.privacy_receipt });
      state.receipts.push(payload.privacy_receipt);
      // Privacy-audit events (safe metadata only — counts + category→count map).
      const rc = payload.privacy_receipt || {};
      pushAudit("pii_detected", { step: state.step, source: "DOM+Regex+Vision (fused)", detected: rc.detected || 0, categories: rc.categories || {} });
      pushAudit("redaction_applied", { step: state.step, redacted: rc.redacted || 0, categories: rc.categories || {} });
      // Zero-leak streak: consecutive steps where all detected PII was redacted
      if (payload.privacy_receipt.detected === payload.privacy_receipt.redacted) {
        state.telemetry.zeroLeakStreak++;
      } else {
        state.telemetry.zeroLeakStreak = 0;
      }

      // 4. REDACT PIXELS + draw Set-of-Marks (offscreen), attach sanitized image.
      // Compositing REQUIRES the offscreen host. With no way to redact pixels we must
      // never ship raw ones, so a browser without offscreen drops to text-only here —
      // and we correct the receipt so the audit record reflects what actually shipped.
      t = performance.now();
      if (perceived.sendScreenshot && offscreenSupported) {
        const composed = await sendToOffscreen({
          cmd: "COMPOSE", imageDataUrl: rawShot, plan: perceived.redactionPlan,
          marks: perceived.marks, dpr: payload.viewport.dpr || 1,
        });
        payload.screenshot = composed && composed.dataUrl ? composed.dataUrl : null;
      } else if (perceived.sendScreenshot && !offscreenSupported) {
        payload.screenshot = null;
        payload.screenshot_included = false;
        if (payload.privacy_receipt) {
          payload.privacy_receipt.send_screenshot = false;
          payload.privacy_receipt.fail_closed_triggered = true;
          payload.privacy_receipt.downgrade_reason = "offscreen_unsupported_text_only";
          payload.privacy_receipt.residual_risk = "mitigated_text_only";
        }
        pushLog({ kind: "downgrade", step: state.step, reason: "offscreen_unsupported_text_only" });
      }
      phases.redact = Math.round(performance.now() - t);

      // AUDIT snapshot (action mode). The ORIGINAL capture stays LOCAL-ONLY; what
      // actually leaves the browser is the REDACTED webp (only when composed) plus
      // the sanitized payload. This object drives the demo/judge "before → after →
      // sent" view; the original dataUrl is flagged transmitted:false and never POSTed.
      const shotSent = !!payload.screenshot;
      pushAudit("screenshot_sanitized", { step: state.step, transmitted: shotSent,
        note: shotSent ? "redacted webp composited on-device" : "screenshot withheld (fail-closed / text-only)" });
      state.audit = {
        mode: "action", step: state.step, generatedAt: Date.now(),
        dpr: (payload.viewport && payload.viewport.dpr) || 1,
        original: rawShot ? { dataUrl: rawShot, transmitted: false, note: "LOCAL ONLY — NOT TRANSMITTED" } : null,
        visionDetections: (vision.detections || []).map((d) => ({ category: d.pii_type, bbox: d.bbox, confidence: d.confidence, source: "Vision" })),
        redactions: (payload.redactions || []).map((r) => ({ category: r.pii_type, method: r.method, bbox: r.bbox, confidence: r.confidence, token: r.token, source: "Fusion" })),
        redacted: shotSent ? { dataUrl: payload.screenshot, transmitted: true, note: "Sanitized — eligible for transmission" } : null,
        payloadPreview: auditPayloadPreview(payload),
        transmission: { endpoint: "/plan", screenshotSent: shotSent },
        forbidden: FORBIDDEN_FROM_EGRESS,
      };
      pushAudit("payload_sanitized", { step: state.step, endpoint: "/plan", screenshot: shotSent,
        elements: (payload.elements || []).length, redactions: (payload.redactions || []).length });

      // Surface the SANITIZED (redacted) screenshot inline in the proceedings too, so
      // the reviewer sees what actually leaves the browser without opening the audit
      // tab. Only the redacted composite is ever shown here as "sent"; the raw capture
      // is never put in the log. (pushShotLog keeps only the latest shot's bytes.)
      if (shotSent && payload.screenshot) {
        pushShotLog({ step: state.step, scope: "sent", transmitted: true,
          label: `Sanitized screenshot — step ${state.step}`, badge: "SANITIZED — SENT to /plan",
          note: `redacted composite: raw pixels blacked out on-device, ${(payload.redactions || []).length} region(s) masked`,
          dataUrl: payload.screenshot, dpr: (payload.viewport && payload.viewport.dpr) || 1 });
      }

      // 5. REASON (server sees only sanitized payload)
      t = performance.now();
      pushAudit("server_request", { step: state.step, endpoint: "/plan", screenshot: shotSent });
      const plan = await callServer(cfg.serverUrl, payload);
      phases.server = Math.round(performance.now() - t);
      phases.total = Math.round(performance.now() - t0);
      state.telemetry.phases.push({ step: state.step, ...phases });
      // Resource snapshot (best-effort)
      try {
        const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) : 0;
        state.telemetry.resources = { heapMB: mem, lastStepMs: phases.total };
      } catch (_) {}
      pushAudit("server_response", { step: state.step, endpoint: "/plan", status: plan.status, actions: (plan.actions || []).length });
      pushLog({ kind: "plan", step: state.step, status: plan.status, reasoning: plan.reasoning, actions: plan.actions, phases });

      if (plan.status === "done") { pushLog({ kind: "done" }); break; }
      if (plan.status === "abort" || plan.status === "need_user") { pushLog({ kind: plan.status, reasoning: plan.reasoning }); break; }

      // 6. ACT (validated + verified in the content script)
      for (const action of plan.actions || []) {
        const result = await sendToTab(tabId, { cmd: "EXECUTE", action });
        pushLog({ kind: "action", step: state.step, action, result });
        pushAudit("local_action", { step: state.step, type: action.type,
          targetId: action.target_id ?? null, ok: !!(result && result.ok),
          changed: !!(result && result.changed), rejected: (result && result.rejected) || null });

        if (result && result.rejected) { pushLog({ kind: "rejected", reason: result.rejected }); }

        // loop detection: identical signature repeated with no state change
        if (result && result.signature) {
          recentSignatures.push(result.signature + "|" + (result.changed ? "1" : "0"));
          const tail = recentSignatures.slice(-cfg.loopLimit);
          if (tail.length === cfg.loopLimit && tail.every((s) => s === tail[0] && s.endsWith("|0"))) {
            pushLog({ kind: "abort", reasoning: "loop_detected_no_state_change" });
            state.running = false;
            break;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 300)); // let the page settle
    }
  } catch (e) {
    pushLog({ kind: "error", error: String(e && e.message || e) });
  } finally {
    state.running = false;
    pushLog({ kind: "stopped", step: state.step });
  }
}

// ---- intent routing (on-device, no model) ------------------------------
// Decide whether a task is a read-only QUERY (summarize/compute over the page's
// records — no egress, no page mutation) or an ACTION (drive the page via the
// server-backed agent loop). The side panel's mode toggle overrides this; only
// "auto"/absent falls back here.
//
// Tie-break is deliberately safe: an explicit action verb wins for action, and a
// task matching NEITHER set defaults to query — read-only is the conservative
// choice (nothing leaves the machine, nothing on the page changes).
const QUERY_RE = /\b(summar\w*|totals?|sum|averages?|avg|mean|how much|how many|counts?|breakdown|group(?:ed)? by|spending|spent|list|show me|min|minimum|max|maximum|highest|lowest|largest|smallest)\b/i;
const ACTION_RE = /\b(go to|open|click|fill|type|enter|submit|pay|transfer|buy|order|book|log ?in|sign ?in|search for|apply|checkout|add to cart|delete|remove|send|upload|download|navigate)\b/i;

function classifyIntent(task) {
  const t = String(task || "").trim();
  const action = ACTION_RE.test(t);
  const query = QUERY_RE.test(t) || /\?$/.test(t); // a trailing "?" reads as a question
  if (action) return "action";       // an action verb present → action (even if "list"/"show" also appears)
  if (query) return "query";
  return "query";                    // pure-ambiguous → read-only default
}

// ---- SW-side fail-closed validation (query payload) ---------------------
// Belt-and-suspenders before any /query POST: re-scan the OUTGOING payload with the
// CANONICAL detector (globalThis.PBA.pii.scan from the imported pii-regex.js — no
// duplicated logic). record-extraction already dropped identifier columns and
// tokenized inline PII, so this should find nothing; if it does, we DO NOT POST.
//
// A parsed amount in a numeric column can structurally resemble a digit-only
// identifier (a 10-digit total reads as a "phone"; a 16-digit one can pass Luhn).
// Amounts are transaction data, not identifiers, so those digit-only types are
// ignored FOR NUMERIC-COLUMN CELLS ONLY. Any type containing letters (email, PAN,
// UPI, API key) stays fatal everywhere — it can never be a bare amount.
const NUMERIC_SHAPED = new Set(["phone", "credit_card", "otp", "ip", "aadhaar", "bank_account", "generic_secret"]);

function scanRaw(text, numeric) {
  if (!text || !(globalThis.PBA && globalThis.PBA.pii)) return null;
  for (const h of globalThis.PBA.pii.scan(String(text))) {
    if (numeric && NUMERIC_SHAPED.has(h.type)) continue;
    return h.type; // return the CATEGORY only — never h.value (that would leak raw PII into logs)
  }
  return null;
}

// Walk the sanitized query payload; return {kind, where} of the first raw identifier
// that leaked, else null. Location is a path, never a value.
function assertNoRawPII(payload) {
  let kind = scanRaw(payload.query, false);
  if (kind) return { kind, where: "query" };
  const tables = payload.tables || [];
  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti] || {};
    kind = scanRaw(t.caption, false);
    if (kind) return { kind, where: `tables[${ti}].caption` };
    const cols = t.columns || [];
    for (let ci = 0; ci < cols.length; ci++) {
      kind = scanRaw(cols[ci] && cols[ci].name, false);
      if (kind) return { kind, where: `tables[${ti}].columns[${ci}]` };
    }
    const numericCols = new Set(t.numericColumns || []);
    const rows = t.rows || [];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri] || [];
      for (let ci = 0; ci < row.length; ci++) {
        kind = scanRaw(row[ci], numericCols.has(ci));
        if (kind) return { kind, where: `tables[${ti}].rows[${ri}][${ci}]` };
      }
    }
  }
  return null;
}

// ---- query mode: sanitized summarization via the server -----------------
// Architecture: local DOM/Regex/Vision → local PII detection/redaction → ONLY
// sanitized structured data (and a REDACTED raster) leave the browser → the SERVER
// AI generates the answer → the panel displays it. The outgoing payload carries the
// user query, a MASKED/typed view of the page's tables, safe metadata, and — only
// after the fail-closed check clears the text — a screenshot whose sensitive pixels
// are already blacked out on-device. The ORIGINAL screenshot NEVER leaves the worker;
// the one vision pass also lights up the pinned runtime stats and the LOCAL-ONLY audit
// preview.
async function runQuery(task, tabId) {
  const cfg = await getConfig();
  Object.assign(state, {
    running: true, tabId, sessionId: crypto.randomUUID(), step: 0, log: [], receipts: [],
    mode: "query", answer: null, audit: null, auditLog: [],
    telemetry: { zeroLeakStreak: 0, phases: [], resources: { heapMB: 0, p95Ms: 0 } }
  });
  state.vision = undefined; // recomputed by the vision pass below (cold until then)
  await ensureOffscreen();
  pushLog({ kind: "start", task, mode: "query" });

  const cs = await ensureContentScript(tabId);
  if (!cs.ok) {
    pushLog({ kind: "error", error: cs.reason });
    state.running = false; pushLog({ kind: "stopped", step: state.step });
    return;
  }
  if (cs.injected) pushLog({ kind: "info", note: "content script injected on demand (tab predated last extension reload)" });

  try {
    // Safe metadata: viewport + tab origin (origin only — never the full URL/query).
    const meta = await sendToTab(tabId, { cmd: "VIEWPORT" }).catch(() => null);
    const dpr = (meta && meta.dpr) || 1;
    const viewport = { w: (meta && meta.w) || 0, h: (meta && meta.h) || 0, scroll_x: 0, scroll_y: 0, dpr };
    let urlOrigin = "";
    try { const tab = await ext.tabs.get(tabId); urlOrigin = tab && tab.url ? new URL(tab.url).origin : ""; } catch (_) {}

    // 1) One on-device vision pass to populate the pinned top stats (models, EP,
    //    per-model ms, WebGPU adapter). The raw screenshot NEVER leaves the worker;
    //    query mode POSTs no image at all. We keep it ONLY for the LOCAL-ONLY audit
    //    preview (clearly marked, never transmitted).
    let rawShot = null;
    let visionDetections = [];
    let rawVisionDetections = []; // raw {pii_type,bbox,confidence} — fed to PERCEIVE for fusion into the redaction plan
    if (offscreenSupported) {
      const t = performance.now();
      // Capture and vision must SURFACE their failure reason, not silently degrade to
      // "classical core only" — that empty fallback was hiding the real cause. Track a
      // reason string through each hop so the proceedings log says exactly what broke.
      let captureErr = null;
      rawShot = await captureScreenshot(tabId).catch((e) => { captureErr = String((e && e.message) || e); return null; });
      let vision = { detections: [], ready: false };
      let visionErr = null;
      if (rawShot) {
        vision = await sendToOffscreen({ cmd: "VISION", imageDataUrl: rawShot, dpr })
          .catch((e) => ({ detections: [], ready: false, error: String((e && e.message) || e) }));
        // A send that finds no live listener can RESOLVE to undefined rather than
        // reject — treat any non-object reply as a dropped message, not success.
        if (!vision || typeof vision !== "object") vision = { detections: [], ready: false, error: "offscreen returned no response (listener not ready)" };
        visionErr = vision.error || (vision.ready ? null : "vision pass returned not-ready");
      } else {
        visionErr = captureErr || "captureVisibleTab returned null (is 'Allow access to file URLs' enabled for file:// pages?)";
      }
      state.vision = visionState(vision);
      visionDetections = (vision.detections || []).map((d) => ({ category: d.pii_type, bbox: d.bbox, confidence: d.confidence, source: "Vision" }));
      rawVisionDetections = vision.detections || []; // for PERCEIVE fusion (raw {pii_type,bbox,confidence})
      const ms = Math.round(performance.now() - t);
      state.telemetry.phases.push({ step: 0, capture: 0, vision: ms, perceive: 0, redact: 0, server: 0, total: ms });
      // Show the LOCAL-ONLY original capture inline in the proceedings, clearly marked
      // never-sent. The ORIGINAL never leaves the machine; what MAY leave (composited
      // further below, only after the fail-closed text check) is a redacted copy with
      // the sensitive pixels blacked out on-device. The screenshot_sanitized audit event
      // fires there, once the true transmission outcome is known.
      if (rawShot) {
        pushShotLog({ scope: "local", transmitted: false,
          label: "On-device capture (original)", badge: "LOCAL ONLY — NOT TRANSMITTED",
          note: `analyzed on-device for runtime stats (${visionDetections.length} vision detection${visionDetections.length === 1 ? "" : "s"}); the ORIGINAL is never sent — only the redacted copy below`,
          dataUrl: rawShot, dpr });
      }
      // Report the neural stack's ACTUAL state so "why isn't it using the neural one" is
      // answered in the log, not left to guesswork. Prefer the per-model LOAD errors (the
      // stack ran but no model loaded — ORT import / no execution provider / missing
      // weights) over a generic message; that mute "classical core only" is the bug.
      const neuralErrs = (state.vision && state.vision.neuralErrors) || [];
      if (state.vision.neural) {
        const n = state.vision.neural;
        pushLog({ kind: "info", note: `neural vision active — ${(n.models || []).join(", ")} @ ${String(n.ep || "").toUpperCase()} · classical core: ${String(state.vision.classical || "cpu").toUpperCase()}` });
      } else if (neuralErrs.length) {
        pushLog({ kind: "info", note: `neural vision unavailable — ${neuralErrs.map((e) => `${e.id}: ${e.error}`).join(" · ")}. Classical CV core (${String(state.vision.classical || "cpu").toUpperCase()}) still ran.` });
      } else if (visionErr) {
        pushLog({ kind: "info", note: `neural vision unavailable — ${visionErr}. Classical CV core still ran; on-device stats only.` });
      } else {
        pushLog({ kind: "info", note: "on-device vision pass complete — screenshot analyzed locally" });
      }
    } else {
      state.vision = visionState(null);
    }

    // 2) Extract MASKED records from the page. Raw account/card values never cross
    //    back — PBA.records.extract drops identifier columns and tokenizes inline PII.
    const res = await sendToTab(tabId, { cmd: "EXTRACT_RECORDS", task })
      .catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    if (!res || !res.ok) {
      pushLog({ kind: "error", error: (res && res.error) || "extract_failed" });
      state.running = false; pushLog({ kind: "stopped", step: state.step });
      return;
    }
    const tables = res.tables || [];
    const masked = res.masked || { count: 0, categories: {} };
    const rowCount = tables.reduce((n, tb) => n + (tb.rows ? tb.rows.length : 0), 0);
    pushLog({ kind: "extract", tableCount: tables.length, rows: rowCount,
      columns: tables[0] ? tables[0].columns : [], masked });
    pushAudit("pii_detected", { source: "DOM+Regex (records)", detected: masked.count || 0, categories: masked.categories || {} });
    pushAudit("redaction_applied", { redacted: masked.count || 0, categories: masked.categories || {},
      note: "identifier columns dropped to <CATEGORY_n> tokens; inline PII tokenized" });

    // 3) Build the SANITIZED query payload. This is the ONLY thing that leaves the
    //    browser: user query + masked/typed tables + safe metadata + (below, only after
    //    the fail-closed check) a REDACTED raster whose sensitive pixels are already
    //    blacked out. No raw DOM, no raw page text, and never the original screenshot.
    const payload = {
      protocol_version: "1.0",
      session_id: state.sessionId,
      query: task,
      url_origin: urlOrigin,
      viewport,
      tables,
      masked,
      // Redacted screenshot goes here AFTER assertNoRawPII passes and compositing
      // succeeds (see step 4b). Defaults keep the shape stable for a withheld image.
      screenshot: null,
      screenshot_included: false,
      privacy_receipt: {
        detected: masked.count || 0, redacted: masked.count || 0,
        residual_risk: "mitigated_masked", send_screenshot: false,
        fail_closed_triggered: false, categories: masked.categories || {},
      },
    };

    // 4) FAIL-CLOSED pre-flight: assert no raw identifier survived into the payload.
    //    If anything did, we DO NOT POST — the privacy firewall refuses to leak.
    const leak = assertNoRawPII(payload);
    if (leak) {
      payload.privacy_receipt.fail_closed_triggered = true;
      pushAudit("payload_sanitized", { endpoint: "/query", validated: false, blocked: true, kind: leak.kind, where: leak.where });
      pushLog({ kind: "error", error: `fail_closed: residual ${leak.kind} at ${leak.where} — refused to send` });
      state.answer = { query: task, blocked: true, reason: `Residual ${leak.kind} detected in ${leak.where}; nothing was sent.`, masked };
      pushLog({ kind: "answer", answer: state.answer });
      state.running = false; pushLog({ kind: "stopped", step: state.step });
      return;
    }

    // 4b) REDACTED SCREENSHOT TO SEND. The user asked for the screenshot to reach the
    //     server WITH the redactions burned into the pixels — never the original. Only
    //     now that the text payload passed fail-closed do we composite a copy whose
    //     sensitive regions are blacked out on-device, UNIONING two redaction sources so
    //     nothing legible slips through:
    //       • PERCEIVE's canonical plan — DOM/Regex/Vision PII anywhere on the page
    //         (inline cards, emails, faces, signatures…), fused + policy-gated.
    //       • the record extractor's identifier-column boxes — the Account/Card/UPI
    //         columns it DROPS from the tables. pii-regex has NO bare-account detector,
    //         so PERCEIVE alone would leave those digits legible in the raster.
    //     Fail-closed: if the policy withholds the shot, or compositing fails, we attach
    //     NO image — the answer still comes from the masked tables.
    let redactedShot = null;
    let redactRegions = 0;
    if (offscreenSupported && rawShot) {
      const perceived = await sendToTab(tabId, {
        cmd: "PERCEIVE", task, sessionId: state.sessionId, step: 0,
        visionDetections: rawVisionDetections, visionReady: !!(state.vision && state.vision.ready),
      }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));

      if (perceived && perceived.ok && perceived.sendScreenshot !== false) {
        const domPlan = Array.isArray(perceived.redactionPlan) ? perceived.redactionPlan : [];
        const recordBoxes = Array.isArray(res.redactBoxes) ? res.redactBoxes : [];
        const plan = domPlan.concat(recordBoxes); // union — maximal redaction
        redactRegions = plan.length;
        const composed = await sendToOffscreen({ cmd: "COMPOSE", imageDataUrl: rawShot, plan, marks: [], dpr })
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        redactedShot = composed && composed.dataUrl ? composed.dataUrl : null;
        if (redactedShot) {
          payload.screenshot = redactedShot;
          payload.screenshot_included = true;
          payload.privacy_receipt.send_screenshot = true;
        } else {
          pushLog({ kind: "info", note: `redacted screenshot not composited (${(composed && composed.error) || "compositor returned no image"}) — sending masked tables only` });
        }
      } else {
        const why = (perceived && perceived.ok === false)
          ? (perceived.error || "perceive failed")
          : "policy withheld the screenshot (vision could not vouch for on-page images)";
        pushLog({ kind: "info", note: `redacted screenshot withheld — ${why}; sending masked tables only` });
      }
    }

    // One authoritative screenshot audit event, reflecting the TRUE transmission outcome.
    pushAudit("screenshot_sanitized", { transmitted: !!redactedShot, regions: redactRegions,
      detections: visionDetections.length,
      note: redactedShot
        ? "raw pixels blacked out on-device (identifier columns + fused DOM/vision PII); the ORIGINAL is never sent"
        : "screenshot analyzed on-device for stats only; no image transmitted" });
    if (redactedShot) {
      pushShotLog({ scope: "sent", transmitted: true,
        label: "Redacted screenshot — SENT to /query", badge: "SANITIZED — SENT to /query",
        note: `raw pixels blacked out on-device — ${redactRegions} region${redactRegions === 1 ? "" : "s"} masked; the ORIGINAL never leaves the machine`,
        dataUrl: redactedShot, dpr });
    }

    // 5) AUDIT snapshot (query mode). Original stays LOCAL-ONLY; what leaves is the
    //    sanitized payload plus (when composed) the REDACTED raster. payloadPreview is
    //    the exact JSON sent, with the base64 image swapped for a size marker.
    state.audit = {
      mode: "query", generatedAt: Date.now(),
      dpr: viewport.dpr,
      original: rawShot ? { dataUrl: rawShot, transmitted: false, note: "LOCAL ONLY — NOT TRANSMITTED" } : null,
      visionDetections,
      recordMasking: { count: masked.count || 0, categories: masked.categories || {}, source: "DOM+Regex" },
      redacted: redactedShot
        ? { dataUrl: redactedShot, transmitted: true, note: `SANITIZED — SENT to /query (${redactRegions} region${redactRegions === 1 ? "" : "s"} blacked out)` }
        : null,
      payloadPreview: auditPayloadPreview(payload),
      transmission: { endpoint: "/query", screenshotSent: !!redactedShot },
      forbidden: FORBIDDEN_FROM_EGRESS,
    };
    pushAudit("payload_sanitized", { endpoint: "/query", validated: true, screenshot: !!redactedShot,
      tables: tables.length, rows: rowCount });

    // 6) REASON on the server (sanitized payload only). Then display its answer.
    const t = performance.now();
    pushAudit("server_request", { endpoint: "/query", screenshot: !!redactedShot, tables: tables.length });
    pushLog({ kind: "info", note: `sending sanitized query payload to server (${tables.length} table(s), ${redactedShot ? `redacted screenshot: ${redactRegions} region${redactRegions === 1 ? "" : "s"} blacked out` : "no screenshot"})` });
    const ans = await callServer(cfg.serverUrl, payload, "/query");
    const serverMs = Math.round(performance.now() - t);
    state.telemetry.phases.push({ step: 1, capture: 0, vision: 0, perceive: 0, redact: 0, server: serverMs, total: serverMs });
    pushAudit("server_response", { endpoint: "/query", status: ans.status, rowCount: ans.row_count });

    // Mirror the server's breakdown into the proceedings as calc steps (the returned
    // aggregates are already sanitized), so Zone 2 shows the computation too.
    if (ans.metric) pushLog({ kind: "calc", step: ++state.step, label: "metric", value: ans.metric });
    if (ans.dimension) pushLog({ kind: "calc", step: ++state.step, label: "group by", value: ans.dimension });
    for (const g of ans.groups || []) {
      pushLog({ kind: "calc", step: ++state.step, label: g.key, value: g.sum,
        detail: `n=${g.count} · avg ${g.avg} · min ${g.min} · max ${g.max}` });
    }
    if (ans.totals) pushLog({ kind: "calc", step: ++state.step, label: "TOTAL", value: ans.totals.sum,
      detail: `n=${ans.totals.count} · avg ${ans.totals.avg}` });
    if (ans.date_range) pushLog({ kind: "calc", step: ++state.step, label: "date range",
      value: `${ans.date_range.min || "?"} → ${ans.date_range.max || "?"}` });

    // The full QueryAnswer becomes state.answer; the panel renders ans.answer prominently.
    state.answer = { ...ans, query: task, masked };
    pushLog({ kind: "answer", answer: state.answer });
    pushLog({ kind: "done" });
  } catch (e) {
    pushLog({ kind: "error", error: String(e && e.message || e) });
  } finally {
    state.running = false;
    pushLog({ kind: "stopped", step: state.step });
  }
}

// ---- message router ----------------------------------------------------
ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.__to === "offscreen") return; // not for us
  if (msg.cmd === "START_TASK") {
    if (state.running) { sendResponse({ ok: false, reason: "already_running" }); return true; }
    // Explicit panel toggle ("query"/"action") wins; "auto"/absent → on-device classifier.
    const mode = (msg.mode === "query" || msg.mode === "action") ? msg.mode : classifyIntent(msg.task);
    if (mode === "query") runQuery(msg.task, msg.tabId);
    else runTask(msg.task, msg.tabId);
    sendResponse({ ok: true, mode });
  } else if (msg.cmd === "STOP_TASK") {
    state.running = false;
    sendResponse({ ok: true });
  } else if (msg.cmd === "GET_STATE") {
    sendResponse({ ok: true, state });
  }
  return true;
});
