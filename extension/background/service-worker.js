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
const state = {
  running: false, tabId: null, sessionId: null, step: 0, log: [], receipts: [],
  telemetry: { zeroLeakStreak: 0, phases: [], resources: { heapMB: 0, p95Ms: 0 } }
};

// Cross-browser shim: Firefox exposes the WebExtension API as `browser`, Chromium
// as `chrome`. Everything below goes through `ext` so the same code runs on both
// (see README "Browser support" for the Firefox offscreen caveat).
const ext = globalThis.browser || globalThis.chrome;

async function getConfig() {
  const c = await ext.storage.local.get(["serverUrl", "maxSteps", "loopLimit"]);
  return { ...DEFAULTS, ...c };
}

function pushLog(entry) {
  state.log.push({ t: Date.now(), ...entry });
  ext.runtime.sendMessage({ cmd: "STATE", state }).catch(() => {});
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

async function ensureOffscreen() {
  if (!offscreenSupported) return false;
  const has = await ext.offscreen.hasDocument?.();
  if (has) return true;
  await ext.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["DOM_SCRAPING", "BLOBS"],
    justification: "Run local vision inference and composite the redacted screenshot off the main thread.",
  });
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

async function callServer(serverUrl, payload) {
  const res = await fetch(serverUrl.replace(/\/$/, "") + "/plan", {
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

      // 5. REASON (server sees only sanitized payload)
      t = performance.now();
      const plan = await callServer(cfg.serverUrl, payload);
      phases.server = Math.round(performance.now() - t);
      phases.total = Math.round(performance.now() - t0);
      state.telemetry.phases.push({ step: state.step, ...phases });
      // Resource snapshot (best-effort)
      try {
        const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) : 0;
        state.telemetry.resources = { heapMB: mem, lastStepMs: phases.total };
      } catch (_) {}
      pushLog({ kind: "plan", step: state.step, status: plan.status, reasoning: plan.reasoning, actions: plan.actions, phases });

      if (plan.status === "done") { pushLog({ kind: "done" }); break; }
      if (plan.status === "abort" || plan.status === "need_user") { pushLog({ kind: plan.status, reasoning: plan.reasoning }); break; }

      // 6. ACT (validated + verified in the content script)
      for (const action of plan.actions || []) {
        const result = await sendToTab(tabId, { cmd: "EXECUTE", action });
        pushLog({ kind: "action", step: state.step, action, result });

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

// ---- message router ----------------------------------------------------
ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.__to === "offscreen") return; // not for us
  if (msg.cmd === "START_TASK") {
    if (state.running) { sendResponse({ ok: false, reason: "already_running" }); return true; }
    runTask(msg.task, msg.tabId);
    sendResponse({ ok: true });
  } else if (msg.cmd === "STOP_TASK") {
    state.running = false;
    sendResponse({ ok: true });
  } else if (msg.cmd === "GET_STATE") {
    sendResponse({ ok: true, state });
  }
  return true;
});
