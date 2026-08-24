"""
planner.py — Turns a sanitized context into a next-step ActionPlan.

Two backends, selected by env var PBA_BACKEND:
  - "mock" (default): a deterministic heuristic planner. Requires no GPU/model,
    so the whole end-to-end loop runs on any laptop for demos and CI.
  - "vlm": delegates to a real open-weights VLM (Qwen2.5-VL / Llama-3.2-Vision)
    via an OpenAI-compatible endpoint (see vlm_adapter.py).

Whatever the backend proposes is passed through security.sanitize_plan() by the
caller, so the planner itself is allowed to be optimistic.
"""
from __future__ import annotations
import os
from schemas import SanitizedContext, ActionPlan, Action

BACKEND = os.environ.get("PBA_BACKEND", "mock").lower()

# task-intent -> vault key used by fill_local (value resolved on the CLIENT)
_PII_TO_SOURCE = {"email": "email", "phone": "phone", "person": "full_name"}
_PRIMARY_BTN_WORDS = ["submit", "continue", "next", "proceed", "login", "sign in",
                      "search", "send", "save", "apply", "confirm", "ok"]


def _mock_plan(ctx: SanitizedContext) -> ActionPlan:
    task = (ctx.task or "").lower()

    # 1. Fill the first empty sensitive field we can source locally.
    for e in ctx.elements:
        if e.sensitive and e.value_state == "empty" and e.pii_type in _PII_TO_SOURCE:
            return ActionPlan(
                session_id=ctx.session_id, step=ctx.step,
                reasoning=f"Fill the empty {e.pii_type} field from the local vault.",
                actions=[Action(type="fill_local", target_id=e.id, source=_PII_TO_SOURCE[e.pii_type])],
                status="continue", confidence=0.7,
            )

    # 2. Click the most relevant primary button (prefer labels matching the task).
    buttons = [e for e in ctx.elements if e.role == "button" and e.enabled]
    def score(e):
        lab = (e.label or "").lower()
        s = sum(w in lab for w in _PRIMARY_BTN_WORDS)
        s += 2 * sum(tok in lab for tok in task.split() if len(tok) > 3)
        return s
    buttons.sort(key=score, reverse=True)
    if buttons and score(buttons[0]) > 0:
        b = buttons[0]
        return ActionPlan(
            session_id=ctx.session_id, step=ctx.step,
            reasoning=f"Click the '{b.label[:40]}' control to advance the task.",
            actions=[Action(type="click", target_id=b.id)],
            status="continue", confidence=0.6,
        )

    # 3. Nothing obvious above the fold — scroll to reveal more, once.
    if ctx.viewport and ctx.step <= 2:
        return ActionPlan(
            session_id=ctx.session_id, step=ctx.step,
            reasoning="No actionable control in view; scroll down to reveal more.",
            actions=[Action(type="scroll", direction="down")],
            status="continue", confidence=0.4,
        )

    # 4. Give up gracefully.
    return ActionPlan(
        session_id=ctx.session_id, step=ctx.step,
        reasoning="No further safe action identified; task appears complete or blocked.",
        actions=[], status="done", confidence=0.5,
    )


def plan(ctx: SanitizedContext) -> ActionPlan:
    if BACKEND == "vlm":
        from vlm_adapter import vlm_plan  # imported lazily so mock mode needs no deps
        try:
            return vlm_plan(ctx)
        except Exception as e:  # fail safe -> heuristic, never crash the loop
            p = _mock_plan(ctx)
            p.reasoning = f"[vlm fallback: {e}] " + p.reasoning
            return p
    return _mock_plan(ctx)
