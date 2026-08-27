/*
 * record-extraction.js — On-device tabular record extractor for QUERY mode.
 *
 * The side panel's summarizer needs the page's TRANSACTION-style records (dates,
 * types, merchants, amounts) to compute totals/averages/breakdowns locally. This
 * lib walks record containers and returns a MASKED, typed view of them — and it is
 * the privacy boundary for that path: raw account/card numbers and inline secrets
 * are removed IN-PAGE here, so only sanitized values ever cross back to the worker.
 *
 * Masking (reuses the existing primitives — no new detection logic):
 *   • Identifier columns (Account/Card/Aadhaar/PAN/UPI by HEADER) → the value is
 *     dropped entirely and replaced by a <CATEGORY_n> token. It never enters `rows`.
 *   • Every retained free-text cell → PBA.redactor.tokenizeText (→ PBA.pii.scan),
 *     which catches inline Luhn cards / Aadhaar / email / phone / UPI / API keys.
 *   • Secondary bank-account rule: there is NO free-text bank_account regex
 *     (pii-regex.js), so any residual 9–18 digit run in a non-amount cell is
 *     tokenized as GENERIC_SECRET — fail toward masking (policy.js ethos).
 *   • Signatures are IMAGE detections handled by the vision path; query mode
 *     captures/sends no screenshot, so they never enter this text path.
 *
 * Amounts and dates are PARSED here (one place, no worker-side re-parsing) into
 * typed arrays the worker aggregates. Amounts are transaction data the summary is
 * allowed to read — they are NOT masked; only identifiers/secrets are.
 *
 * Runs in the content-script isolated world. Loaded AFTER protocol/pii-regex/
 * redactor (so PBA.PII, PBA.pii, PBA.redactor exist) and BEFORE content.js.
 */
