/* popup.js — dashboard: launches tasks and renders the privacy receipt + live log. */
const $ = (id) => document.getElementById(id);
// Cross-browser shim (Firefox `browser` / Chromium `chrome`).
const ext = globalThis.browser || globalThis.chrome;

async function activeTabId() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

function renderReceipt(r) {
  if (!r) return;
  $("rDetected").textContent = r.detected;
  $("rRedacted").textContent = r.redacted;
  const shot = $("rShot");
  shot.innerHTML = r.send_screenshot
    ? '<span class="pill ok">yes</span>'
    : '<span class="pill warn">text-only (fail-closed)</span>';
  const risk = $("rRisk");
  const cls = r.residual_risk === "minimal" || r.residual_risk === "low" ? "ok"
    : r.residual_risk === "medium" ? "warn" : "bad";
  risk.innerHTML = `<span class="pill ${cls}">${r.residual_risk}</span>`;
  $("rCats").innerHTML = Object.entries(r.categories || {})
    .map(([k, v]) => `<span>${k}: ${v}</span>`).join("");
}

function renderLog(log) {
  const el = $("log");
  el.innerHTML = (log || []).slice(-60).map((e) => {
    let line = `<span class="k">${e.kind || e.cmd}</span> `;
    if (e.kind === "plan") line += `[${e.status}] ${e.reasoning || ""} ${JSON.stringify(e.actions || [])}`;
    else if (e.kind === "action") line += `${JSON.stringify(e.action)} → ${JSON.stringify(e.result && e.result.result || e.result)}`;
    else if (e.kind === "receipt") line += `detected=${e.receipt.detected} redacted=${e.receipt.redacted} risk=${e.receipt.residual_risk}`;
    else if (e.kind === "rejected") line += `⛔ ${e.reason}`;
    else if (e.kind === "error") line += `❌ ${e.error}`;
    else line += JSON.stringify(e).slice(0, 200);
    return `<div class="l">${line}</div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

function renderState(state) {
  if (!state) return;
  const lastReceipt = state.receipts && state.receipts[state.receipts.length - 1];
  renderReceipt(lastReceipt);
  renderLog(state.log);
}

$("run").onclick = async () => {
  const task = $("task").value.trim();
  if (!task) return;
  const tabId = await activeTabId();
  ext.runtime.sendMessage({ cmd: "START_TASK", task, tabId });
};
$("stop").onclick = () => ext.runtime.sendMessage({ cmd: "STOP_TASK" });
$("saveCfg").onclick = () => ext.storage.local.set({ serverUrl: $("serverUrl").value.trim() });

ext.runtime.onMessage.addListener((msg) => { if (msg.cmd === "STATE") renderState(msg.state); });

(async () => {
  const { serverUrl } = await ext.storage.local.get("serverUrl");
  $("serverUrl").value = serverUrl || "http://localhost:8000";
  ext.runtime.sendMessage({ cmd: "GET_STATE" }, (res) => res && res.ok && renderState(res.state));
})();
