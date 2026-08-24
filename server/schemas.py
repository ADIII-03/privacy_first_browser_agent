"""
schemas.py — Strict server-side mirror of the v1 wire protocol.

These pydantic models are a SECURITY BOUNDARY, not just serialization helpers:

  * Inbound  (SanitizedContext): we reject any payload that smuggles a raw value
    where only a category/token/enum is allowed. If the client is doing its job,
    no PII value can even be represented here.
  * Outbound (ActionPlan): the model's output is constrained to a closed action
    vocabulary via Literal types, so a hallucinated or injected "action" like
    `eval` or `exfiltrate` fails validation before it can ever reach the client.
"""
from __future__ import annotations

from typing import List, Optional, Literal
from pydantic import BaseModel, Field, field_validator

PROTOCOL_VERSION = "1.0"

# --- categories / enums kept in lockstep with extension/lib/protocol.js -------
PII_TYPES = {
    "password", "otp", "api_key", "credit_card", "bank_account", "aadhaar",
    "pan", "upi", "email", "phone", "person", "address", "dob", "face",
    "signature", "ip", "generic_secret",
}
VALUE_STATES = {"empty", "filled", "redacted"}
ActionType = Literal[
    "click", "type", "fill_local", "select", "scroll", "scroll_to",
    "navigate", "wait", "done", "need_user", "abort",
]
Status = Literal["continue", "done", "need_user", "abort"]


# --- inbound ------------------------------------------------------------------
class Element(BaseModel):
    id: int
    role: str
    label: str = ""
    bbox: List[int] = Field(..., min_length=4, max_length=4)
    enabled: bool = True
    value_state: str = "empty"
    sensitive: bool = False
    pii_type: Optional[str] = None
    destructive: bool = False

    @field_validator("value_state")
    @classmethod
    def _vs(cls, v):
        return v if v in VALUE_STATES else "empty"


class Redaction(BaseModel):
    pii_type: str
    token: str
    method: str
    bbox: List[int] = Field(..., min_length=4, max_length=4)
    confidence: float = 0.0

    @field_validator("token")
    @classmethod
    def _token_is_placeholder(cls, v):
        # A redaction entry may ONLY carry a <CATEGORY_n> placeholder, never a value.
        if not (v.startswith("<") and v.endswith(">")):
            raise ValueError("redaction token must be a <PLACEHOLDER>, not a raw value")
        return v


class Viewport(BaseModel):
    w: int
    h: int
    scroll_x: int = 0
    scroll_y: int = 0
    dpr: float = 1.0


class PrivacyReceipt(BaseModel):
    detected: int = 0
    redacted: int = 0
    residual_risk: str = "unknown"
    send_screenshot: bool = True
    fail_closed_triggered: bool = False
    categories: dict = {}


class SanitizedContext(BaseModel):
    protocol_version: str = PROTOCOL_VERSION
    session_id: str
    step: int
    task: str
    url_origin: str = ""
    viewport: Viewport
    screenshot: Optional[str] = None  # data URL of the REDACTED image, or None
    screenshot_included: bool = True
    elements: List[Element] = []
    redactions: List[Redaction] = []
    privacy_receipt: Optional[PrivacyReceipt] = None

    @field_validator("url_origin")
    @classmethod
    def _origin_only(cls, v):
        # Defense in depth: reject anything with a path/query — origin only.
        if v and ("?" in v or v.count("/") > 2):
            raise ValueError("url_origin must be an origin, not a full URL")
        return v


# --- outbound -----------------------------------------------------------------
class Action(BaseModel):
    type: ActionType
    target_id: Optional[int] = None
    text: Optional[str] = None          # literal, non-sensitive only
    source: Optional[str] = None        # vault key for fill_local (value resolved on client)
    option: Optional[str] = None
    amount: Optional[int] = None
    direction: Optional[Literal["up", "down"]] = None
    url: Optional[str] = None
    ms: Optional[int] = None
    requires_confirmation: bool = False


class ActionPlan(BaseModel):
    protocol_version: str = PROTOCOL_VERSION
    session_id: str
    step: int
    reasoning: str = ""
    actions: List[Action] = []
    status: Status = "continue"
    confidence: float = 0.5
