# The redaction boundary — before / after

This is the privacy filter made visible: the same government form as **you** see it in
the browser, and as the reasoning **server** receives it after on-device redaction.

> **Open the rendered, interactive version:** [`demo/redaction-visual.html`](demo/redaction-visual.html)
> — a self-contained page (no external assets, no network, theme-aware). Just open it in
> any browser. It animates the redaction wipe and the Set-of-Marks overlay, and you can
> replay it. The static summary below is the same content for quick reading on GitHub.

The invariant it demonstrates:

> **Raw PII — pixels or text — never crosses the boundary.** Faces and signatures are
> blacked out; identifiers are replaced by structure-preserving tokens; interactive
> elements get numbered marks so the server can still say *"fill element 4"* without ever
> seeing a value.

---

## Same form, two views

| On the page | What **you** see (before) | What the **server** receives (after) | Method | Detector |
|---|---|---|---|---|
| Applicant photo | 🧑 a face | ▇▇▇▇ opaque box | **BLACKOUT** | vision (FACE) |
| Guardian photo | 🧑 a face | ▇▇▇▇ opaque box | **BLACKOUT** | vision (FACE) |
| Signature | ✍️ handwritten ink | ▇▇▇▇ opaque box | **BLACKOUT** | vision (SIGNATURE) |
| Full name | `Ravi Kumar` | `‹name_1›` | TOKENIZE | DOM label |
| Email | `ravi.kumar@example.com` | `‹email_1›` | TOKENIZE | DOM `type=email` |
| Mobile | `9876543210` | `‹phone_1›` | TOKENIZE | DOM `type=tel` |
| Aadhaar | `3456 7890 1238` | `‹aadhaar_1›` | TOKENIZE | text · **Verhoeff-valid** |
| PAN | `ABCPK7392Q` | `‹pan_1›` | TOKENIZE | text · holder-type rule |
| Fee card | `4556 1234 5678 9015` | `‹card_1›` | TOKENIZE | text · **Luhn-valid** |
| OTP | `482913` | `‹otp_1›` | TOKENIZE | DOM `one-time-code` |
| Password | `••••••••` | ▇▇▇▇ (never in payload) | **BLACKOUT** | DOM `type=password` |

The faces and the signature are the whole point of on-device vision: **no DOM parsing
recovers them** — only the pixels do, and the pixels are masked before the screenshot is
allowed to leave. Every identifier shown is fabricated but genuinely **checksum-valid**,
so the shipped detector treats it as real (a shape-only matcher would too — the checksums
are what keep precision honest on the hard negatives).

---

## The pipeline (all four stages on-device)

```
   DETECT              FUSE                DECIDE              REDACT
 ┌─────────┐        ┌─────────┐        ┌──────────┐        ┌───────────┐
 │ DOM/ARIA│        │ union-  │        │fail-closed│       │ blackout  │
 │ checksum│  ───►  │ biased  │  ───►  │ policy:   │  ───► │ + tokenize│
 │ vision  │        │ noisy-OR│        │ face/sig  │       │ + Set-of- │
 │ (px)    │        │ IoU merge│       │  →blackout│       │   Marks   │
 └─────────┘        └─────────┘        │ text→token│       │ + receipt │
                                       └──────────┘        └───────────┘
```

- **Detect** — three signals with uncorrelated error modes: DOM semantics (highest
  precision), checksum-validated text, and the WebGPU/CPU vision detector for pixels.
- **Fuse** — same-category boxes merge by IoU; confidences combine with noisy-OR. Two
  weak hints for one region become one strong one. Union-biased on purpose.
- **Decide** — faces & signatures → blackout; text → tokenize; *when uncertain, redact*;
  no vision on an image-bearing page ⇒ the screenshot is withheld entirely.
- **Redact** — compose the masked screenshot, tokenize labels, draw the numbered
  Set-of-Marks overlay, and emit the receipt below.

---

## Set-of-Marks: how the server acts without seeing values

In the **after** view every interactive element carries a numbered badge whose number
*is* its protocol ID. The server plans against IDs — *"type into element 4"* — never
against fragile pixel coordinates, CSS selectors, or the values themselves. Sensitive
fields are filled by `fill_local` from the on-device vault, so even the value the server
asked to place there is sourced in the browser, not in the payload.

---

## The privacy receipt (auditable proof, surfaced in the popup)

```json
{
  "detected": 10,
  "redacted": 10,
  "send_screenshot": "yes (redacted)",
  "raw_values_in_payload": 0,
  "url": "origin only",
  "residual_risk": "minimal",
  "categories": {
    "face": 2, "signature": 1,
    "aadhaar": 1, "pan": 1, "credit_card": 1,
    "email": 1, "phone": 1, "otp": 1, "password": 1
  }
}
```

Recall is treated as a **safety property**, not just a metric: a missed region is a leak.
The only precision cost the evaluator finds on signatures is *over-*redaction (a pen-lift
signature split into two fully-masked boxes) — the safe direction. See the measured
scorecard in [`README.md`](README.md#measured-results-on-the-shipped-code) and the full
rationale in [`DESIGN.md`](DESIGN.md).

---

*This is an illustrative composite of [`demo/index.html`](demo/index.html) — the layout
and values mirror the demo page so the before/after is faithful to what the extension
actually redacts, without shipping a screenshot of real PII.*
