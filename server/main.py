"""
main.py — FastAPI entrypoint for the reasoning server.

Endpoints:
  GET  /health   liveness + which backend is active
  POST /plan     sanitized context -> validated ActionPlan

Belt-and-suspenders privacy: even though redaction happens on the client, the
server independently scans inbound text for anything that still looks like a raw
identifier. If it finds one, it FAILS CLOSED (422) instead of feeding it to the
model — the server is "aware of the redaction scheme" and refuses unsanitized data.
"""
from __future__ import annotations
import os, re, time
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import SanitizedContext, ActionPlan
from planner import plan as make_plan, BACKEND
from security import sanitize_plan

app = FastAPI(title="Privacy Browser Agent — Reasoning Server", version="1.0")

# Extensions send an Origin like chrome-extension://<id>. For a hackathon we allow
# all; in production pin this to your published extension id.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["POST", "GET"], allow_headers=["*"],
)

# Residual-PII tripwires (should NEVER fire if the client redacted correctly).
_TRIPWIRES = {
    "email": re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),
    "aadhaar": re.compile(r"\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b"),
    "pan": re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b"),
    "long_number": re.compile(r"\b\d{9,19}\b"),
}


def _residual_scan(ctx: SanitizedContext):
    """Return the first (kind, where) of any raw identifier that leaked, else None."""
    haystacks = [("task", ctx.task)] + [("label", e.label) for e in ctx.elements]
    for where, text in haystacks:
        if not text:
            continue
        for kind, rx in _TRIPWIRES.items():
            if rx.search(text):
                return kind, where
    return None


@app.get("/health")
def health():
    from router import describe
    return {"ok": True, "protocol": "1.0", **describe(BACKEND)}


@app.post("/plan", response_model=ActionPlan)
def plan_endpoint(ctx: SanitizedContext):
    t0 = time.perf_counter()

    leak = _residual_scan(ctx)
    if leak:
        # Refuse to process unsanitized data. This protects the user even if the
        # client's redaction had a bug — the whole point of a privacy firewall.
        raise HTTPException(status_code=422, detail={
            "error": "residual_pii_detected",
            "kind": leak[0], "location": leak[1],
            "hint": "client redaction incomplete; server refuses unsanitized context",
        })

    raw_plan = make_plan(ctx)
    safe_plan = sanitize_plan(ctx, raw_plan)
    safe_plan.reasoning = (safe_plan.reasoning + f" ({(time.perf_counter()-t0)*1000:.0f}ms, backend={BACKEND})").strip()
    return safe_plan


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), reload=False)
