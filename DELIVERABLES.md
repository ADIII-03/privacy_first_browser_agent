# Deliverables — Persistent Side Panel + On-Device Query/Action Agent

Version `0.3.0` · Chrome MV3 · min Chrome 121

This document is the implementation record for extending the Privacy-Preserving
Browser Agent (PBA) from a transient action **popup** into a persistent Chrome
**Side Panel** that serves **both** read-only *query* tasks ("summarize my
spending by type") and *action* tasks ("fill and submit this form"), with a
judge-facing **Privacy Audit** view.

The thesis is unchanged and enforced by construction: **the browser is the
privacy gatekeeper — only sanitized context ever leaves the machine.**

---

## 1. Changed files

### Modified (7)

| File | What changed |
|---|---|
| [extension/manifest.json](extension/manifest.json) | Added top-level `side_panel.default_path`; added `sidePanel` permission; **removed** `action.default_popup` (kept the `action` block so `openPanelOnActionClick` works); registered [lib/record-extraction.js](extension/lib/record-extraction.js) in `content_scripts` before `content.js`. |
| [extension/background/service-worker.js](extension/background/service-worker.js) | `sidePanel.setPanelBehavior({openPanelOnActionClick:true})` on wake; `classifyIntent()` intent router; new `runQuery()` path; SW-side fail-closed `assertNoRawPII()` / `scanRaw()`; privacy-audit stream (`pushAudit`, `FORBIDDEN_FROM_EGRESS`, `auditPayloadPreview`); `state.mode/answer/audit/auditLog`; `visionState()` now carries `gpuAdapter`; `record-extraction.js` added to `CONTENT_SCRIPTS`; `START_TASK` resolves mode (explicit toggle wins, else `classifyIntent`). |
| [extension/content/content.js](extension/content/content.js) | Added the `EXTRACT_RECORDS` bridge (returns `PBA.records.extract()` — masked records). PERCEIVE/EXECUTE/VIEWPORT/PING untouched. |
| [extension/lib/vision/vision-neural.js](extension/lib/vision/vision-neural.js) | **Seam A** — per-model inference telemetry: module `_lastPerf`, populated in the detect loop with `{id, category, ep, ms, count}`; exposed via `get lastPerf()`. `detect()`'s array return is unchanged. |
| [extension/lib/vision/vision-detector.js](extension/lib/vision/vision-detector.js) | **Seam B** — captures WebGPU `adapter.info` (feature-detected) into `gpuAdapter`, returned from both `detect()` paths; `neuralInfo()` now includes `perModel: vn.lastPerf`. |
| [server/main.py](server/main.py) | New `POST /query` endpoint; `_scan_text()` + `_residual_scan_query()` (fail-closed 422 on any residual identifier, numeric-column-aware). `/plan` untouched. |
| [server/schemas.py](server/schemas.py) | New query models: `QueryColumn`, `QueryTable`, `MaskedSummary`, `QueryContext` (origin-only validator), `Group`, `Totals`, `DateRange`, `QueryAnswer`. Action models untouched. |

### Created (6)

| File | Purpose |
|---|---|
| [extension/sidepanel/sidepanel.html](extension/sidepanel/sidepanel.html) | Panel markup: runtime bar (Zone 1) + tab strip; Proceedings / Answer / Privacy-Audit panels. External CSS/JS only (CSP). |
| [extension/sidepanel/sidepanel.css](extension/sidepanel/sidepanel.css) | Fluid, resizable-width layout; palette mirrors the popup. |
| [extension/sidepanel/sidepanel.js](extension/sidepanel/sidepanel.js) | **Passive renderer** of the broadcast `state`. Holds no privacy logic. |
| [extension/lib/record-extraction.js](extension/lib/record-extraction.js) | On-device tabular extractor + masker (`PBA.records.extract`). The privacy boundary for query mode. |
| [server/query_planner.py](server/query_planner.py) | Deterministic aggregator (`answer_query`) — server AI turns masked tables into a `QueryAnswer`. |
| [demo/transactions.html](demo/transactions.html) | Synthetic statement fixture: `Account` identifier column + a Luhn-valid card inside a description cell. |

### Deliberately left intact

`runTask` action loop, `callServer`, `server/planner.py` + `/plan`, the classical
+ neural vision decode paths, and all `popup/*` and existing `demo/*` files. The
popup still loads if opened directly; the manifest simply no longer points at it.

---

## 2. Final architecture

The rule the whole system is built around:

```
Any webpage
  │
  ▼  (in the page, isolated world)
Local DOM / Regex / Vision  →  Local PII detection  →  Local Fusion
  →  Local Policy  →  Local Redaction / Tokenization
  │
  ▼  ONLY sanitized, typed context crosses this line ───────────────┐
                                                                     │  network
  Server AI reasons over sanitized data ─────────────────────────── ┘
  │
  ▼
Local browser executes actions  (action mode)  /  panel renders answer  (query mode)
```

Everything above the network line runs on-device. The service worker is the only
component that touches the network, and it POSTs exactly one of two sanitized
payloads (`/plan` or `/query`) — never a raw screenshot, never raw DOM, never a
raw identifier.

**Components**

- **Side panel** ([sidepanel.js](extension/sidepanel/sidepanel.js)) — passive
  renderer of `state`. It subscribes to the `STATE` broadcast and draws four
  zones (runtime/vision stats, live proceedings, answer/result, privacy audit).
  Because it's a side panel (not a popup) it stays open across navigation and
  tab switches, so a multi-step run streams continuously.
- **Service worker** ([service-worker.js](extension/background/service-worker.js))
  — owns `state`, the `STATE` broadcast, intent routing, both task loops, the
  network call, and the SW-side fail-closed re-scan.
- **Content libs** (isolated world) — `record-extraction.js` (query masking),
  plus the existing perception/redaction stack (`dom-perception.js`,
  `dom-detector.js`, `pii-regex.js`, `fusion.js`, `policy.js`, `redactor.js`).
- **Offscreen document** — WebGPU/WASM neural inference + canvas compositing of
  the redacted screenshot (action mode only).
- **Reasoning server** (`server/`, FastAPI, `:8000`) — `/plan` for actions,
  `/query` for summaries. Independently residual-scans every payload and fails
  closed (422) on any raw identifier.

**Messaging contract** (unchanged channel; the panel reuses it verbatim):

| Message | Direction | Payload |
|---|---|---|
| `GET_STATE` | panel → SW | → `{ok, state}` |
| `STATE` | SW → panel (broadcast) | `{state}` on every `pushLog`/`pushAudit` |
| `START_TASK` | panel → SW | `{task, tabId, mode}` → `{ok, mode}` |
| `STOP_TASK` | panel → SW | → `{ok}` |

`mode` is `auto` \| `query` \| `action`. `auto`/absent → on-device
`classifyIntent()`; an explicit toggle wins.
[service-worker.js:611-617](extension/background/service-worker.js#L611)

---

## 3. Query flow (read-only summarization)

Trigger: mode `query`, or `auto` resolving to query (a question / summarize verb
with no action verb). Entry: `runQuery(task, tabId)`
[service-worker.js:459](extension/background/service-worker.js#L459).

1. **Reset state**, `mode:"query"`, ensure content script is injected.
2. **One on-device vision pass** — capture the visible tab, run neural detection
   in the offscreen doc to light up Zone 1 (models, EP, per-model ms, WebGPU
   adapter). **The screenshot is analyzed locally and discarded; query mode POSTs
   no image at all.** It is kept only for the LOCAL-ONLY audit preview.
   [service-worker.js:490-507](extension/background/service-worker.js#L490)
3. **Extract masked records** — `EXTRACT_RECORDS` → `PBA.records.extract()` in
   the page walks `<table>` / ARIA-grid (and `<dl>` only as a fallback), classifies
   columns by header, **drops identifier columns to `<CATEGORY_n>` tokens**,
   tokenizes inline PII in retained cells, and parses amounts/dates into typed
   arrays. Only sanitized/typed values cross back to the worker.
   [record-extraction.js:296](extension/lib/record-extraction.js#L296)
4. **Build the sanitized payload** — query + masked tables + safe metadata (see
   §6). [service-worker.js:530-543](extension/background/service-worker.js#L530)
5. **Fail-closed pre-flight** — `assertNoRawPII(payload)` re-scans the outgoing
   payload with the canonical detector. If any raw identifier survived, **nothing
   is sent**; the panel shows a blocked card.
   [service-worker.js:547-556](extension/background/service-worker.js#L547)
6. **POST `/query`** — the server residual-scans again, then `answer_query()`
   aggregates (pick target table → metric/dimension/date columns → per-group and
   grand totals → date range → compose) and returns a `QueryAnswer`.
   [query_planner.py:181](server/query_planner.py#L181)
7. **Render** — the answer lands in Zone 3; the server's per-group breakdown is
   mirrored into Zone 2 as `calc` steps so the computation is visible.
   [service-worker.js:585-598](extension/background/service-worker.js#L585)

`runQuery` never calls `/plan` and never runs the action loop — read-only by
construction.

---

## 4. Action flow (server-driven agent loop)

Trigger: mode `action`, or `auto` resolving to action (an explicit action verb).
Entry: `runTask(task, tabId)` — **unchanged** from before this work.
[service-worker.js:208](extension/background/service-worker.js#L208).

Per step, under loop governors (`MAX_STEPS`, repeated-signature abort, per-step
timeout):

1. **Capture** the visible tab (raw — stays in the worker/offscreen).
2. **Local vision** — neural detection → face/signature boxes (CSS px).
3. **Perceive + protect** (in page) — build the sanitized element list + redaction
   plan; produce the privacy receipt.
4. **Redact pixels** (offscreen) — composite the **redacted** screenshot and draw
   Set-of-Marks. With no offscreen host, fail closed to text-only.
   [service-worker.js:291-308](extension/background/service-worker.js#L291)
5. **Reason** — POST `/plan` with the sanitized payload (redacted image + masked
   elements + placeholder-only redactions). Server validates against the closed
   `ActionType` vocabulary.
6. **Act** — each returned action is re-validated and executed in the content
   script; before/after state diff detects loops and confirms state change.

Every step emits audit events (§5) and appends to `state.receipts`.

---

## 5. Privacy audit flow (the demo view for judges)

Two independent, ordered records feed the **Privacy Audit** tab:

**`state.auditLog`** — a timeline of events carrying **only safe metadata**
(counts, `category→count` maps, booleans, endpoints, byte sizes — **never a
value**). Emitted by `pushAudit()`
[service-worker.js:61](extension/background/service-worker.js#L61):

`pii_detected` → `redaction_applied` → `screenshot_sanitized` →
`payload_sanitized` → `server_request` → `server_response` → (`local_action`, action mode).

**`state.audit`** — the before/after snapshot the panel draws:

- **BEFORE (local only):** the original screenshot, rendered under a
  `LOCAL ONLY — NOT TRANSMITTED` badge, with detection bounding boxes overlaid
  (category, confidence, source). Flagged `transmitted:false`.
- **AFTER (eligible to transmit):** action mode shows the redacted composite;
  query mode shows *no image* (there is none).
- **SANITIZED PAYLOAD:** `payloadPreview` — the exact JSON that left the browser,
  with any image dataURL swapped for a `[redacted image omitted — N chars]`
  marker so the full structure is provable without a megabyte of base64.
  [service-worker.js:78](extension/background/service-worker.js#L78)
- **FORBIDDEN LIST:** `FORBIDDEN_FROM_EGRESS`, shown verbatim (§7).

**Two fail-closed layers** (defense in depth):

1. **Client** — `assertNoRawPII()` re-scans the outgoing query payload with the
   *same* canonical detector before any POST; a hit aborts the send.
   Amount/numeric-column cells are exempt from digit-shaped types only (an amount
   is not an account number); any lettered type (email/PAN/UPI/key) is fatal
   everywhere. [service-worker.js:413-450](extension/background/service-worker.js#L413)
2. **Server** — `_residual_scan` / `_residual_scan_query` re-scan every inbound
   field and return **422** on any raw identifier, refusing to reason over
   unsanitized data even if the client had a bug.
   [main.py:42-92](server/main.py#L42)

---

## 6. Exact data sent to the server

### Query mode → `POST /query` (`QueryContext`)

```jsonc
{
  "protocol_version": "1.0",
  "session_id": "<uuid>",
  "query": "summarize my spending by transaction type",  // the user's own text
  "url_origin": "https://bank.example.com",               // ORIGIN ONLY (validator rejects path/query)
  "viewport": { "w": 1280, "h": 720, "scroll_x": 0, "scroll_y": 0, "dpr": 1 },
  "tables": [{
    "caption": "Transaction history — January 2026 (12 records)",
    "columns": [
      {"name":"Date","kind":"date"}, {"name":"Type","kind":"dimension"},
      {"name":"Merchant","kind":"dimension"}, {"name":"Amount","kind":"metric"},
      {"name":"Account","kind":"identifier"}
    ],
    "rows": [
      ["2026-01-03","Groceries","BigBazaar","₹2,340.00","<BANK_ACCOUNT_1>"],
      ["2026-01-21","Shopping","Refund to card <CREDIT_CARD_1>","-₹1,299.00","<BANK_ACCOUNT_10>"]
      // …one row per record; Account cells are tokens, the inline card is tokenized
    ],
    "numericColumns": [3], "dateColumns": [0], "dimensionColumns": [1,2],
    "numeric": { "3": [2340, -1299, /* … parsed amounts, null where unparsable */] },
    "dates":   { "0": ["2026-01-03", "2026-01-21", /* … ISO, null where unparsable */] },
    "truncated": false
  }],
  "masked": { "count": 13, "categories": { "bank_account": 12, "credit_card": 1 } },
  "privacy_receipt": {
    "detected": 13, "redacted": 13, "residual_risk": "mitigated_masked",
    "send_screenshot": false, "fail_closed_triggered": false,
    "categories": { "bank_account": 12, "credit_card": 1 }
  }
}
```

**What is and isn't in there — read this carefully.** The values sent are
**transaction data, not identifiers**:

- ✅ **Amounts, dates, transaction types, merchant names** are sent (in `rows`,
  and amounts/dates also as parsed `numeric`/`dates` arrays). They are exactly
  what a spending summary reads, and they are not PII. Merchant/description cells
  are still scanned for *inline* PII (the Luhn card in row 10 becomes
  `<CREDIT_CARD_1>`).
- ❌ **Account / card / Aadhaar / PAN / UPI values** are **never** sent — whole
  identifier columns are dropped to `<CATEGORY_n>` tokens in the page before the
  data crosses back to the worker. The raw digits never enter `rows`.
- ❌ **No screenshot.** `send_screenshot:false`, and no `screenshot` field exists.

The server's answer (`QueryAnswer`) returns `answer` (human text), `metric`,
`dimension`, `groups[]` (per-type `count/sum/avg/min/max`), `totals`,
`date_range`, `row_count` — all derived from the masked table.

### Action mode → `POST /plan` (`SanitizedContext`)

```jsonc
{
  "protocol_version": "1.0", "session_id": "<uuid>", "step": 1,
  "task": "complete and submit my application",
  "url_origin": "https://forms.example.com",       // origin only
  "viewport": { "w": 1280, "h": 720, "dpr": 1 },
  "screenshot": "data:image/webp;base64,…",          // the REDACTED composite, or null
  "screenshot_included": true,
  "elements": [ { "id": 4, "role": "textbox", "label": "Email", "bbox": [x,y,w,h],
                  "enabled": true, "value_state": "empty", "sensitive": true,
                  "pii_type": "email", "destructive": false } ],
  "redactions": [ { "pii_type": "signature", "token": "<SIGNATURE_1>",
                    "method": "blackout", "bbox": [x,y,w,h], "confidence": 0.94 } ],
  "privacy_receipt": { "detected": 3, "redacted": 3, "send_screenshot": true, … }
}
```

The `screenshot` is always the **redacted composite** (raw pixels blacked out),
never the original. `redactions[].token` is schema-validated to be a
`<PLACEHOLDER>` — a raw value cannot even be represented.
[schemas.py:59-65](server/schemas.py#L59)

---

## 7. Exact data forbidden from leaving the browser

Shown verbatim in the audit view (`FORBIDDEN_FROM_EGRESS`,
[service-worker.js:68](extension/background/service-worker.js#L68)):

1. **The original (unredacted) screenshot.** Captured locally, marked
   `transmitted:false`, and either discarded (query) or replaced by the redacted
   composite (action). It is *never* attached to any request.
2. **Raw account / card / password / OTP / API-key values.** Dropped or tokenized
   in the page before crossing to the worker.
3. **Raw page text or unsanitized DOM.** Only a masked, typed projection of
   records (query) or a sanitized element list (action) is sent.

Additional guarantees enforced by code:

- **Full URL** — only `url_origin` is sent, and the schema validator rejects any
  value containing a path or query string.
  [schemas.py:98-104](server/schemas.py#L98)
- **Query mode sends no image whatsoever.**
- **Logs and audit metadata never carry a value** — `scanRaw` returns the
  category, never `h.value`; audit `meta` is counts/booleans/maps only.

---

## 8. Setup & test instructions

### Start the reasoning server

```powershell
cd server
.\run.ps1                 # mock backend on http://localhost:8000 (no model needed)
```

`run.ps1` uses `uv sync` if `uv` is present, else falls back to a venv + pip.
Verify: open <http://localhost:8000/health> → `{"ok": true, …}`. The default
`PBA_BACKEND=mock` is a deterministic aggregator (CI/demo-friendly). On Windows,
if the `₹` symbol trips console encoding, set `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`.

(POSIX: `./run.sh`.)

### Load the extension

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder. (Chrome 121+.)
3. Click the toolbar icon → the **side panel opens** (no popup). The SW console
   should show no `sidePanel` errors.
4. If testing over `file://`, enable **Allow access to file URLs** for the
   extension; otherwise serve the demos over `http://localhost`.

### Test — query mode (the headline privacy proof)

1. Open [demo/transactions.html](demo/transactions.html).
2. In the panel: mode **Auto** (or **Summarize**), enter
   `summarize my spending by transaction type`, click **Run**.
3. Expect:
   - **Zone 2** streams `start → (vision) → extract → calc… → answer → done`.
   - **Zone 3** shows per-type `count/sum/min/max/avg`, grand totals, and the
     date range `2026-01-03 → 2026-01-28`.
   - **Privacy Audit** shows the `Account` column and the row-10 card rendered as
     tokens; the sanitized payload has **no raw account/card digits** and
     **no screenshot**.
   - **Network / server log:** a POST to `/query` only — **never `/plan`**.

### Test — action mode (regression)

1. Open [demo/index.html](demo/index.html).
2. Mode **Auto**/**Act**, enter `complete and submit my application`, **Run**.
3. Expect Zone 2 to stream `start → receipt → plan → action…`; Zone 1 to show
   models, EP, per-model ms (Seam A) and WebGPU adapter (Seam B); the audit view
   to show the **redacted** screenshot as the transmitted image.

### Test — masking spot-check & fail-closed

- The Luhn card in the row-10 description renders tokenized (`<CREDIT_CARD_1>`);
  the bare `Account` numbers are dropped by header classification.
- To see the server tripwire, POST a payload with a raw `123456789012` in a
  non-numeric cell to `/query` → **422 `residual_pii_detected`**.

### Persistence

During any run, navigate or switch tabs — the panel stays open and keeps
streaming (the popup could not).

---

*Companion docs:* [README.md](README.md) (overview), [DESIGN.md](DESIGN.md)
(threat model), [docs/VISION.md](docs/VISION.md) (neural stack),
[RUNBOOK.md](RUNBOOK.md) (ops).
