/* sidepanel.js — the persistent side panel's renderer.
 *
 * This is a PASSIVE VIEW. It holds no privacy logic: it calls GET_STATE on open,
 * subscribes to the service worker's STATE broadcast, and paints whatever `state`
 * says. Starting a task is a single START_TASK message (task + tabId + mode). The
 * worker owns the loop, the redaction, the fail-closed decision, and the audit
 * record — the panel only shows what already happened on-device.
 *
 * Four zones, per the spec:
 *   1. On-device runtime / vision / WebGPU stats  (pinned top — #visionBar)
 *   2. Live proceedings                            (#log)
 *   3. Answer / result                             (#answer)
 *   4. Privacy audit / demo view for judges        (#audit)
 */
const $ = (id) => document.getElementById(id);
const ext = globalThis.browser || globalThis.chrome;

// ---- small formatting helpers ------------------------------------------
const nf2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Escape for a <pre> code block: only &<> (leave quotes literal for JSON readability).
function escCode(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function fmtMoney(cur, n) {
  if (n == null || !isFinite(n)) return "—";
  const s = (cur || "") + nf2.format(Math.abs(n));
  return n < 0 ? "-" + s : s;
}
function fmtMs(n) { return (n == null || !isFinite(n)) ? "—" : Math.round(n) + " ms"; }

async function activeTabId() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

// ---- Zone 1: on-device runtime / vision / WebGPU -----------------------
function renderVision(state) {
  const v = state && state.vision;
  const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  if (!v) {
    ["vNeural", "vEP", "vModels", "vWarm", "vDet", "vLast"].forEach((id) => set(id, "–"));
    $("vRuntime").textContent = "–"; $("vRuntime").className = "chip mut";
    $("vAdapter").hidden = true; $("vPerModelWrap").hidden = true;
    return;
  }
  const neural = v.neural;
  // Neural stack pill
  if (v.offscreen === false) $("vNeural").innerHTML = '<span class="pill warn">text-only (no offscreen)</span>';
  else if (neural && neural.available) $("vNeural").innerHTML = '<span class="pill ok">active (on-device)</span>';
  else $("vNeural").innerHTML = '<span class="pill warn">classical core only</span>';

  // Runtime chip: the actual execution provider driving inference this session.
  const ep = (neural && neural.ep) || v.classical || null;
  const runtime = ep ? String(ep).toUpperCase() : (v.offscreen === false ? "TEXT-ONLY" : "CPU");
  const rc = $("vRuntime");
  rc.textContent = runtime;
  rc.className = "chip " + (/GPU/.test(runtime) ? "action" : "mut");

  // Execution providers (neural EP + classical CV core path)
  const eps = [];
  if (neural && neural.ep) eps.push("neural " + String(neural.ep).toUpperCase());
  if (v.classical) eps.push("CV " + String(v.classical).toUpperCase());
  set("vEP", eps.length ? eps.join(" · ") : "—");
  set("vModels", neural && neural.models && neural.models.length ? neural.models.join(", ") : "—");
  set("vWarm", neural && neural.warmupMs != null ? neural.warmupMs + " ms" : "—");

  // Detection count (summed across models this pass) + latest vision phase time.
  const perModel = (neural && neural.perModel) || [];
  const detCount = perModel.reduce((a, m) => a + (m.count || 0), 0);
  set("vDet", perModel.length ? String(detCount) : "—");
  const phases = (state.telemetry && state.telemetry.phases) || [];
  const lastPh = phases[phases.length - 1];
  set("vLast", lastPh ? fmtMs(lastPh.vision) : "—");

  // WebGPU adapter identity (Seam B) — render only the fields the browser exposed.
  const ga = v.gpuAdapter;
  const aEl = $("vAdapter");
  if (ga && (ga.vendor || ga.architecture || ga.device || ga.description)) {
    const parts = [];
    if (ga.vendor) parts.push(`<b>${esc(ga.vendor)}</b>`);
    if (ga.architecture) parts.push(esc(ga.architecture));
    if (ga.device) parts.push(esc(ga.device));
    if (ga.description) parts.push(esc(ga.description));
    aEl.innerHTML = "WebGPU adapter — " + parts.join(" · ");
    aEl.hidden = false;
  } else aEl.hidden = true;

  // Per-model timing table (Seam A)
  const wrap = $("vPerModelWrap");
  if (perModel.length) {
    $("vPerModel").querySelector("tbody").innerHTML = perModel.map((m) =>
      `<tr><td>${esc(m.id || "?")}</td><td>${esc((m.ep || "—").toString().toUpperCase())}</td>` +
      `<td class="n">${m.ms != null ? m.ms : "—"}</td><td class="n">${m.count != null ? m.count : "—"}</td></tr>`).join("");
    wrap.hidden = false;
  } else wrap.hidden = true;
}

// ---- Zone 2: live proceedings ------------------------------------------
function renderLog(log) {
  const el = $("log");
  if (!log || !log.length) { el.innerHTML = '<div class="empty">Run a task to stream its proceedings here.</div>'; return; }
  const shown = log.slice(-120);
  // Only the most-recent screenshot renders inline — the image bytes are heavy and the
  // whole log re-renders on every STATE push. The worker strips older shots' bytes, so
  // any earlier shot entry has no dataUrl and collapses to a one-liner here.
  let lastShotIdx = -1;
  for (let i = 0; i < shown.length; i++) {
    if ((shown[i].kind || shown[i].cmd) === "shot" && shown[i].dataUrl) lastShotIdx = i;
  }
  el.innerHTML = shown.map((e, idx) => {
    const kind = e.kind || e.cmd || "?";
    let cls = "", body = "";
    switch (kind) {
      case "start": body = `"${esc(e.task)}"${e.mode ? " [" + esc(e.mode) + "]" : ""}`; cls = "step"; break;
      case "info": body = esc(e.note); cls = "warn"; break;
      case "downgrade": body = `⚠ ${esc(e.reason)}`; cls = "warn"; break;
      case "receipt": body = `detected=${e.receipt.detected} redacted=${e.receipt.redacted} risk=${esc(e.receipt.residual_risk)}`; break;
      case "extract": body = `${e.tableCount} table(s), ${e.rows} row(s) — masked ${e.masked ? e.masked.count : 0} item(s)`; cls = "ok"; break;
      case "calc": body = `${esc(e.label)} = ${esc(e.value)}${e.detail ? "  (" + esc(e.detail) + ")" : ""}`; cls = "calc"; break;
      case "answer": body = esc((e.answer && (e.answer.answer || e.answer.reason)) || "").slice(0, 220); cls = "ok"; break;
      case "plan": body = `[${esc(e.status)}] ${esc(e.reasoning || "")} ${esc(JSON.stringify(e.actions || []))}`; break;
      case "action": body = `${esc(JSON.stringify(e.action))} → ${esc(JSON.stringify((e.result && e.result.result) || e.result))}`; break;
      case "rejected": body = `⛔ ${esc(e.reason)}`; cls = "err"; break;
      case "error": body = `❌ ${esc(e.error)}`; cls = "err"; break;
      case "abort": case "need_user": body = esc(e.reasoning || ""); cls = "warn"; break;
      case "shot": {
        // The captured/redacted frame, shown inline with an accurate egress badge:
        // query mode → LOCAL ONLY (never sent); action mode → the redacted composite.
        const badgeCls = e.transmitted ? "badge-sent" : "badge-local";
        const badge = esc(e.badge || (e.transmitted ? "SANITIZED — SENT" : "LOCAL ONLY — NOT TRANSMITTED"));
        if (idx === lastShotIdx && e.dataUrl) {
          return `<div class="l shot"><div class="shot-head"><span class="k">shot</span> <span class="${badgeCls}">${badge}</span> ${esc(e.label || "")}</div>`
            + `<div class="log-shot"><img src="${e.dataUrl}" alt="${esc(e.label || "screenshot")}" /></div>`
            + (e.note ? `<div class="shot-cap">${esc(e.note)}</div>` : "") + `</div>`;
        }
        body = `<span class="${badgeCls}">${badge}</span> ${esc(e.label || "screenshot")} <span class="t">(latest shown below)</span>`;
        break;
      }
      case "done": body = "✓"; cls = "ok"; break;
      case "stopped": body = `@ step ${e.step}`; break;
      default: body = esc(JSON.stringify(e)).slice(0, 200);
    }
    return `<div class="l ${cls}"><span class="k">${esc(kind)}</span> ${body}</div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

// ---- Zone 3: answer / result -------------------------------------------
function renderAnswer(state) {
  const el = $("answer");
  const mode = state.mode;

  if (mode === "query" && state.answer) {
    const a = state.answer;
    if (a.blocked) {
      el.innerHTML = `<div class="card blocked"><h3>🛑 Fail-closed — nothing was sent</h3>
        <div class="answer-q">"${esc(a.query)}"</div>
        <div class="answer-lead">${esc(a.reason || "Residual sensitive data was detected; the request was refused.")}</div>
        ${maskedChips(a.masked)}</div>`;
      return;
    }
    const cur = (String(a.answer || "").match(/[₹$€£¥]/) || [""])[0];
    const money = !!a.metric;
    const groups = a.groups || [];
    let bd = "";
    if (groups.length) {
      const maxV = Math.max(1, ...groups.map((g) => money ? Math.abs(g.sum || 0) : (g.count || 0)));
      bd = `<div class="card"><h3>Breakdown${a.dimension ? " by " + esc(a.dimension) : ""}</h3>` +
        groups.map((g) => {
          const val = money ? Math.abs(g.sum || 0) : (g.count || 0);
          const w = Math.max(2, (val / maxV) * 100);
          const right = money ? fmtMoney(cur, g.sum) : String(g.count);
          const sub = money ? `n=${g.count} · avg ${fmtMoney(cur, g.avg)} · ${fmtMoney(cur, g.min)}–${fmtMoney(cur, g.max)}` : "";
          return `<div class="grp"><div class="grp-top"><span class="grp-key">${esc(g.key)}</span><span class="grp-sum">${right}</span></div>
            <div class="grp-bar"><span style="width:${w}%"></span></div>${sub ? `<div class="grp-sub">${sub}</div>` : ""}</div>`;
        }).join("") + totalsRow(a, cur, money) + "</div>";
    }
    const meta = [];
    if (a.metric) meta.push(`<span class="tagchip">metric: ${esc(a.metric)}</span>`);
    if (a.dimension) meta.push(`<span class="tagchip">group by: ${esc(a.dimension)}</span>`);
    if (a.date_range && (a.date_range.min || a.date_range.max)) meta.push(`<span class="tagchip dim">${esc(a.date_range.min || "?")} → ${esc(a.date_range.max || "?")}</span>`);
    meta.push(`<span class="tagchip dim">${a.row_count || 0} record(s)</span>`);
    if (a.confidence != null) meta.push(`<span class="tagchip dim">${Math.round(a.confidence * 100)}% conf</span>`);

    el.innerHTML = `<div class="card"><h3>Answer</h3>
        <div class="answer-q">"${esc(a.query)}"</div>
        <div class="answer-lead">${esc(a.answer)}</div>
        <div class="metaline">${meta.join("")}</div>
        ${maskedChips(a.masked)}</div>${bd}`;
    return;
  }

  if (mode === "action") {
    const r = state.receipts && state.receipts[state.receipts.length - 1];
    const lastPlan = [...(state.log || [])].reverse().find((e) => e.kind === "plan");
    if (!r && !lastPlan) { el.innerHTML = '<div class="empty">Action running… results will appear here.</div>'; return; }
    let h = "";
    if (lastPlan) {
      const st = lastPlan.status || "continue";
      const cls = st === "done" ? "ok" : (st === "abort" || st === "need_user") ? "bad" : "warn";
      h += `<div class="card"><h3>Latest reasoning</h3>
        <div class="answer-lead">${esc(lastPlan.reasoning || "(no reasoning provided)")}</div>
        <div class="metaline"><span class="pill ${cls}">${esc(st)}</span>
        <span class="tagchip dim">step ${lastPlan.step || state.step || 0}</span></div></div>`;
    }
    if (r) {
      h += `<div class="card"><h3>Privacy receipt (latest step)</h3>
        <div class="grp-sub" style="font-size:12px">PII detected <b>${r.detected}</b> · redacted <b>${r.redacted}</b> ·
        screenshot ${r.send_screenshot ? '<span class="pill ok">sent (redacted)</span>' : '<span class="pill warn">text-only</span>'} ·
        risk ${esc(r.residual_risk)}</div>${maskedChips({ categories: r.categories, count: r.detected })}</div>`;
    }
    el.innerHTML = h;
    return;
  }

  el.innerHTML = '<div class="empty">No result yet. Ask a question (Summarize) or run an action (Act).</div>';
}

function totalsRow(a, cur, money) {
  const t = a.totals;
  if (!t) return "";
  const right = money ? fmtMoney(cur, t.sum) : String(t.count);
  const sub = money ? `n=${t.count} · avg ${fmtMoney(cur, t.avg)}` : `${t.count} record(s)`;
  return `<div class="totals"><div><b>TOTAL</b><div class="grp-sub">${sub}</div></div><span class="grp-sum">${right}</span></div>`;
}

function maskedChips(masked) {
  if (!masked || !masked.categories || !Object.keys(masked.categories).length) return "";
  const chips = Object.entries(masked.categories).map(([k, v]) => `<span class="tok">${esc(k)} ×${v}</span>`).join(" ");
  return `<div class="metaline" style="margin-top:9px"><span class="grp-sub">masked on-device:</span> ${chips}</div>`;
}

// ---- Zone 4: privacy audit / demo view ---------------------------------
const EVMAP = {
  pii_detected: "Local PII detection",
  redaction_applied: "Local redaction",
  screenshot_sanitized: "Screenshot handled locally",
  payload_sanitized: "Payload sanitized",
  server_request: "Sent to server",
  server_response: "Server response",
  local_action: "Local action executed",
};

let lastAuditKey = null;

function renderAudit(state) {
  const el = $("audit");
  const audit = state.audit;
  const alog = state.auditLog || [];
  if (!audit && !alog.length) {
    el.innerHTML = '<div class="empty">The privacy audit populates once a task runs — it shows exactly what stayed local and what left the browser.</div>';
    lastAuditKey = null;
    return;
  }

  const stream = stagesHtml(alog, state) + timelineHtml(alog);
  // Rebuild the (heavy, image-bearing) snapshot only when the audit identity changes,
  // so the live event stream can refresh without re-loading the screenshot each tick.
  const key = audit ? "a" + audit.generatedAt : "log" + alog.length;
  if (key !== lastAuditKey) {
    lastAuditKey = key;
    el.innerHTML = auditHead(audit, state) + '<div id="auditStream"></div>' + (audit ? snapshotHtml(audit) : "");
    $("auditStream").innerHTML = stream;
    if (audit && audit.original && audit.original.dataUrl) wireBoxes(audit);
  } else {
    const s = $("auditStream"); if (s) s.innerHTML = stream;
  }
}

function auditHead(audit, state) {
  const mode = (audit && audit.mode) || state.mode || "idle";
  return `<div class="audit-head"><div><h2>Privacy audit</h2>
    <div class="sub">what stayed local vs. what left the browser</div></div>
    <span class="chip ${mode}">${esc(mode)}</span></div>`;
}

function stagesHtml(alog, state) {
  const has = (e) => alog.some((x) => x.event === e);
  const blocked = alog.some((x) => x.event === "payload_sanitized" && x.blocked);
  const rows = [
    ["Local detection", has("pii_detected")],
    ["Local redaction", has("redaction_applied")],
    ["Sanitized payload", has("payload_sanitized") && !blocked, blocked],
    ["Server", has("server_request")],
    ["Response", has("server_response")],
  ];
  if (state.mode === "action" || has("local_action")) rows.push(["Local action", has("local_action")]);
  return `<div class="stages">` + rows.map(([label, on, isBlocked]) =>
    `<span class="stage ${isBlocked ? "blocked" : on ? "on" : ""}">${esc(label)}${isBlocked ? " ✕" : on ? " ✓" : ""}</span>`).join("") + `</div>`;
}

function timelineHtml(alog) {
  if (!alog.length) return "";
  const items = alog.slice(-40).map((ev) => {
    const label = EVMAP[ev.event] || ev.event;
    const blocked = ev.blocked ? " blocked" : "";
    return `<li class="tl${blocked}"><div class="tl-ev">${esc(label)}</div>${metaChips(ev)}</li>`;
  }).join("");
  return `<div class="card"><h3>Timeline — local detection → redaction → sanitized payload → server</h3>
    <ul class="timeline">${items}</ul></div>`;
}

// Render an audit event's SAFE metadata (counts, category maps, booleans, endpoints).
// The worker only ever puts safe metadata here — never a raw value — but we still
// only stringify primitives and shallow count-maps, never arbitrary nested objects.
function metaChips(ev) {
  const out = [];
  for (const [k, val] of Object.entries(ev)) {
    if (k === "t" || k === "event") continue;
    if (val == null) continue;
    if (k === "categories" && typeof val === "object") {
      for (const [cat, n] of Object.entries(val)) out.push(`<span class="mchip">${esc(cat)} ×${n}</span>`);
    } else if (typeof val === "boolean") {
      out.push(`<span class="mchip${(k === "blocked" && val) ? " warnc" : ""}">${esc(k)}: ${val ? "yes" : "no"}</span>`);
    } else if (typeof val === "object") {
      continue; // skip nested structures — never risk stringifying an unexpected value
    } else {
      out.push(`<span class="mchip">${esc(k)}: ${esc(val)}</span>`);
    }
  }
  return out.length ? `<div class="tl-meta">${out.join("")}</div>` : "";
}

function snapshotHtml(a) {
  let h = "";

  // BEFORE SERVER — original capture, clearly marked local-only, with detection overlay.
  if (a.original && a.original.dataUrl) {
    h += `<div class="card"><h3>Before server — local capture</h3>
      <div class="shot-note"><span class="badge-local">LOCAL ONLY — NOT TRANSMITTED</span></div>
      <div class="shot-wrap"><img id="shotImg" src="${a.original.dataUrl}" alt="local capture (never sent)" />
        <div class="boxes" id="shotBoxes"></div></div>
      <div class="legend">
        <span><span class="swatch" style="background:#a855f7"></span>vision detection</span>
        <span><span class="swatch" style="background:#f59e0b"></span>redaction</span>
      </div></div>`;
  }

  // Detected regions (vision + redaction boxes) as a table.
  h += regionsHtml(a);

  // Record-masking summary (query mode): identifier columns dropped to tokens.
  if (a.recordMasking && (a.recordMasking.count || Object.keys(a.recordMasking.categories || {}).length)) {
    const rm = a.recordMasking;
    const chips = Object.entries(rm.categories || {}).map(([k, v]) => `<span class="tok">${esc(k)} ×${v}</span>`).join(" ");
    h += `<div class="card"><h3>Records masked on-device (${rm.count})</h3>
      <div class="grp-sub" style="font-size:12px">Identifier columns dropped to <span class="tok">&lt;CATEGORY_n&gt;</span> tokens; inline PII tokenized. Source: ${esc(rm.source || "DOM+Regex")}.</div>
      <div class="metaline" style="margin-top:8px">${chips || '<span class="grp-sub">none</span>'}</div></div>`;
  }

  // AFTER REDACTION — what (if anything) is eligible to transmit.
  h += `<div class="card"><h3>After redaction — eligible for transmission</h3>`;
  if (a.redacted && a.redacted.dataUrl) {
    h += `<div class="shot-note"><span class="badge-sent">SANITIZED — eligible for transmission</span></div>
      <div class="shot-wrap"><img src="${a.redacted.dataUrl}" alt="redacted, sanitized capture" /></div>`;
  } else {
    const why = a.transmission && a.transmission.endpoint === "/query"
      ? "Query mode transmits no image — only structured, masked data."
      : "Screenshot withheld (fail-closed / text-only).";
    h += `<div class="grp-sub" style="font-size:12px">🚫 No image leaves the browser. ${esc(why)}</div>`;
  }
  h += `</div>`;

  // SANITIZED PAYLOAD — the exact JSON that left (or would have left) the browser.
  const pv = a.payloadPreview || {};
  h += `<div class="card"><h3>Sanitized payload — exact JSON sent</h3>
    <div class="sent-line">POST <b>${esc((a.transmission && a.transmission.endpoint) || "")}</b> ·
      screenshot: <b>${(a.transmission && a.transmission.screenshotSent) ? "included (redacted)" : "not sent"}</b></div>
    <pre class="code">${highlightJson(JSON.stringify(pv, null, 2))}</pre>
    <div class="sent-line">Tokens like <span class="tok">&lt;EMAIL_1&gt;</span> stand in for values — no raw value appears above.</div></div>`;

  // FORBIDDEN FROM EGRESS — the guarantee, stated verbatim.
  if (a.forbidden && a.forbidden.length) {
    h += `<div class="card"><h3>Never leaves this browser</h3><ul class="forbidden">` +
      a.forbidden.map((f) => `<li><span class="no-egress">✕</span> ${esc(f)}</li>`).join("") + `</ul></div>`;
  }
  return h;
}

function regionsHtml(a) {
  const rows = [];
  for (const d of a.visionDetections || []) rows.push({ category: d.category, source: d.source || "Vision", confidence: d.confidence, method: "detect", token: "" });
  for (const r of a.redactions || []) rows.push({ category: r.category, source: r.source || "Fusion", confidence: r.confidence, method: r.method, token: r.token });
  if (!rows.length) return "";
  return `<div class="card"><h3>Detected sensitive regions (${rows.length})</h3>
    <table class="regions"><thead><tr><th>Category</th><th>Source</th><th>Conf.</th><th>Method</th><th>Token</th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td>${esc(r.category || "?")}</td>
      <td><span class="src ${esc(r.source)}">${esc(r.source)}</span></td>
      <td>${r.confidence != null ? Math.round(r.confidence * 100) + "%" : "—"}</td>
      <td>${esc(r.method || "—")}</td>
      <td>${r.token ? `<span class="tok">${esc(r.token)}</span>` : "—"}</td></tr>`).join("") +
    `</tbody></table></div>`;
}

// Highlight JSON keys and <CATEGORY_n> tokens in the sanitized-payload code block.
function highlightJson(json) {
  let h = escCode(json);
  h = h.replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="ck">$1</span>$2'); // keys
  h = h.replace(/&lt;[A-Z0-9_]+&gt;/g, (m) => `<span class="ctok">${m}</span>`); // tokens
  return h;
}

// Draw detection/redaction boxes over the local-only screenshot. The image is device
// pixels (captureVisibleTab); the boxes are CSS-px viewport coords. Convert: a box at
// CSS x maps to device x = x·dpr, expressed as a % of the image's natural width — so
// the overlay is correct at any rendered size.
function wireBoxes(audit) {
  const img = $("shotImg");
  if (!img) return;
  const draw = () => drawBoxes(img, audit);
  if (img.complete && img.naturalWidth) draw();
  else img.addEventListener("load", draw, { once: true });
}

function drawBoxes(img, audit) {
  const host = $("shotBoxes");
  if (!host) return;
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return;
  const dpr = audit.dpr || 1;
  const items = [];
  for (const d of audit.visionDetections || []) items.push({ bbox: d.bbox, label: d.category, cls: (d.source === "Fusion") ? "fusion" : "vision" });
  for (const r of audit.redactions || []) items.push({ bbox: r.bbox, label: r.token || r.category, cls: "redact" });
  host.innerHTML = items.map((it) => {
    const b = it.bbox || [];
    if (b.length < 4) return "";
    const L = (b[0] * dpr) / nw * 100, T = (b[1] * dpr) / nh * 100;
    const W = (b[2] * dpr) / nw * 100, H = (b[3] * dpr) / nh * 100;
    return `<div class="bx ${it.cls}" style="left:${L}%;top:${T}%;width:${W}%;height:${H}%"><i>${esc(it.label || "region")}</i></div>`;
  }).join("");
}

// ---- tabs + mode toggle -------------------------------------------------
let currentTab = "proc";
function setTab(name) {
  currentTab = name;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("on", p.id === "tab-" + name));
  if (name === "answer") $("answerDot").hidden = true;
  if (name === "audit") $("auditDot").hidden = true;
}

let selectedMode = "auto";
function setupControls() {
  document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  document.querySelectorAll("#modeToggle button").forEach((b) => (b.onclick = () => {
    selectedMode = b.dataset.mode;
    document.querySelectorAll("#modeToggle button").forEach((x) => x.classList.toggle("on", x === b));
  }));

  $("run").onclick = async () => {
    const task = $("task").value.trim();
    if (!task) return;
    const tabId = await activeTabId();
    ext.runtime.sendMessage({ cmd: "START_TASK", task, tabId, mode: selectedMode });
  };
  $("stop").onclick = () => ext.runtime.sendMessage({ cmd: "STOP_TASK" });
  $("task").addEventListener("keydown", (e) => { if (e.key === "Enter") $("run").click(); });
  $("saveCfg").onclick = () => ext.storage.local.set({ serverUrl: $("serverUrl").value.trim() });
}

// ---- orchestration ------------------------------------------------------
function renderMode(state) {
  const m = state.mode || "idle";
  const chip = $("modeChip");
  chip.textContent = m; chip.className = "chip " + (["query", "action"].includes(m) ? m : "idle");
  $("run").disabled = !!state.running;
  $("stop").disabled = !state.running;
  // Tab hints: dot when a tab has fresh content and isn't the one being viewed.
  const hasAnswer = !!(state.answer || (state.mode === "action" && state.receipts && state.receipts.length));
  const hasAudit = !!(state.audit || (state.auditLog && state.auditLog.length));
  $("answerDot").hidden = !(hasAnswer && currentTab !== "answer");
  $("auditDot").hidden = !(hasAudit && currentTab !== "audit");
}

let prevRunning = false;
function maybeAutoSwitch(state) {
  const r = !!state.running;
  if (r && !prevRunning) setTab("proc");                 // a run started → watch it stream
  else if (!r && prevRunning && state.mode === "query" && state.answer) setTab("answer"); // query done → show it
  prevRunning = r;
}

function renderState(state) {
  if (!state) return;
  renderMode(state);
  renderVision(state);
  renderLog(state.log);
  renderAnswer(state);
  renderAudit(state);
  maybeAutoSwitch(state);
}

setupControls();
ext.runtime.onMessage.addListener((msg) => { if (msg.cmd === "STATE") renderState(msg.state); });

(async () => {
  const { serverUrl } = await ext.storage.local.get("serverUrl");
  $("serverUrl").value = serverUrl || "http://localhost:8000";
  ext.runtime.sendMessage({ cmd: "GET_STATE" }, (res) => res && res.ok && renderState(res.state));
})();
