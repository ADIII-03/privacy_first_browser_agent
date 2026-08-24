# Demo — end-to-end task on a synthetic government form

`demo/index.html` is a **self-contained** page that stands in for a real "fill this
online application" task. Everything on it is fabricated sample data. It exists to
make two problem-statement requirements concrete and observable:

1. **"Privacy-preserving filter … clearly demonstrated"** — the page deliberately
   contains *every* class of signal the agent must catch, so you can watch the
   redaction happen before anything leaves the device.
2. **"An end-to-end task assisting the user should be demonstrated"** — you give the
   agent a goal in plain English; it perceives → redacts → asks the server for a
   plan → executes safe actions on the page.

## What the page plants (and which detector catches it)

| On the page | Signal path | Caught by |
|---|---|---|
| `type=password`, `autocomplete=cc-number`, `autocomplete=one-time-code`, `type=email`, `type=tel` | **DOM semantics** (highest precision) | `dom-detector.js` |
| `name="aadhaar"`, `name="pan"`, `name="account"` text inputs | DOM name/label heuristic | `dom-detector.js` |
| Visible, **checksum-valid** Aadhaar `3456 7890 1238`, PAN `ABCPK7392Q`, card `4556 1234 5678 9015`, phone, UPI, OTP, IP in the read-only summary | **Text + checksum** scan | `pii-regex.js` |
| Two skin-toned `<img>` face avatars | **Vision** (pixels only — the DOM just says `<img alt>`) | `vision-detector.js` (FACE) |
| Handwritten `<canvas>` signature | **Vision** | `vision-detector.js` (SIGNATURE) |
| "Pay Fee & Transfer ₹1,000" button | destructive-intent gate | `content.js` (human click required) |

The faces and the signature are the point of the on-device vision model: **no amount
of DOM parsing reveals them** — only the pixels do, and the pixels never leave the
machine un-redacted.

## Run it

1. **Start the reasoning server** (returns the action plan; never sees raw pixels or PII):
   ```bash
   cd server
   python -m venv .venv && . .venv/Scripts/activate   # Windows; use .venv/bin/activate on macOS/Linux
   pip install -r requirements.txt
   uvicorn main:app --port 8000
   ```
   With `PBA_BACKEND` unset it defaults to the built-in **mock planner**, so the
   demo is fully offline and deterministic (no model, no API key, no network).

2. **Load the extension** — Chrome → `chrome://extensions` → *Developer mode* → *Load
   unpacked* → select `extension/`.

3. **Open the demo page** — open `demo/index.html` in that Chrome profile
   (`file://…/demo/index.html` is fine).

4. **Run a task** — click the extension icon and enter, e.g.:
   > *Fill in my email and phone from my profile, then submit the application.*

   Email/phone come from the **local vault** (`fill_local`) — the server proposes
   *which* field to fill, never the value. Click **Submit** is the safe goal; the
   status line under the buttons confirms it fired.

## What to watch (the "before/after")

- **Popup privacy receipt** — `detected`, `redacted`, `send_screenshot: text-only
  (fail-closed)` vs `yes`, residual-risk pill, and per-category counts. This is the
  auditable proof of what was filtered.
- **The screenshot that would be transmitted** is the *redacted* one: faces and the
  signature blacked out, text PII tokenized. Open [`redaction-visual.html`](redaction-visual.html)
  for a rendered, interactive side-by-side (or read [`../REDACTION_VISUAL.md`](../REDACTION_VISUAL.md)).
- **Try the destructive path** — ask the agent to "pay the fee". It will surface the
  action but stop for a human click; the transfer never happens autonomously.

> Tip: everything the extension would send is logged in the popup. Nothing leaves the
> browser until the redacted, tokenized `SanitizedContext` is POSTed to
> `http://localhost:8000/plan`.
