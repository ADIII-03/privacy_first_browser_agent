/*
 * protocol.js — Shared client/server contract (v1).
 *
 * This file defines the ONLY vocabulary that crosses the network. Keeping it in
 * one place (mirrored by server/schemas.py) is what makes the system auditable:
 * if a value type isn't declared here, it must never be transmitted.
 *
 * Loaded first in the content_scripts list, so it establishes the global
 * namespace `self.PBA` that every other module hangs off of.
 */
(function () {
  const PBA = (self.PBA = self.PBA || {});

  PBA.PROTOCOL_VERSION = "1.0";

  // Categories of sensitive data the privacy layer knows how to detect + redact.
  // The server receives ONLY the category + a stable placeholder token, never the value.
  PBA.PII = Object.freeze({
    PASSWORD: "password",
    OTP: "otp",
    API_KEY: "api_key",
    CREDIT_CARD: "credit_card",
    BANK_ACCOUNT: "bank_account",
    AADHAAR: "aadhaar",
    PAN: "pan",
    UPI: "upi",
    EMAIL: "email",
    PHONE: "phone",
    PERSON: "person",
    ADDRESS: "address",
    DOB: "dob",
    FACE: "face",
    SIGNATURE: "signature",
    ID_DOCUMENT: "id_document", // whole-region redaction (Aadhaar/PAN/passport photos & scans)
    IP: "ip",
    GENERIC_SECRET: "generic_secret",
  });

  // Redaction methods, ordered by strength. Reversible methods (blur/pixelate)
  // are NEVER used for high-sensitivity categories (see policy.js).
  PBA.REDACT = Object.freeze({
    REMOVE: "remove", // element/value dropped entirely from payload
    BLACKOUT: "blackout", // opaque solid fill on pixels (irreversible)
    TOKENIZE: "tokenize", // text replaced with <CATEGORY_n> placeholder
    PIXELATE: "pixelate", // reversible-ish; low sensitivity only
    BLUR: "blur", // reversible-ish; low sensitivity only (e.g. background faces)
    PRESERVE: "preserve", // safe UI element, kept as-is
  });

  // The closed set of actions the server may request. The client validates every
  // incoming action against this list and executes NOTHING else. No eval, ever.
  PBA.ACTIONS = Object.freeze({
    CLICK: "click",
    TYPE: "type", // literal, non-sensitive text (e.g. a search query)
    FILL_LOCAL: "fill_local", // resolve a value from the LOCAL vault by key; server never sees it
    SELECT: "select",
    SCROLL: "scroll",
    SCROLL_TO: "scroll_to",
    NAVIGATE: "navigate", // guarded: same-origin or user-approved only
    WAIT: "wait",
    DONE: "done",
    NEED_USER: "need_user",
    ABORT: "abort",
  });

  // Actions/labels that mutate money, data, or identity require an explicit human
  // click-through regardless of what the server says. The client owns this list.
  PBA.DESTRUCTIVE_HINTS = [
    "transfer", "send money", "pay", "payment", "delete", "remove account",
    "withdraw", "confirm order", "place order", "buy now", "unsubscribe",
    "close account", "deactivate", "wire", "authorize", "sign", "submit payment",
  ];

  PBA.STATUS = Object.freeze({
    CONTINUE: "continue",
    DONE: "done",
    NEED_USER: "need_user",
    ABORT: "abort",
  });

  // Value-state enum: the server learns whether a field is filled, never its content.
  PBA.VALUE_STATE = Object.freeze({
    EMPTY: "empty",
    FILLED: "filled",
    REDACTED: "redacted",
  });

  PBA.newSessionId = function () {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      "sess-" + Math.random().toString(36).slice(2);
  };
})();
