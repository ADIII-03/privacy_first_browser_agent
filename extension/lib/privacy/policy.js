/*
 * policy.js — Fail-closed privacy policy engine.
 *
 * This is the component that turns "we detected some stuff" into an enforceable
 * decision. Its guiding rule: WHEN UNCERTAIN, REDACT. A leak is a security
 * incident; over-redaction is only a mild utility cost the server can cope with.
 *
 * It decides three things:
 *   1. HOW to redact each region (irreversible methods for high-sensitivity;
 *      reversible blur only for low-risk categories like background faces).
 *   2. WHETHER the screenshot may be sent at all, or downgraded to text-only,
 *      based on detector coverage / model availability (defense in depth).
 *   3. A privacy receipt (audit record) shown to the user and logged locally.
 */
(function () {
  const PBA = (self.PBA = self.PBA || {});
  const R = PBA.REDACT, PII = PBA.PII;

  // Per-category policy. `reversibleOk:false` forbids blur/pixelate — those can be
  // undone by deblurring/superresolution attacks, so secrets get solid fills.
  const POLICY = {
    [PII.PASSWORD]:     { method: R.REMOVE,   reversibleOk: false, minConf: 0.0 },
    [PII.OTP]:          { method: R.REMOVE,   reversibleOk: false, minConf: 0.0 },
    [PII.API_KEY]:      { method: R.BLACKOUT, reversibleOk: false, minConf: 0.4 },
    [PII.CREDIT_CARD]:  { method: R.BLACKOUT, reversibleOk: false, minConf: 0.5 },
    [PII.BANK_ACCOUNT]: { method: R.BLACKOUT, reversibleOk: false, minConf: 0.5 },
    [PII.AADHAAR]:      { method: R.BLACKOUT, reversibleOk: false, minConf: 0.5 },
    [PII.PAN]:          { method: R.BLACKOUT, reversibleOk: false, minConf: 0.5 },
    [PII.UPI]:          { method: R.TOKENIZE, reversibleOk: false, minConf: 0.6 },
    [PII.EMAIL]:        { method: R.TOKENIZE, reversibleOk: false, minConf: 0.6 },
    [PII.PHONE]:        { method: R.TOKENIZE, reversibleOk: false, minConf: 0.6 },
    [PII.DOB]:          { method: R.TOKENIZE, reversibleOk: false, minConf: 0.6 },
    [PII.PERSON]:       { method: R.TOKENIZE, reversibleOk: false, minConf: 0.55 },
    [PII.ADDRESS]:      { method: R.TOKENIZE, reversibleOk: false, minConf: 0.55 },
    [PII.FACE]:         { method: R.BLACKOUT, reversibleOk: true,  minConf: 0.5 },
    [PII.SIGNATURE]:    { method: R.BLACKOUT, reversibleOk: false, minConf: 0.35 }, // MUST stay ≤ the signature model's minScore (vision-neural.js REGISTRY); a higher floor silently drops model hits in that band — fail-OPEN for a fail-closed category.
    [PII.ID_DOCUMENT]:  { method: R.BLACKOUT, reversibleOk: false, minConf: 0.45 },
    [PII.IP]:           { method: R.TOKENIZE, reversibleOk: false, minConf: 0.7 },
    [PII.GENERIC_SECRET]:{ method: R.BLACKOUT,reversibleOk: false, minConf: 0.6 },
  };

  const HIGH_RISK = new Set([PII.PASSWORD, PII.OTP, PII.API_KEY, PII.CREDIT_CARD,
    PII.BANK_ACCOUNT, PII.AADHAAR, PII.PAN, PII.ID_DOCUMENT]);

  /**
   * @param {Array} redactionMap  from fusion.fuse()
   * @param {object} ctx { visionReady:bool, imageCount:int, config }
   * @returns {object} { plan:[], sendScreenshot:bool, receipt:{} }
   */
  function decide(redactionMap, ctx) {
    ctx = ctx || {};
    const counters = {};
    let n = 0;
    const plan = [];
    let dropped = 0;

    for (const r of redactionMap) {
      const pol = POLICY[r.pii_type] || { method: R.BLACKOUT, reversibleOk: false, minConf: 0.6 };

      // Fail-closed confidence gate: high-risk categories redact even at low
      // confidence; low-risk categories require meeting the threshold.
      const belowThreshold = r.confidence < pol.minConf;
      if (belowThreshold && !HIGH_RISK.has(r.pii_type)) { dropped++; continue; }

      const token = "<" + r.pii_type.toUpperCase() + "_" + ((counters[r.pii_type] = (counters[r.pii_type] || 0) + 1)) + ">";
      // Pad the box so anti-aliased glyph edges are fully covered.
      const pad = HIGH_RISK.has(r.pii_type) ? 4 : 2;
      const bbox = [r.bbox[0] - pad, r.bbox[1] - pad, r.bbox[2] + 2 * pad, r.bbox[3] + 2 * pad];

      plan.push({
        pii_type: r.pii_type,
        bbox,
        method: pol.method,
        token,
        confidence: Number(r.confidence.toFixed(3)),
        sources: r.sources,
        elementId: r.elementId,
      });
      n++;
    }

    // Defense-in-depth: if the vision model is NOT ready but the page has images,
    // we cannot vouch for faces/embedded-text in those images. Fail closed by
    // refusing to ship the screenshot; the server runs in text-only mode this step.
    let sendScreenshot = true;
    let downgradeReason = null;
    if (!ctx.visionReady && (ctx.imageCount || 0) > 0) {
      sendScreenshot = false;
      downgradeReason = "vision_model_unavailable_with_images_present";
    }

    // Residual-risk score: unresolved uncertainty after redaction.
    const lowConf = plan.filter((p) => p.confidence < 0.6).length;
    const residual_risk = !sendScreenshot ? "mitigated_text_only"
      : lowConf > 3 ? "medium" : lowConf > 0 ? "low" : "minimal";

    const receipt = {
      timestamp: new Date().toISOString(),
      detected: redactionMap.length,
      redacted: n,
      dropped_below_threshold: dropped,
      categories: countBy(plan),
      send_screenshot: sendScreenshot,
      downgrade_reason: downgradeReason,
      residual_risk,
      fail_closed_triggered: !sendScreenshot,
    };

    return { plan, sendScreenshot, receipt };
  }

  function countBy(plan) {
    const c = {};
    for (const p of plan) c[p.pii_type] = (c[p.pii_type] || 0) + 1;
    return c;
  }

  PBA.policy = { decide, POLICY, HIGH_RISK };
})();
