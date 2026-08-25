/*
 * fusion.js — Privacy fusion layer.
 *
 * Combines three independent evidence sources into ONE redaction map:
 *   1. DOM semantics   (field-level, highest precision)
 *   2. Regex/OCR text  (value-level, checksum-backed)
 *   3. Vision          (pixel-level: faces, signatures, doc regions)
 *
 * Fusion is deliberately UNION-biased, not intersection-biased: for privacy,
 * a false negative (leak) is far worse than a false positive (over-redaction).
 * Overlapping detections are merged, and their confidences combined with a
 * noisy-OR so agreement between sources raises confidence.
 */
(function () {
  const PBA = (self.PBA = self.PBA || {});

  function iou(a, b) {
    const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
    const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
    const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const uni = aw * ah + bw * bh - inter;
    return uni <= 0 ? 0 : inter / uni;
  }
  const noisyOr = (p, q) => 1 - (1 - p) * (1 - q);

  // Map a PII match inside a text run to an approximate pixel bbox by
  // proportionally slicing the run's box (monospace-ish assumption; good enough
  // to seed redaction, then padded by the policy engine).
  function sliceBox(runBox, textLen, matchIndex, matchLen) {
    const [x, y, w, h] = runBox;
    const cw = w / Math.max(1, textLen);
    // No padding here — the policy engine applies the single canonical pad.
    return [Math.round(x + cw * matchIndex), y, Math.round(cw * matchLen), h];
  }

  /**
   * @param {object} signals { fieldPII[], textNodes[], visionDetections[] }
   * @returns {Array} redaction map entries {pii_type, bbox, confidence, sources[]}
   */
  function fuse(signals) {
    const raw = [];

    // 1. DOM field-level PII → redact the whole field box.
    for (const f of signals.fieldPII || []) {
      raw.push({ pii_type: f.pii_type, bbox: f.bbox, confidence: f.confidence, sources: ["dom"], elementId: f.elementId });
    }

    // 2. Regex over each visible text run.
    for (const run of signals.textNodes || []) {
      const hits = PBA.pii.scan(run.text);
      for (const h of hits) {
        raw.push({
          pii_type: h.type,
          bbox: sliceBox(run.bbox, run.text.length, h.index, h.length),
          confidence: h.confidence,
          sources: ["regex"],
        });
      }
    }

    // 3. Vision detections (faces/signatures/doc regions) already come as boxes.
    for (const v of signals.visionDetections || []) {
      raw.push({ pii_type: v.pii_type, bbox: v.bbox, confidence: v.confidence, sources: ["vision"] });
    }

    // Merge overlapping same-category boxes; combine confidence with noisy-OR.
    const merged = [];
    for (const r of raw) {
      const hit = merged.find((m) => m.pii_type === r.pii_type && iou(m.bbox, r.bbox) > 0.3);
      if (hit) {
        hit.confidence = noisyOr(hit.confidence, r.confidence);
        hit.sources = Array.from(new Set(hit.sources.concat(r.sources)));
        // widen bbox to the union
        const x1 = Math.min(hit.bbox[0], r.bbox[0]), y1 = Math.min(hit.bbox[1], r.bbox[1]);
        const x2 = Math.max(hit.bbox[0] + hit.bbox[2], r.bbox[0] + r.bbox[2]);
        const y2 = Math.max(hit.bbox[1] + hit.bbox[3], r.bbox[1] + r.bbox[3]);
        hit.bbox = [x1, y1, x2 - x1, y2 - y1];
      } else {
        merged.push({ ...r });
      }
    }
    return merged;
  }

  PBA.fusion = { fuse, iou };
})();
