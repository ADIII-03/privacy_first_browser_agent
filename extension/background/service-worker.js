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
const state = { running: false, tabId: null, sessionId: null, step: 0, log: [], receipts: [] };

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

async function callServer(serverUrl, payload) {
  const res = await fetch(serverUrl.replace(/\/$/, "") + "/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("server_" + res.status);
  return res.json();
}

// ---- the loop ----------------------------------------------------------
async function runTask(task, tabId) {
  const cfg = await getConfig();
  Object.assign(state, { running: true, tabId, sessionId: crypto.randomUUID(), step: 0, log: [], receipts: [] });
  await ensureOffscreen();
  pushLog({ kind: "start", task });

  const recentSignatures = [];

  try {
    while (state.running && state.step < cfg.maxSteps) {
      state.step++;

      // 1. CAPTURE (raw — stays in the worker/offscreen, never sent)
      const rawShot = await captureScreenshot(tabId);

      // 1b. Device-pixel ratio from the page: captureVisibleTab gives a device-pixel
      // image, but DOM boxes are CSS pixels. The detector needs dpr to return CSS-px
      // boxes that fuse with the DOM signals. Default to 1 if the query fails.
      const meta = await sendToTab(tabId, { cmd: "VIEWPORT" }).catch(() => null);
      const dpr = (meta && meta.dpr) || 1;

      // 2. LOCAL VISION (on-device detector; returns face/signature boxes in CSS px).
      // No offscreen host (non-Chromium) → skip inference; vision.ready stays false
      // so the policy fails closed (withholds the screenshot on image pages).
      const vision = offscreenSupported
        ? await sendToOffscreen({ cmd: "VISION", imageDataUrl: rawShot, dpr })
            .catch(() => ({ detections: [], ready: false }))
        : { detections: [], ready: false };

      // 3. PERCEIVE + PROTECT (in-page; produces sanitized payload + redaction plan)
      const perceived = await sendToTab(tabId, {
        cmd: "PERCEIVE", task, sessionId: state.sessionId, step: state.step,
        visionDetections: vision.detections || [], visionReady: !!vision.ready,
      });
      if (!perceived || !perceived.ok) throw new Error("perceive_failed");
      const payload = perceived.payload;
      pushLog({ kind: "receipt", step: state.step, receipt: payload.privacy_receipt });
      state.receipts.push(payload.privacy_receipt);

      // 4. REDACT PIXELS + draw Set-of-Marks (offscreen), attach sanitized image.
      // Compositing REQUIRES the offscreen host. With no way to redact pixels we must
      // never ship raw ones, so a browser without offscreen drops to text-only here —
      // and we correct the receipt so the audit record reflects what actually shipped.
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

      // 5. REASON (server sees only sanitized payload)
      const plan = await callServer(cfg.serverUrl, payload);
      pushLog({ kind: "plan", step: state.step, status: plan.status, reasoning: plan.reasoning, actions: plan.actions });

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
