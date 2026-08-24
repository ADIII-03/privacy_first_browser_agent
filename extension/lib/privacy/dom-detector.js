/*
 * dom-detector.js — Structural (DOM/ARIA) sensitivity signals.
 *
 * The DOM is the single highest-precision privacy signal we have:
 *   input[type=password]                 -> definitely a secret
 *   autocomplete="cc-number|one-time-code|..." -> declared-sensitive by the site
 *   input[type=email|tel]                -> typed PII
 * These require zero ML and are almost never wrong, so they anchor the fusion layer.
 *
 * We also emit the interactable-element graph (buttons/links/inputs) with stable
 * ids + bounding boxes. That graph is the "map" the server points back into.
 */
(function () {
  const PBA = (self.PBA = self.PBA || {});

  const SENSITIVE_AUTOCOMPLETE = {
    "current-password": PBA.PII.PASSWORD,
    "new-password": PBA.PII.PASSWORD,
    "one-time-code": PBA.PII.OTP,
    "cc-number": PBA.PII.CREDIT_CARD,
    "cc-csc": PBA.PII.CREDIT_CARD,
    "cc-exp": PBA.PII.CREDIT_CARD,
    "tel": PBA.PII.PHONE,
    "tel-national": PBA.PII.PHONE,
    "email": PBA.PII.EMAIL,
    "street-address": PBA.PII.ADDRESS,
    "postal-code": PBA.PII.ADDRESS,
    "bday": PBA.PII.DOB,
    "name": PBA.PII.PERSON,
    "given-name": PBA.PII.PERSON,
    "family-name": PBA.PII.PERSON,
  };

  const INTERACTABLE = "a[href],button,input,select,textarea,[role='button'],[role='link'],[role='textbox'],[role='checkbox'],[role='menuitem'],[onclick],[tabindex]:not([tabindex='-1'])";

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    return "generic";
  }

  function accessibleLabel(el) {
    return (
      el.getAttribute("aria-label") ||
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.getAttribute("value") ||
      (el.innerText || "").trim().slice(0, 80) ||
      (el.getAttribute("title") || "")
    ).trim();
  }

  function isVisible(el, rect) {
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return false;
    return true;
  }

  // Detect the sensitivity of a single field from DOM semantics alone.
  function fieldSensitivity(el) {
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") return null;
    const type = (el.type || "").toLowerCase();
    if (type === "password") return { pii_type: PBA.PII.PASSWORD, confidence: 0.99, source: "dom" };

    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    for (const key in SENSITIVE_AUTOCOMPLETE) {
      if (ac.includes(key)) return { pii_type: SENSITIVE_AUTOCOMPLETE[key], confidence: 0.9, source: "dom" };
    }
    if (type === "email") return { pii_type: PBA.PII.EMAIL, confidence: 0.85, source: "dom" };
    if (type === "tel") return { pii_type: PBA.PII.PHONE, confidence: 0.85, source: "dom" };

    // Heuristic on name/id/label text.
    const hay = (el.name + " " + el.id + " " + accessibleLabel(el)).toLowerCase();
    const map = [
      [/aadhaar|aadhar|uid/, PBA.PII.AADHAAR], [/\bpan\b/, PBA.PII.PAN],
      [/card|cvv|cvc/, PBA.PII.CREDIT_CARD], [/account|acct|ifsc/, PBA.PII.BANK_ACCOUNT],
      [/upi|vpa/, PBA.PII.UPI], [/otp|passcode/, PBA.PII.OTP],
      [/dob|birth/, PBA.PII.DOB], [/address|street|pincode|zip/, PBA.PII.ADDRESS],
      [/api|secret|token/, PBA.PII.API_KEY],
    ];
    for (const [re, t] of map) if (re.test(hay)) return { pii_type: t, confidence: 0.7, source: "dom" };
    return null;
  }

  /**
   * Walk the visible DOM once, producing:
   *   elements[]   — interactable graph with ids + bbox + sensitivity flag
   *   textNodes[]  — visible text runs with their bbox (fed to the regex scanner)
   *   fieldPII[]   — high-confidence field-level PII from DOM semantics
   */
  function scanDOM() {
    const elements = [];
    const textNodes = [];
    const fieldPII = [];
    const index = {}; // id -> live DOM node, used by the executor to act
    let id = 0;

    // interactable graph
    document.querySelectorAll(INTERACTABLE).forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) return;
      const sens = fieldSensitivity(el);
      const descriptor = {
        id: id++,
        role: roleOf(el),
        label: accessibleLabel(el),
        bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        enabled: !el.disabled,
        value_state: el.value ? PBA.VALUE_STATE.FILLED : PBA.VALUE_STATE.EMPTY,
        sensitive: !!sens,
        pii_type: sens ? sens.pii_type : null,
      };
      el.__pbaId = descriptor.id; // back-reference for the executor
      index[descriptor.id] = el;
      elements.push(descriptor);
      if (sens) fieldPII.push({ ...sens, bbox: descriptor.bbox, elementId: descriptor.id });
    });
    PBA.dom._index = index; // refreshed every perceive; ids are per-step

    // visible text runs (for regex + OCR-parity scanning)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (text.length < 3) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.bottom < 0 || rect.top > innerHeight) continue;
      textNodes.push({ text, bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] });
    }

    return { elements, textNodes, fieldPII };
  }

  PBA.dom = { scanDOM, fieldSensitivity, accessibleLabel, _index: {},
    getElement: (id) => (PBA.dom._index || {})[id] || null };
})();
