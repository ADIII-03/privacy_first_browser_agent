/*
 * content.js — In-page perception responder + hardened action executor.
 *
 * Runs in the page's isolated world. It exposes two operations to the background
 * orchestrator and NOTHING else:
 *   PERCEIVE  -> build the sanitized context (no raw values leave here)
 *   EXECUTE   -> run ONE validated action, then verify it took effect
 *
 * SECURITY POSTURE:
 *  - The server's response is UNTRUSTED. Every action is checked against a fixed
 *    allowlist and must reference an id that existed in the context we just sent.
 *  - We never eval, never inject server-provided HTML/JS, never follow a
 *    server-provided navigation off-origin without user approval.
 *  - Destructive intent (Transfer/Pay/Delete/...) is gated by a human click,
 *    enforced HERE regardless of what the server claims.
 *  - Sensitive fields are filled ONLY from the local vault (fill_local); the
 *    server can never supply a value for them.
 */
(function () {
  const PBA = self.PBA;
  const A = PBA.ACTIONS;
  // Cross-browser shim (Firefox `browser` / Chromium `chrome`).
  const ext = globalThis.browser || globalThis.chrome;

  // ---- local secret vault (never transmitted) ---------------------------
  // Demo values; in production back this with chrome.storage + OS keychain and
  // require per-use user consent. Keys are referenced by fill_local.source.
  const VAULT = {
    email: "user@example.com",
    phone: "9876543210",
    full_name: "A. User",
  };
  // Merge any user-configured vault entries from local storage over the demo
  // defaults. The values live ONLY on the device and are referenced by key —
  // they are never placed in the payload, only filled into fields via fill_local.
  try {
    ext.storage && ext.storage.local && ext.storage.local.get("vault").then((r) => {
      if (r && r.vault && typeof r.vault === "object") Object.assign(VAULT, r.vault);
    }).catch(() => {});
  } catch (_) {}
  let lastVaultKeyUsed = null;

  // ---- helpers -----------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function confirmDestructive(label) {
    // Minimal, dependency-free confirmation. Swap for the overlay UI in overlay.css.
    return window.confirm(
      `⚠ Privacy Browser Agent wants to perform a sensitive action:\n\n` +
      `“${label || "action"}”\n\nAllow this one action?`
    );
  }

  function actionSignature(a) {
    return [a.type, a.target_id, a.text || "", a.option || "", a.source || ""].join("|");
  }

  // ---- validation: the server is untrusted -------------------------------
  function validate(action) {
    if (!action || typeof action !== "object") return "not_an_object";
    if (!Object.values(A).includes(action.type)) return "unknown_action_type";

    const needsTarget = [A.CLICK, A.TYPE, A.FILL_LOCAL, A.SELECT, A.SCROLL_TO];
    if (needsTarget.includes(action.type)) {
      if (typeof action.target_id !== "number") return "missing_target_id";
      if (!PBA.dom.getElement(action.target_id)) return "target_not_in_current_context";
    }
    if (action.type === A.TYPE) {
      const el = PBA.dom.getElement(action.target_id);
      // Refuse to type literal text into a sensitive field — that path must be fill_local.
      if (el && el.__pbaSensitive) return "type_into_sensitive_field_forbidden";
      if (typeof action.text !== "string") return "type_requires_text";
    }
    if (action.type === A.FILL_LOCAL) {
      if (!action.source || !(action.source in VAULT)) return "unknown_vault_key";
    }
    if (action.type === A.NAVIGATE) {
      try {
        const u = new URL(action.url, location.href);
        if (u.origin !== location.origin && !action.user_approved) return "cross_origin_navigation_blocked";
      } catch (_) { return "invalid_url"; }
    }
    return null; // valid
  }

  // ---- execution ---------------------------------------------------------
  async function execute(action) {
    const el = action.target_id != null ? PBA.dom.getElement(action.target_id) : null;
    if (el) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await sleep(60);

    switch (action.type) {
      case A.CLICK: {
        const label = PBA.dom.accessibleLabel(el);
        const destructive = PBA.DESTRUCTIVE_HINTS.some((h) => (label || "").toLowerCase().includes(h));
        if (destructive && !confirmDestructive(label)) return { ok: false, reason: "user_declined" };
        // dispatch a realistic event sequence for framework-driven UIs
        ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) =>
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
        return { ok: true, observation: "clicked" };
      }
      case A.TYPE: {
        el.focus();
        setNativeValue(el, action.text);
        return { ok: true, observation: "typed_literal" };
      }
      case A.FILL_LOCAL: {
        el.focus();
        lastVaultKeyUsed = action.source;
        setNativeValue(el, VAULT[action.source]); // value stays local
        return { ok: true, observation: "filled_from_vault", source: action.source };
      }
      case A.SELECT: {
        const opt = Array.from(el.options || []).find(
          (o) => o.label === action.option || o.value === action.option || o.text === action.option);
        if (!opt) return { ok: false, reason: "option_not_found" };
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, observation: "selected" };
      }
      case A.SCROLL: {
        const dy = action.amount || Math.round(innerHeight * 0.8);
        window.scrollBy({ top: action.direction === "up" ? -dy : dy, behavior: "instant" });
        return { ok: true, observation: "scrolled" };
      }
      case A.SCROLL_TO: {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        return { ok: true, observation: "scrolled_to" };
      }
      case A.NAVIGATE: {
        location.assign(new URL(action.url, location.href).href);
        return { ok: true, observation: "navigating" };
      }
      case A.WAIT: {
        await sleep(Math.min(action.ms || 500, 5000));
        return { ok: true, observation: "waited" };
      }
      default:
        return { ok: false, reason: "unhandled" };
    }
  }

  // React/Vue-safe value setter (bypasses framework value tracking).
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Lightweight post-condition check so the loop can detect no-ops and recover.
  function snapshotState() {
    return { url: location.href, scrollY: Math.round(scrollY), active: document.activeElement && document.activeElement.__pbaId };
  }

  // ---- message bridge ----------------------------------------------------
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.cmd === "PERCEIVE") {
          const built = PBA.perception.buildContext({
            task: msg.task, sessionId: msg.sessionId, step: msg.step,
            visionDetections: msg.visionDetections || [], visionReady: msg.visionReady,
          });
          // tag live sensitive fields so the executor can refuse literal typing
          for (const e of built.payload.elements) {
            const node = PBA.dom.getElement(e.id);
            if (node) node.__pbaSensitive = e.sensitive;
          }
          sendResponse({ ok: true, ...built });
        } else if (msg.cmd === "EXECUTE") {
          const err = validate(msg.action);
          if (err) { sendResponse({ ok: false, rejected: err }); return; }
          const before = snapshotState();
          const res = await execute(msg.action);
          await sleep(120);
          const after = snapshotState();
          const changed = JSON.stringify(before) !== JSON.stringify(after);
          sendResponse({ ok: res.ok, result: res, changed, signature: actionSignature(msg.action) });
        } else if (msg.cmd === "VIEWPORT") {
          // Device-pixel ratio + inner size, so the worker can map the device-pixel
          // screenshot into the CSS-pixel space the DOM signals use.
          sendResponse({ ok: true, dpr: devicePixelRatio || 1, w: innerWidth, h: innerHeight });
        } else if (msg.cmd === "PING") {
          sendResponse({ ok: true, ready: true, dpr: devicePixelRatio || 1 });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  });
})();
