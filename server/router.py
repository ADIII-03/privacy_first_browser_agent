"""
router.py — Endpoint routing with automatic failover for the reasoning tier.

Deployment story in one env var:
  * SIH / cloud:   OpenRouter (or Groq/OpenAI-compatible host) first
  * air-gapped:    local vLLM / llama.cpp server first
  * laptop demo:   no routes configured -> deterministic mock planner

PBA_BACKEND selects strategy:
  mock (default)  heuristic planner only, zero deps
  vlm             first healthy route, mock on total failure
  auto            alias kept explicit: every configured route in order, then mock

Routes come from PBA_VLM_ROUTES (JSON list, ordered by preference):
  [{"name":"openrouter","base_url":"https://openrouter.ai/api/v1",
    "model":"bytedance/ui-tars-1.5-7b","api_key_env":"OPENROUTER_API_KEY","profile":"uitars"},
   {"name":"local-vllm","base_url":"http://localhost:8001/v1",
    "model":"Qwen/Qwen2.5-VL-7B-Instruct"}]

or the legacy single-endpoint trio PBA_VLM_BASE_URL / PBA_VLM_MODEL / PBA_VLM_API_KEY,
which becomes one route. Failures put a route on a 60 s cooldown so a dead primary
never adds per-request latency after the first strike.
"""
from __future__ import annotations
import json, os, time
from dataclasses import dataclass, field
from typing import Optional

from schemas import SanitizedContext, ActionPlan


@dataclass
class Route:
    name: str
    base_url: str
    model: str
    api_key: str = "not-needed-for-local"
    profile: Optional[str] = None  # None -> auto-detect from model name
    cooldown_until: float = field(default=0.0, repr=False)

    def describe(self) -> dict:
        return {"name": self.name, "model": self.model, "profile": self.profile or "(auto)",
                "healthy": time.time() >= self.cooldown_until}


_COOLDOWN_S = float(os.environ.get("PBA_VLM_COOLDOWN_S", "60"))


def _from_legacy_env() -> list[Route]:
    base = os.environ.get("PBA_VLM_BASE_URL")
    if not base:
        return []
    return [Route(name="legacy", base_url=base,
                  model=os.environ.get("PBA_VLM_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct"),
                  api_key=os.environ.get("PBA_VLM_API_KEY", "not-needed-for-local"),
                  profile=os.environ.get("PBA_VLM_PROFILE") or None)]


# Route objects carry RUNTIME health state (cooldown_until), so re-parsing the
# env on every call would silently reset failover memory. Cache by config key.
_route_cache: dict = {"key": None, "routes": []}


def routes() -> list[Route]:
    raw = os.environ.get("PBA_VLM_ROUTES", "").strip()
    if not raw:
        key = "|".join(("legacy", os.environ.get("PBA_VLM_BASE_URL", ""),
                        os.environ.get("PBA_VLM_MODEL", ""), os.environ.get("PBA_VLM_API_KEY", "")))
    else:
        key = f"json:{raw}"
    if _route_cache["key"] != key:
        if not raw:
            parsed = _from_legacy_env()
        else:
            parsed = []
            for i, r in enumerate(json.loads(raw)):
                key_env = os.environ.get(r.get("api_key_env", ""), r.get("api_key", "not-needed-for-local"))
                parsed.append(Route(name=r.get("name") or f"route-{i}",
                                    base_url=r["base_url"], model=r["model"],
                                    api_key=key_env or "not-needed-for-local",
                                    profile=r.get("profile") or None))
        _route_cache["key"] = key
        _route_cache["routes"] = parsed
    return _route_cache["routes"]


def describe(backend: str | None = None) -> dict:
    """For /health: current chain without leaking keys."""
    backend = (backend or os.environ.get("PBA_BACKEND", "mock")).lower()
    if backend == "auto":
        backend = "vlm"
    rs = [] if backend == "mock" else [r.describe() for r in routes()]
    return {"backend": backend, "routes": rs}


def plan_with_fallback(ctx: SanitizedContext) -> tuple[ActionPlan, str]:
    """Try each healthy route once per request; cool down losers; raise if all fail."""
    from vlm_adapter import vlm_plan  # lazy import: mock mode stays dependency-free

    last_err: Exception | None = None
    for r in routes():
        if time.time() < r.cooldown_until:
            continue
        try:
            plan = vlm_plan(ctx, base_url=r.base_url, model=r.model,
                            api_key=r.api_key, profile=r.profile)
            return plan, f"vlm:{r.name}({r.model})"
        except Exception as e:  # noqa: BLE001 — any provider error must fail over
            r.cooldown_until = time.time() + _COOLDOWN_S
            last_err = e
    raise RuntimeError(f"all VLM routes failed: {last_err}")
