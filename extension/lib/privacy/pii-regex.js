/*
 * pii-regex.js — Deterministic, high-precision PII detectors.
 *
 * This is the cheapest and most precise signal in the fusion pipeline: structured
 * identifiers have rigid formats and (crucially) CHECKSUMS. We exploit checksums
 * (Luhn for cards, Verhoeff for Aadhaar) to keep precision high without hurting
 * recall — a 12-digit number that fails Verhoeff is almost certainly NOT an Aadhaar.
 *
 * Design notes:
 *  - Every detector returns {type, value, index, length, confidence}. The raw
 *    `value` NEVER leaves the device; it is used locally to compute a bbox and is
 *    then replaced by a <CATEGORY_n> token.
 *  - Works in the browser (attaches to self.PBA.pii) AND in Node (module.exports)
 *    so the exact same code is what the eval harness scores. No drift between
 *    "what we ship" and "what we benchmark".
 */
(function () {
  // Works in browser (self===globalThis) and in Node (eval harness). protocol.js
  // supplies the full frozen PII enum in the browser; provide a fallback for Node.
  const G = (typeof globalThis !== "undefined") ? globalThis : this;
  G.PBA = G.PBA || {};
  if (!G.PBA.PII) {
    G.PBA.PII = { PASSWORD:"password", OTP:"otp", API_KEY:"api_key",
      CREDIT_CARD:"credit_card", BANK_ACCOUNT:"bank_account", AADHAAR:"aadhaar",
      PAN:"pan", UPI:"upi", EMAIL:"email", PHONE:"phone", PERSON:"person",
      ADDRESS:"address", DOB:"dob", FACE:"face", SIGNATURE:"signature",
      IP:"ip", GENERIC_SECRET:"generic_secret" };
  }
  // ---- checksum helpers --------------------------------------------------

  // Luhn (mod-10) — credit/debit cards, some bank/IMEI numbers.
  function luhnValid(digits) {
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (d < 0 || d > 9) return false;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }

  // Verhoeff — the checksum UIDAI uses for the 12-digit Aadhaar number.
  const V_D = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0],
  ];
  const V_P = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
  ];
  function verhoeffValid(digits) {
    let c = 0;
    const rev = digits.split("").reverse();
    for (let i = 0; i < rev.length; i++) {
      const n = rev[i].charCodeAt(0) - 48;
      if (n < 0 || n > 9) return false;
      c = V_D[c][V_P[i % 8][n]];
    }
    return c === 0;
  }

  // ---- patterns ----------------------------------------------------------
  // Ordered by specificity: more specific detectors run first so a card number
  // isn't mis-tagged as a generic phone, etc.

  const P = PBA => [
    // Aadhaar: 12 digits, optionally space/hyphen grouped 4-4-4, Verhoeff-checked.
    {
      type: PBA.PII.AADHAAR,
      re: /\b([2-9]\d{3}[ -]?\d{4}[ -]?\d{4})\b/g,
      validate: (m) => { const d = m.replace(/[ -]/g, ""); return d.length === 12 && verhoeffValid(d); },
      confidence: 0.98,
    },
    // PAN: 5 letters, 4 digits, 1 letter. 4th char is holder-type; validate lightly.
    {
      type: PBA.PII.PAN,
      re: /\b([A-Z]{5}[0-9]{4}[A-Z])\b/g,
      validate: (m) => /[PCHFATBLJGE]/.test(m[3]),
      confidence: 0.95,
    },
    // Credit/debit card: 13–19 digits with optional separators, Luhn-checked.
    {
      type: PBA.PII.CREDIT_CARD,
      re: /\b(?:\d[ -]?){13,19}\b/g,
      validate: (m) => { const d = m.replace(/[ -]/g, ""); return d.length >= 13 && d.length <= 19 && luhnValid(d); },
      confidence: 0.9,
    },
    // UPI VPA: handle@bank (not an email — bank handles have no TLD dot after @).
    {
      type: PBA.PII.UPI,
      re: /\b([a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}(?:\.[a-zA-Z]{2,64})*)\b/g,
      validate: (m, all) => !/\.[a-zA-Z]{2,}$/.test(all), // exclude things ending in a TLD (those are emails)
      confidence: 0.75,
    },
    // Email.
    {
      type: PBA.PII.EMAIL,
      re: /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
      confidence: 0.95,
    },
    // Indian mobile (+91 optional) or generic 10-digit starting 6-9.
    {
      type: PBA.PII.PHONE,
      re: /(\+?91[ -]?)?\b([6-9]\d{9})\b/g,
      confidence: 0.8,
    },
    // OTP: "OTP"/"code" nearby a 4–8 digit number (context-gated to protect precision).
    {
      type: PBA.PII.OTP,
      re: /\b(\d{4,8})\b/g,
      contextRe: /(otp|one[- ]?time|verification|passcode|code)/i,
      confidence: 0.7,
    },
    // API keys / bearer tokens / long high-entropy secrets.
    {
      type: PBA.PII.API_KEY,
      re: /\b((?:sk|pk|rk|api|key|ghp|xox[bap]|AKIA)[-_a-zA-Z0-9]{12,}|[A-Za-z0-9_\-]{32,})\b/g,
      validate: (m) => shannonEntropy(m) > 3.2,
      confidence: 0.7,
    },
    // IPv4.
    {
      type: PBA.PII.IP,
      re: /\b((?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d))\b/g,
      confidence: 0.6,
    },
  ];

  function shannonEntropy(s) {
    const freq = {};
    for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
    let e = 0;
    for (const k in freq) { const p = freq[k] / s.length; e -= p * Math.log2(p); }
    return e;
  }

  /**
   * Scan a block of text and return all PII matches.
   * @param {string} text
   * @param {object} opts { window: chars of context to check for context-gated types }
   * @returns {Array<{type,value,index,length,confidence}>}
   */
  function scan(text, opts) {
    opts = opts || {};
    const win = opts.window || 40;
    const patterns = P(G.PBA);
    const found = [];
    const claimed = []; // [start,end) ranges already taken by higher-specificity detectors

    const overlaps = (s, e) => claimed.some(([a, b]) => s < b && e > a);

    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text)) !== null) {
        const value = (m[2] || m[1] || m[0]).trim();
        const idx = m.index + m[0].indexOf(value);
        const end = idx + value.length;
        if (overlaps(idx, end)) continue;
        if (p.validate && !p.validate(value, m[0])) continue;
        if (p.contextRe) {
          const ctx = text.slice(Math.max(0, idx - win), Math.min(text.length, end + win));
          if (!p.contextRe.test(ctx)) continue;
        }
        found.push({ type: p.type, value, index: idx, length: value.length, confidence: p.confidence });
        claimed.push([idx, end]);
      }
    }
    return found.sort((a, b) => a.index - b.index);
  }

  const api = { scan, luhnValid, verhoeffValid, shannonEntropy };

  G.PBA.pii = api; // browser: content-script world; Node: globalThis
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
