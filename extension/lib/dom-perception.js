/*
 * dom-perception.js — Assembles the sanitized context from all local signals.
 *
 * This is the "PROTECT + package" stage. It never emits a raw value: element
 * labels are tokenized, field values are reduced to a value_state enum, and the
 * redaction plan (pixel boxes) is produced for the offscreen compositor.
 *
 * Output is exactly the v1 protocol object that server/schemas.py validates.
 */
(function () {
  const PBA = (self.PBA = self.PBA || {});

  function countImages() {
    return document.images ? document.images.length : 0;
  }

  /**
   * @param {object} args { task, sessionId, step, visionDetections[], visionReady }
   * @returns {object} { payload, redactionPlan, marks, receipt }
   */
  function buildContext(args) {
    const { elements, textNodes, fieldPII } = PBA.dom.scanDOM();

    // Fuse DOM + regex(text) + vision into a redaction map, then apply policy.
    const redactionMap = PBA.fusion.fuse({
      fieldPII,
      textNodes,
      visionDetections: args.visionDetections || [],
    });
    const { plan, sendScreenshot, receipt } = PBA.policy.decide(redactionMap, {
      visionReady: !!args.visionReady,
      imageCount: countImages(),
    });

    // Tokenize element labels so no raw PII rides along in the structured payload.
    const counters = {};
    const safeElements = elements.map((e) => ({
      id: e.id,
      role: e.role,
      label: PBA.redactor.tokenizeText(e.label, counters),
      bbox: e.bbox,
      enabled: e.enabled,
      value_state: e.sensitive && e.value_state === PBA.VALUE_STATE.FILLED
        ? PBA.VALUE_STATE.REDACTED : e.value_state,
      sensitive: e.sensitive,
      pii_type: e.pii_type,
      // client-side destructive-intent flag; the client enforces confirmation regardless
      destructive: PBA.DESTRUCTIVE_HINTS.some((h) => (e.label || "").toLowerCase().includes(h)),
    }));

    const marks = safeElements.map((e) => ({ id: e.id, bbox: e.bbox, sensitive: e.sensitive }));

    const payload = {
      protocol_version: PBA.PROTOCOL_VERSION,
      session_id: args.sessionId,
      step: args.step,
      task: args.task,
      // origin only — never full URL (path/query can carry tokens & PII)
      url_origin: location.origin,
      viewport: {
        w: innerWidth, h: innerHeight,
        scroll_x: Math.round(scrollX), scroll_y: Math.round(scrollY),
        dpr: devicePixelRatio || 1,
      },
      // screenshot is attached later by the offscreen compositor (or omitted if
      // policy downgraded to text-only). Placeholder here keeps the shape stable.
      screenshot: null,
      screenshot_included: sendScreenshot,
      elements: safeElements,
      // redactions carry ONLY category + token + box, never a value.
      redactions: plan.map((p) => ({ pii_type: p.pii_type, token: p.token, method: p.method, bbox: p.bbox, confidence: p.confidence })),
      privacy_receipt: receipt,
    };

    return { payload, redactionPlan: plan, marks, sendScreenshot };
  }

  PBA.perception = { buildContext };
})();
