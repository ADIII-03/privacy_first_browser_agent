/*
 * offscreen.js — handles VISION (local model) and COMPOSE (redaction) requests
 * from the background worker.
 */
const PBA = self.PBA;
// Cross-browser shim (Firefox `browser` / Chromium `chrome`).
const ext = globalThis.browser || globalThis.chrome;

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.__to !== "offscreen") return; // only handle messages addressed to us
  // Liveness handshake. chrome.offscreen.createDocument() resolves once the document
  // EXISTS, but this page's <script>s — which register the very listener you're reading —
  // may not have executed yet. A VISION/COMPOSE message sent into that gap is dropped.
  // The action loop hides it (step 2+ recovers), but query mode's SINGLE vision pass
  // then shows "classical core only" forever. The worker polls this ping after
  // createDocument() and only sends real work once it answers. Answer synchronously.
  if (msg.cmd === "OFFSCREEN_PING") {
    sendResponse({
      ok: true, ready: true,
      vision: !!(PBA && PBA.vision),
      neural: !!(PBA && PBA.visionNeural && PBA.visionNeural.available),
    });
    return; // sync response — don't keep the channel open
  }
  (async () => {
    try {
      if (msg.cmd === "VISION") {
        // dpr lets the detector return CSS-pixel boxes that line up with the DOM
        // signals (captureVisibleTab yields a device-pixel image).
        const out = await PBA.vision.detect(msg.imageDataUrl, { dpr: msg.dpr || 1 });
        sendResponse(out); // { detections:[], ready:bool, backend }
      } else if (msg.cmd === "COMPOSE") {
        const dataUrl = await PBA.redactor.compose({
          imageDataUrl: msg.imageDataUrl,
          plan: msg.plan,
          marks: msg.marks,
          dpr: msg.dpr,
          quality: 0.7,
        });
        sendResponse({ ok: true, dataUrl });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e), detections: [], ready: false });
    }
  })();
  return true;
});
