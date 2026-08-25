"""
selftest.py — Dependency-light verification of the reasoning server (P2).

Covers, without needing a GPU or network:
  1. UI-TARS DSL parsing: coordinate snap to element ids, sensitive type ->
     fill_local declassification, finished/call_user/scroll mapping
  2. JSON profile parsing
  3. /health + /plan over the FastAPI TestClient (mock backend)
  4. Residual-PII tripwire (fail-closed 422)
  5. Router failover: dead primary route -> request still served (mock net)

Run:  python selftest.py   (from server/)
Exit code 0 == all green.
"""
from __future__ import annotations
import os

os.environ.setdefault("PBA_BACKEND", "mock")

import vlm_adapter as va
import router as rt
from schemas import SanitizedContext, Viewport, Element


def _ctx(elements=None, w=1280, h=720):
    return SanitizedContext(
        session_id="s-test", step=1, task="fill the form and submit",
        viewport=Viewport(w=w, h=h), elements=elements or [], redactions=[],
    )


def _elem(id, role="button", label="", bbox=(0, 0, 10, 10), **kw):
    return Element(id=id, role=role, label=label, bbox=list(bbox), **kw)


def test_uitars_snap():
    els = [_elem(1, "button", "Submit", (900, 600, 120, 40)),
           _elem(2, "textbox", "Search", (100, 100, 300, 36))]
    ctx = _ctx(els)
    # element-1 center is CSS (960,620) -> UI-TARS normalized 0..1000 = (750, 861)
    raw = "Thought: click submit\nAction: click(start_box='(750,861)')"
    p = va._parse_uitars(raw, ctx)
    assert p.actions and p.actions[0].type == "click" and p.actions[0].target_id == 1, p
    assert p.reasoning.startswith("click submit"), p
    print("  ✓ uitars click snaps to element id")


def test_uitars_sensitive_fill_local():
    els = [_elem(7, "textbox", "Email", (200, 200, 260, 32),
                 sensitive=True, pii_type="email", value_state="empty")]
    ctx = _ctx(els)
    # element-7 center is CSS (330,216) -> normalized (258, 300)
    raw = "Action: type(content='secret@x.com', start_box='(258,300)')"
    p = va._parse_uitars(raw, ctx)
    a = p.actions[0]
    assert a.type == "fill_local" and a.source == "email" and a.target_id == 7, a
    assert not any(getattr(a, "text", None) for a in p.actions), "literal must be dropped"
    print("  ✓ sensitive type -> fill_local (literal never survives)")


def test_uitars_terminals_and_scroll():
    ctx = _ctx()
    for raw, want_status, want_first in [
        ("Action: finished()", "done", None),
        ("Action: call_user()", "need_user", None),
        ("Action: scroll(direction='down')", "continue", "scroll"),
    ]:
        p = va._parse_uitars(raw, ctx)
        assert p.status == want_status, (raw, p)
        if want_first:
            assert p.actions[0].type == want_first and p.actions[0].direction == "down"
    print("  ✓ finished/call_user/scroll map to protocol statuses")


def test_json_profile():
    ctx = _ctx([_elem(3, "button", "Next")])
    raw = '{"reasoning":"advance","actions":[{"type":"click","target_id":3}],"status":"continue","confidence":0.8}'
    p = va._parse_json(raw, ctx)
    assert p.actions[0].target_id == 3 and p.confidence == 0.8
    print("  ✓ json profile parses")


def test_profile_detect():
    assert va.profile_for("bytedance/ui-tars-1.5-7b") == "uitars"
    assert va.profile_for("Qwen/Qwen2.5-VL-7B-Instruct") == "json"
    print("  ✓ profile auto-detect")


def test_http_layer():
    from fastapi.testclient import TestClient
    import main
    c = TestClient(main.app)

    h = c.get("/health").json()
    assert h["ok"] is True and h["backend"] == "mock" and h["routes"] == [], h

    ok = c.post("/plan", json=_ctx([
        _elem(1, "textbox", "Email field", sensitive=True, pii_type="email", value_state="empty"),
    ]).model_dump()).json()
    assert ok["status"] == "continue" and ok["actions"][0]["type"] == "fill_local", ok
    assert "backend=mock" in ok["reasoning"]

    leak = _ctx([_elem(9, "textbox", "reach me at bob@mail.com please")])
    r = c.post("/plan", json=leak.model_dump())
    assert r.status_code == 422 and r.json()["detail"]["error"] == "residual_pii_detected", r.text
    print("  ✓ /health, mock /plan, residual-PII tripwire (422)")


def test_router_failover_to_mock():
    import planner  # BACKEND is an import-time constant; patch like ops would
    os.environ["PBA_VLM_ROUTES"] = '[{"name":"dead","base_url":"http://127.0.0.1:1/v1","model":"x"}]'
    planner.BACKEND = "vlm"
    try:
        p = planner.plan(_ctx([_elem(1, "button", "Submit", (10, 10, 50, 20))]))
        assert "[vlm fallback:" in p.reasoning and p.actions, p
        # cooldown engaged: route now marked unhealthy
        d = rt.describe(backend="vlm")
        assert d["routes"][0]["healthy"] is False, d
        print("  ✓ dead route fails over to mock + enters cooldown")
    finally:
        os.environ.pop("PBA_VLM_ROUTES", None)
        planner.BACKEND = "mock"


if __name__ == "__main__":
    print("P2 server-brain selftest")
    test_profile_detect()
    test_uitars_snap()
    test_uitars_sensitive_fill_local()
    test_uitars_terminals_and_scroll()
    test_json_profile()
    test_http_layer()
    test_router_failover_to_mock()
    print("ALL GREEN")