(function () {
  const PBA = (self.PBA = self.PBA || {});
  const PII = PBA.PII || {};

  const MAX_TABLES = 20;
  const MAX_ROWS = 2000;   // per table; larger tables are truncated (flagged, never silent)
  const MAX_CELL = 200;    // display cap per masked cell

  // ---- small DOM helpers (dom-detector's are not exported) ----------------
  function cellText(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Rendered (not necessarily in-viewport — a tall table below the fold is valid data).
  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return false;
    return true;
  }

  // Union CSS-px bounding box [x,y,w,h] of one element or a group, viewport-relative —
  // the same coordinate space as vision/PERCEIVE boxes, which the offscreen compositor
  // scales by dpr onto the device-px screenshot. null when nothing is laid out.
  function rectOf(elOrEls) {
    const els = Array.isArray(elOrEls) ? elOrEls : [elOrEls];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of els) {
      if (!el || typeof el.getBoundingClientRect !== "function") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.left < x0) x0 = r.left; if (r.top < y0) y0 = r.top;
      if (r.right > x1) x1 = r.right; if (r.bottom > y1) y1 = r.bottom;
    }
    if (!isFinite(x0)) return null;
    return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)];
  }

  // Record a pixel region to BLACK OUT in the sent screenshot (query mode composites
  // these into the raster). Critically, the identifier COLUMNS the extractor drops from
  // `rows` have NO free-text regex to catch them (a bare account number matches nothing),
  // so their on-screen pixels would otherwise stay legible in a sent image — this is the
  // only thing that redacts them there. cat is cosmetic; the box + method is what matters.
  function pushBox(boxes, elOrEls, cat) {
    if (!boxes) return;
    const bbox = rectOf(elOrEls);
    if (bbox) boxes.push({ pii_type: cat || PII.GENERIC_SECRET || "generic_secret", bbox, method: "blackout", confidence: 1 });
  }

  // ---- column classification (by header text) -----------------------------
  // Identifier headers win first (their whole column is dropped), then metric,
  // date, dimension. Mirrors the keyword intent of dom-detector.js:90-100.
  function classifyHeader(name) {
    const h = (name || "").toLowerCase();
    if (/\baadhaar\b|\baadhar\b|\buid\b/.test(h)) return { kind: "identifier", cat: PII.AADHAAR };
    if (/\bpan\b/.test(h)) return { kind: "identifier", cat: PII.PAN };
    if (/card|cvv|cvc/.test(h)) return { kind: "identifier", cat: PII.CREDIT_CARD };
    if (/account|acct|a\/c|ifsc|iban/.test(h)) return { kind: "identifier", cat: PII.BANK_ACCOUNT };
    if (/\bupi\b|\bvpa\b/.test(h)) return { kind: "identifier", cat: PII.UPI };
    if (/amount|amt|debit|credit|balance|value|price|total|paid|charge|deposit|withdraw|\binr\b|\busd\b|₹|\$/.test(h)) return { kind: "metric" };
    if (/date|time|posted|\bwhen\b|\bday\b/.test(h)) return { kind: "date" };
    if (/type|categor|\bmode\b|method|description|desc|merchant|narration|payee|vendor|store|status|particular/.test(h)) return { kind: "dimension" };
    return { kind: "other" };
  }

  // ---- value parsers ------------------------------------------------------
  // Amount: strips currency/codes/commas, treats (1,234.56) and trailing/leading
  // minus as negative. Assumes ',' thousands + '.' decimal (v1; EU 1.234,56 is out
  // of scope — flagged in the plan's risks).
  function parseAmount(text) {
    if (text == null) return null;
    let s = String(text).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/^-/.test(s) || /-\s*$/.test(s) || /\bdr\b/i.test(s)) neg = true;
    s = s.replace(/[₹$€£¥]/g, "")
         .replace(/\b(?:INR|USD|EUR|GBP|Rs\.?|rs|dr|cr)\b/gi, "")
         .replace(/[,\s]/g, "")
         .replace(/[+\-]/g, "");
    if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
    const n = parseFloat(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

  // Date → ISO "YYYY-MM-DD" (ISO strings sort chronologically, so min/max is lexical).
  // Handles ISO, D/M/Y & M/D/Y (disambiguated when a field > 12), and "12 Aug 2026".
  function parseDate(text) {
    if (!text) return null;
    const s = String(text).trim();
    if (!s) return null;
    let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      let y = m[3].length === 2 ? "20" + m[3] : m[3];
      if (b > 12 && a <= 12) { const t = a; a = b; b = t; } // swap if 2nd field can't be a month
      if (b < 1 || b > 12 || a < 1 || a > 31) return null;
      return `${y}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
    }
    m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,})\.?\s*,?\s*(\d{4})\b/);
    if (m && MON[m[2].slice(0, 3).toLowerCase()]) {
      const mo = MON[m[2].slice(0, 3).toLowerCase()];
      return `${m[3]}-${String(mo).padStart(2, "0")}-${String(parseInt(m[1], 10)).padStart(2, "0")}`;
    }
    m = s.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})\s*,?\s*(\d{4})\b/);
    if (m && MON[m[1].slice(0, 3).toLowerCase()]) {
      const mo = MON[m[1].slice(0, 3).toLowerCase()];
      return `${m[3]}-${String(mo).padStart(2, "0")}-${String(parseInt(m[2], 10)).padStart(2, "0")}`;
    }
    return null;
  }

  // ---- masking ------------------------------------------------------------
  function tokenOf(cat, counters) {
    return "<" + String(cat).toUpperCase() + "_" + ((counters[cat] = (counters[cat] || 0) + 1)) + ">";
  }

  // Mask a retained free-text cell: inline PII via the shared scanner, then the
  // secondary long-digit (bank-account) rule. Tallies every masked item.
  function maskCell(text, counters, tally) {
    let s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (!s) return "";
    const hits = (PBA.pii && PBA.pii.scan) ? PBA.pii.scan(s) : [];
    for (const h of hits) { tally.count++; tally.categories[h.type] = (tally.categories[h.type] || 0) + 1; }
    s = (PBA.redactor && PBA.redactor.tokenizeText) ? PBA.redactor.tokenizeText(s, counters) : s;
    s = s.replace(/\d(?:[ -]?\d){8,17}/g, (m) => {
      const digits = m.replace(/[ -]/g, "");
      if (digits.length < 9 || digits.length > 18) return m;
      tally.count++; tally.categories[PII.GENERIC_SECRET] = (tally.categories[PII.GENERIC_SECRET] || 0) + 1;
      return tokenOf(PII.GENERIC_SECRET, counters);
    });
    return s.slice(0, MAX_CELL);
  }

  // ---- container → matrix -------------------------------------------------
  function tableMatrix(tableEl) {
    const caption = (
      (tableEl.querySelector("caption") && tableEl.querySelector("caption").innerText) ||
      tableEl.getAttribute("aria-label") || ""
    ).replace(/\s+/g, " ").trim();

    let headerCells = [], headerEls = [];
    const thead = tableEl.querySelector("thead");
    if (thead) {
      const hr = thead.querySelector("tr");
      if (hr) { const hc = [...hr.querySelectorAll("th,td")]; headerCells = hc.map(cellText); headerEls = hc; }
    }

    const bodyScope = tableEl.querySelector("tbody") || tableEl;
    let trs = [...bodyScope.querySelectorAll(":scope > tr")];
    if (!trs.length) trs = [...tableEl.querySelectorAll("tr")];

    // bodyEls tracks each row's cell ELEMENTS in lockstep with bodyRows' text, so the
    // builder can capture a masked cell's on-screen box for the screenshot compositor.
    const bodyRows = [], bodyEls = [];
    for (const tr of trs) {
      const cells = [...tr.querySelectorAll("th,td")];
      if (!cells.length) continue;
      if (!headerCells.length && cells.every((c) => c.tagName === "TH")) { headerCells = cells.map(cellText); headerEls = cells; continue; }
      bodyRows.push(cells.map(cellText)); bodyEls.push(cells);
    }

    // No explicit header → promote the first row if it reads like labels (no amounts).
    // Shift bodyEls in lockstep so it stays row-aligned with bodyRows.
    if (!headerCells.length && bodyRows.length > 1 && bodyRows[0].every((c) => parseAmount(c) == null && parseDate(c) == null)) {
      headerCells = bodyRows.shift(); headerEls = bodyEls.shift();
    }
    return { caption, headerCells, bodyRows, bodyEls };
  }

  function ariaMatrix(el) {
    const caption = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    let headerCells = [];
    const bodyRows = [], bodyEls = [];
    for (const r of el.querySelectorAll("[role='row']")) {
      const heads = [...r.querySelectorAll("[role='columnheader']")];
      const cells = [...r.querySelectorAll("[role='cell'],[role='gridcell']")];
      if (heads.length && !cells.length && !headerCells.length) { headerCells = heads.map(cellText); continue; }
      const rc = cells.length ? cells : heads;
      if (rc.length) { bodyRows.push(rc.map(cellText)); bodyEls.push(rc); }
    }
    return { caption, headerCells, bodyRows, bodyEls };
  }

  // <dl> = heterogeneous key/value block (e.g. "Account Number: 1234…"). We can't
  // aggregate it, but we CAN mask each value by its field name so the panel shows
  // the details redacted. Emitted as a 2-column [Field, Value] table.
  function dlMatrix(dlEl) {
    const caption = (dlEl.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const kids = [...dlEl.children];
    // bodyEls[row] = [dtEl, [ddEl,…]] so the value's box (the dd group) can be blacked out.
    const bodyRows = [], bodyEls = [];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].tagName !== "DT") continue;
      const dt = cellText(kids[i]);
      const dd = [], ddEls = [];
      let j = i + 1;
      while (j < kids.length && kids[j].tagName === "DD") { dd.push(cellText(kids[j])); ddEls.push(kids[j]); j++; }
      bodyRows.push([dt, dd.join("; ")]); bodyEls.push([kids[i], ddEls]);
    }
    return { caption, headerCells: ["Field", "Value"], bodyRows, bodyEls, isKeyValue: true };
  }

  // ---- matrix → masked, typed table --------------------------------------
  // `boxes` (optional) collects CSS-px regions to black out in the sent screenshot;
  // every cell whose value is dropped/tokenized here contributes its on-screen box.
  function buildTable(matrix, counters, tally, boxes) {
    const { caption, headerCells, isKeyValue } = matrix;
    const truncated = matrix.bodyRows.length > MAX_ROWS;
    const body = matrix.bodyRows.slice(0, MAX_ROWS);
    if (!body.length) return null;
    const ncols = Math.max(headerCells.length, ...body.map((r) => r.length));
    if (!ncols) return null;

    // Key/value <dl>: classify each VALUE by its own field, no aggregation.
    if (isKeyValue) {
      const rows = body.map((r, ri) => {
        const els = (matrix.bodyEls && matrix.bodyEls[ri]) || [];
        const cls = classifyHeader(r[0] || "");
        const field = maskCell(r[0] || "", counters, tally);
        let val;
        if (cls.kind === "identifier") {
          const raw = (r[1] || "").trim();
          if (raw) { tally.count++; const cat = cls.cat || PII.GENERIC_SECRET;
            tally.categories[cat] = (tally.categories[cat] || 0) + 1; val = tokenOf(cat, counters);
            pushBox(boxes, els[1], cat); }
          else val = "";
        } else {
          const before = tally.count;
          val = maskCell(r[1] || "", counters, tally);
          if (tally.count > before) pushBox(boxes, els[1], PII.GENERIC_SECRET);
        }
        return [field, val];
      });
      return { caption: caption || "details", columns: [{ name: "Field", kind: "dimension" }, { name: "Value", kind: "other" }],
        rows, numericColumns: [], dateColumns: [], dimensionColumns: [0], numeric: {}, dates: {}, truncated };
    }

    const columns = [];
    for (let c = 0; c < ncols; c++) {
      const name = (headerCells[c] || `Column ${c + 1}`).slice(0, 60);
      columns.push({ name, ...classifyHeader(name) });
    }

    const numeric = {}, dates = {};
    for (let c = 0; c < ncols; c++) {
      if (columns[c].kind === "metric") numeric[c] = [];
      else if (columns[c].kind === "date") dates[c] = [];
    }

    const rows = [];
    for (let ri = 0; ri < body.length; ri++) {
      const r = body[ri];
      const els = (matrix.bodyEls && matrix.bodyEls[ri]) || [];
      const out = [];
      for (let c = 0; c < ncols; c++) {
        const raw = r[c] != null ? r[c] : "";
        const col = columns[c];
        if (col.kind === "identifier") {
          if (String(raw).trim()) {
            tally.count++; const cat = col.cat || PII.GENERIC_SECRET;
            tally.categories[cat] = (tally.categories[cat] || 0) + 1;
            out.push(tokenOf(cat, counters));
            pushBox(boxes, els[c], cat); // black out the identifier cell in the screenshot
          } else out.push("");
        } else if (col.kind === "metric") {
          numeric[c].push(parseAmount(raw));
          out.push(String(raw).replace(/\s+/g, " ").trim().slice(0, MAX_CELL)); // amounts aren't PII
        } else if (col.kind === "date") {
          dates[c].push(parseDate(raw));
          out.push(String(raw).replace(/\s+/g, " ").trim().slice(0, MAX_CELL));
        } else {
          const before = tally.count;
          out.push(maskCell(raw, counters, tally));
          if (tally.count > before) pushBox(boxes, els[c], PII.GENERIC_SECRET); // inline PII masked → hide the cell
        }
      }
      rows.push(out);
    }

    // Downgrade a "metric" column that rarely parses — don't guess numbers.
    for (let c = 0; c < ncols; c++) {
      if (columns[c].kind !== "metric") continue;
      const arr = numeric[c] || [];
      const ok = arr.filter((v) => v != null && isFinite(v)).length;
      if (!arr.length || ok / arr.length < 0.5) {
        columns[c].kind = "other";
        delete numeric[c];
        for (let i = 0; i < rows.length; i++) {
          const before = tally.count;
          rows[i][c] = maskCell(body[i] && body[i][c] != null ? body[i][c] : "", counters, tally);
          if (tally.count > before) { const els = (matrix.bodyEls && matrix.bodyEls[i]) || []; pushBox(boxes, els[c], PII.GENERIC_SECRET); }
        }
      }
    }

    const numericColumns = [], dateColumns = [], dimensionColumns = [];
    for (let c = 0; c < ncols; c++) {
      if (columns[c].kind === "metric") numericColumns.push(c);
      else if (columns[c].kind === "date") dateColumns.push(c);
      else if (columns[c].kind === "dimension") dimensionColumns.push(c);
    }

    return { caption: caption || "", columns, rows, numericColumns, dateColumns, dimensionColumns, numeric, dates, truncated };
  }

  // ---- public entry -------------------------------------------------------
  function extract(opts) {
    try {
      const counters = {};
      const tally = { count: 0, categories: {} };
      const tables = [];
      const seen = new Set();
      // CSS-px regions to black out in the sent screenshot — collected in lockstep
      // with the masked tables so the raster hides exactly what the tables tokenized
      // (notably the identifier columns that match NO free-text regex). See pushBox().
      const boxes = [];

      const add = (matrix) => {
        if (tables.length >= MAX_TABLES) return;
        const t = buildTable(matrix, counters, tally, boxes);
        if (t && t.rows.length) tables.push(t);
      };

      for (const el of document.querySelectorAll("table")) {
        if (seen.has(el) || !visible(el)) continue; seen.add(el);
        add(tableMatrix(el));
      }
      for (const el of document.querySelectorAll("[role='grid'],[role='table']")) {
        if (el.tagName === "TABLE" || seen.has(el) || !visible(el)) continue; seen.add(el);
        add(ariaMatrix(el));
      }
      // <dl> only as a fallback when no tabular data was found (key/value blocks).
      if (!tables.length) {
        for (const el of document.querySelectorAll("dl")) {
          if (seen.has(el) || !visible(el)) continue; seen.add(el);
          add(dlMatrix(el));
        }
      }

      return { ok: true, tables, masked: tally, redactBoxes: boxes };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), tables: [], masked: { count: 0, categories: {} }, redactBoxes: [] };
    }
  }

  PBA.records = { extract, parseAmount, parseDate, classifyHeader };
})();
