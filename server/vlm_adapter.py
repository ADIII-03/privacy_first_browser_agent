"""
vlm_adapter.py — Optional real reasoning via an open-weights VLM.

Talks to any OpenAI-compatible server (vLLM, SGLang, TGI, Ollama, LM Studio).
For SIH you can point this at a cloud-hosted Qwen2.5-VL; for the offline
requirement, run the SAME model locally with vLLM and only change the base URL.

    pip install openai
    export PBA_BACKEND=vlm
    export PBA_VLM_BASE_URL=http://localhost:8001/v1
    export PBA_VLM_MODEL=Qwen/Qwen2.5-VL-7B-Instruct

The sanitized screenshot (already redacted) is sent as an image_url data URL; the
element list is sent as JSON text. We force JSON output and parse defensively.
"""
from __future__ import annotations
import json, os, pathlib
from schemas import SanitizedContext, ActionPlan

_PROMPT = (pathlib.Path(__file__).parent / "prompts" / "system_prompt.txt").read_text(encoding="utf-8")
_BASE_URL = os.environ.get("PBA_VLM_BASE_URL", "http://localhost:8001/v1")
_MODEL = os.environ.get("PBA_VLM_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct")
_API_KEY = os.environ.get("PBA_VLM_API_KEY", "not-needed-for-local")


def _client():
    from openai import OpenAI
    return OpenAI(base_url=_BASE_URL, api_key=_API_KEY)


def _compact_elements(ctx: SanitizedContext):
    # Only the fields the model needs — keeps the prompt small (latency + cost).
    return [
        {"id": e.id, "role": e.role, "label": e.label, "sensitive": e.sensitive,
         "value_state": e.value_state, "pii_type": e.pii_type}
        for e in ctx.elements
    ]


def vlm_plan(ctx: SanitizedContext) -> ActionPlan:
    user_content = [{
        "type": "text",
        "text": json.dumps({
            "task": ctx.task,
            "url_origin": ctx.url_origin,
            "elements": _compact_elements(ctx),
            "redaction_tokens": [r.token for r in ctx.redactions],
        }, ensure_ascii=False),
    }]
    if ctx.screenshot:
        user_content.append({"type": "image_url", "image_url": {"url": ctx.screenshot}})

    resp = _client().chat.completions.create(
        model=_MODEL,
        temperature=0,
        max_tokens=400,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _PROMPT},
            {"role": "user", "content": user_content},
        ],
    )
    data = json.loads(resp.choices[0].message.content)
    return ActionPlan(
        session_id=ctx.session_id,
        step=ctx.step,
        reasoning=str(data.get("reasoning", ""))[:300],
        actions=data.get("actions", []),
        status=data.get("status", "continue"),
        confidence=float(data.get("confidence", 0.5)),
    )
