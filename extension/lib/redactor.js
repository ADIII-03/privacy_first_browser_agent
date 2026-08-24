/*
 * redactor.js — Pixel + text redaction and Set-of-Marks compositing.
 *
 * CORRECTNESS INVARIANTS (these are where naive implementations leak):
 *   (a) The ORIGINAL screenshot buffer never leaves the process that captured it.
 *       We composite a NEW canvas and only its bytes are eligible for transmit.
 *   (b) We redact BOTH modalities: pixels here, and the text labels/values in the
 *       structured payload (tokenizeText). A classic bug is blacking out pixels
 *       while leaking the same value in a JSON `label` field.
 *   (c) High-sensitivity regions use OPAQUE fills, never blur — blur is reversible.
 *
 * Runs in the offscreen document (has a real canvas). Coordinates arrive in CSS
 * pixels; the captured bitmap is in device pixels, so we scale by dpr.
 */
(function () {
  const PBA = (self.PBA = self.PBA || {});
  const R = PBA.REDACT || {
    REMOVE: "remove", BLACKOUT: "blackout", TOKENIZE: "tokenize",
    PIXELATE: "pixelate", BLUR: "blur", PRESERVE: "preserve",
  };

  async function loadBitmap(dataUrl) {
    const res = await fetch(dataUrl);
    return createImageBitmap(await res.blob());
  }

  /**
   * Composite a sanitized, mark-annotated image.
   * @returns {Promise<string>} webp data URL of the SANITIZED image
   */
  async function compose({ imageDataUrl, plan, marks, dpr, quality }) {
    dpr = dpr || 1;
    const bmp = await loadBitmap(imageDataUrl);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);

    // --- apply redactions (device-pixel space) ---
    for (const p of plan || []) {
      const [x, y, w, h] = p.bbox.map((v) => Math.round(v * dpr));
      if (w <= 0 || h <= 0) continue;
      switch (p.method) {
        case R.REMOVE:
        case R.BLACKOUT:
          ctx.fillStyle = "#000";
          ctx.fillRect(x, y, w, h);
          break;
        case R.TOKENIZE: {
          ctx.fillStyle = "#e5e7eb";
          ctx.fillRect(x, y, w, h);
          ctx.fillStyle = "#111827";
          ctx.font = `${Math.max(10, Math.min(h - 4, 14 * dpr))}px monospace`;
          ctx.textBaseline = "middle";
          ctx.fillText(p.token || "<REDACTED>", x + 3, y + h / 2, w - 6);
          break;
        }
        case R.PIXELATE: {
          // downscale-then-upscale within the region
          const tmp = new OffscreenCanvas(Math.max(1, w >> 3), Math.max(1, h >> 3));
          const tctx = tmp.getContext("2d");
          tctx.drawImage(canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
          ctx.imageSmoothingEnabled = true;
          break;
        }
        case R.BLUR: {
          ctx.save();
          ctx.filter = "blur(10px)";
          ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
          ctx.restore();
          break;
        }
        default:
          break;
      }
    }

    // --- Set-of-Marks: numbered boxes for interactable elements ---
    for (const m of marks || []) {
      const [x, y, w, h] = m.bbox.map((v) => Math.round(v * dpr));
      ctx.strokeStyle = m.sensitive ? "#dc2626" : "#2563eb";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeRect(x, y, w, h);
      const tag = String(m.id);
      ctx.font = `bold ${11 * dpr}px sans-serif`;
      const tw = ctx.measureText(tag).width + 6 * dpr;
      ctx.fillStyle = m.sensitive ? "#dc2626" : "#2563eb";
      ctx.fillRect(x, Math.max(0, y - 14 * dpr), tw, 14 * dpr);
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "top";
      ctx.fillText(tag, x + 3 * dpr, Math.max(0, y - 13 * dpr));
    }

    const blob = await canvas.convertToBlob({ type: "image/webp", quality: quality || 0.7 });
    return await blobToDataUrl(blob);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Replace PII substrings in a label/text with their category tokens so no raw
   * value survives in the structured payload. Mirrors the pixel redaction.
   */
  function tokenizeText(text, counters) {
    if (!text) return text;
    counters = counters || {};
    const hits = (PBA.pii && PBA.pii.scan(text)) || [];
    // replace back-to-front to keep indices valid
    let out = text;
    for (const h of hits.sort((a, b) => b.index - a.index)) {
      const token = "<" + h.type.toUpperCase() + "_" + ((counters[h.type] = (counters[h.type] || 0) + 1)) + ">";
      out = out.slice(0, h.index) + token + out.slice(h.index + h.length);
    }
    return out;
  }

  PBA.redactor = { compose, tokenizeText };
})();
