"""
main.py — FastAPI entrypoint for the reasoning server.

Endpoints:
  GET  /health   liveness + which backend is active
  POST /plan     sanitized context -> validated ActionPlan   (ACTION mode)
  POST /query    masked record view -> QueryAnswer           (QUERY mode)

Belt-and-suspenders privacy: even though redaction happens on the client, the
server independently scans inbound text for anything that still looks like a raw
identifier. If it finds one, it FAILS CLOSED (422) instead of feeding it to the
model — the server is "aware of the redaction scheme" and refuses unsanitized data.
"""
from __future__ import annotations
import os, re, time
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import SanitizedContext, ActionPlan, QueryContext, QueryAnswer
from planner import plan as make_plan, BACKEND
from query_planner import answer_query
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


def _scan_text(text: str, *, skip_long_number: bool = False):
    """First tripwire kind that fires on `text`, else None. `long_number` is
    optionally skipped for cells in numeric columns, where a bare run of digits
    is a legitimate amount (e.g. 1000000000), not a leaked account/card."""
    if not text:
        return None
    for kind, rx in _TRIPWIRES.items():
        if kind == "long_number" and skip_long_number:
            continue
        if rx.search(text):
            return kind
    return None


def _residual_scan_query(ctx: QueryContext):
    """Belt-and-suspenders scan of the QUERY payload. The browser has already
    masked identifier columns to <CATEGORY_n> tokens and tokenized inline PII, so
    this should never fire — but if it does, we refuse rather than reason over a
    raw value. Scans the query, and every table's caption, column names, and cells.
    The `long_number` tripwire is skipped ONLY for cells in numericColumns, because
    a parsed amount there is transaction data, not an identifier.
    ctx.screenshot is intentionally NOT scanned: it is a REDACTED raster whose PII
    pixels were blacked out on-device, and the server never OCRs it — there is no
    text to scan, and the bytes carry no identifier the tables didn't already mask."""
    kind = _scan_text(ctx.query)
    if kind:
        return kind, "query"
    for ti, t in enumerate(ctx.tables or []):
        kind = _scan_text(t.caption)
        if kind:
            return kind, f"tables[{ti}].caption"
        for ci, col in enumerate(t.columns):
            kind = _scan_text(col.name)
            if kind:
                return kind, f"tables[{ti}].columns[{ci}]"
        numeric_cols = set(t.numericColumns or [])
        for ri, row in enumerate(t.rows):
            for ci, cell in enumerate(row):
                kind = _scan_text(cell, skip_long_number=(ci in numeric_cols))
                if kind:
                    return kind, f"tables[{ti}].rows[{ri}][{ci}]"
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


@app.post("/query", response_model=QueryAnswer)
def query_endpoint(ctx: QueryContext):
    """QUERY mode: reason over a MASKED, typed view of the page's records and
    return a human-readable answer with verifiable per-group/grand totals. No
    screenshot, raw DOM, or raw page text ever reaches this endpoint."""
    t0 = time.perf_counter()

    leak = _residual_scan_query(ctx)
    if leak:
        raise HTTPException(status_code=422, detail={
            "error": "residual_pii_detected",
            "kind": leak[0], "location": leak[1],
            "hint": "client redaction incomplete; server refuses unsanitized context",
        })

    ans = answer_query(ctx)
    ans.answer = (ans.answer + f" ({(time.perf_counter()-t0)*1000:.0f}ms, backend={BACKEND})").strip()
    return ans


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), reload=False)
