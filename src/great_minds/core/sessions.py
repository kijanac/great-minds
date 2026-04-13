"""Session persistence — JSONL event log + derived markdown.

Each session is stored as two files:
  sessions/{id}.jsonl  — append-only event log (source of truth)
  sessions/{id}.md     — human-readable rendering (derived, never parsed)

Event types:
  MetaEvent      — session metadata (first line of every JSONL)
  ExchangeEvent  — a query/answer pair
  BtwEvent       — a "by the way" side-thread attached to an exchange
"""

import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ValidationError

from .storage import Storage

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sub-models
# ---------------------------------------------------------------------------


class ThinkingSource(BaseModel):
    label: str
    type: Literal["article", "raw", "search"]
    thinking: str | None = None


class ThinkingBlock(BaseModel):
    sources: list[ThinkingSource] = []


class BtwMessage(BaseModel):
    role: str
    text: str


# ---------------------------------------------------------------------------
# Event models (stored in JSONL)
# ---------------------------------------------------------------------------


class EventType(StrEnum):
    META = "meta"
    EXCHANGE = "exchange"
    BTW = "btw"


class MetaEvent(BaseModel):
    type: EventType = EventType.META
    id: str
    query: str
    ts: str
    user_id: str = ""
    origin: str | None = None


class ExchangeEvent(BaseModel):
    type: EventType = EventType.EXCHANGE
    exId: str
    query: str
    thinking: list[ThinkingBlock] = []
    answer: str = ""
    ts: str


class BtwEvent(BaseModel):
    type: EventType = EventType.BTW
    exId: str
    anchor: str
    paragraph: str
    pi: int = -1
    messages: list[BtwMessage]
    ts: str


type SessionEvent = MetaEvent | ExchangeEvent | BtwEvent


# ---------------------------------------------------------------------------
# Input models (what callers pass to public functions)
# ---------------------------------------------------------------------------


class ExchangeInput(BaseModel):
    id: str
    query: str
    thinking: list[ThinkingBlock] = []
    answer: str = ""


class BtwInput(BaseModel):
    exchangeId: str = ""
    anchor: str
    paragraph: str
    paragraphIndex: int = -1
    messages: list[BtwMessage]


# ---------------------------------------------------------------------------
# Output model for list_sessions
# ---------------------------------------------------------------------------


class SessionSummary(BaseModel):
    id: str
    query: str
    created: str
    updated: str
    user_id: str = ""
    origin: str | None = None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_event(data: dict) -> SessionEvent | None:
    """Parse a raw JSON dict into a typed event model."""
    event_type = data.get("type")
    try:
        match event_type:
            case EventType.META:
                return MetaEvent.model_validate(data)
            case EventType.EXCHANGE:
                return ExchangeEvent.model_validate(data)
            case EventType.BTW:
                return BtwEvent.model_validate(data)
            case _:
                log.warning("unknown event type: %s", event_type)
                return None
    except ValidationError as e:
        log.warning("invalid %s event: %s", event_type, e)
        return None


def _render_md(events: list[SessionEvent]) -> str:
    """Render event log as human-readable markdown.

    Groups BTWs under their parent exchange by exId.
    """
    exchanges: list[ExchangeEvent] = []
    btws_by_ex: dict[str, list[BtwEvent]] = defaultdict(list)

    for event in events:
        if isinstance(event, ExchangeEvent):
            exchanges.append(event)
        elif isinstance(event, BtwEvent):
            btws_by_ex[event.exId].append(event)

    parts: list[str] = []
    for i, ex in enumerate(exchanges):
        if i > 0:
            parts.append("\n---\n\n")
        parts.append(f"# {ex.query}\n\n")

        for block in ex.thinking:
            for src in block.sources:
                parts.append(f"> `{src.label}`\n")
            parts.append(">\n")

        parts.append(ex.answer + "\n")

        for btw in btws_by_ex.get(ex.exId, []):
            short = btw.anchor[:60] + "..." if len(btw.anchor) > 60 else btw.anchor
            parts.append(f'\n> **BTW** re: "{short}"\n>\n')
            for msg in btw.messages:
                if msg.role == "user":
                    parts.append(f"> *{msg.text}*\n>\n")
                else:
                    parts.append(f"> {msg.text}\n>\n")

    return "".join(parts).rstrip() + "\n"


def _append_event(storage: Storage, session_id: str, event: SessionEvent) -> None:
    path = f"sessions/{session_id}.jsonl"
    storage.append(path, json.dumps(event.model_dump()) + "\n")


def _rebuild_md(storage: Storage, session_id: str) -> None:
    events = load_events(storage, session_id)
    md = _render_md(events)
    storage.write(f"sessions/{session_id}.md", md)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def create_session(
    storage: Storage,
    session_id: str,
    exchange: ExchangeInput,
    *,
    origin: str | None = None,
    user_id: str,
) -> str:
    """Create a new session with the first exchange."""
    storage.mkdir("sessions")

    meta = MetaEvent(
        id=session_id,
        query=exchange.query,
        ts=_now(),
        user_id=user_id,
        origin=origin,
    )
    _append_event(storage, session_id, meta)

    ex = ExchangeEvent(
        exId=exchange.id,
        query=exchange.query,
        thinking=exchange.thinking,
        answer=exchange.answer,
        ts=_now(),
    )
    _append_event(storage, session_id, ex)

    _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


def append_exchange(
    storage: Storage,
    session_id: str,
    exchange: ExchangeInput,
) -> str:
    """Append a follow-up exchange to an existing session."""
    ex = ExchangeEvent(
        exId=exchange.id,
        query=exchange.query,
        thinking=exchange.thinking,
        answer=exchange.answer,
        ts=_now(),
    )
    _append_event(storage, session_id, ex)
    _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


def append_btw(
    storage: Storage,
    session_id: str,
    btw: BtwInput,
) -> str:
    """Append a BTW thread to an existing session."""
    event = BtwEvent(
        exId=btw.exchangeId,
        anchor=btw.anchor,
        paragraph=btw.paragraph,
        pi=btw.paragraphIndex,
        messages=btw.messages,
        ts=_now(),
    )
    _append_event(storage, session_id, event)
    _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


def load_events(storage: Storage, session_id: str) -> list[SessionEvent]:
    """Load all events from a session's JSONL file.

    Truncates at the first malformed line (partial write recovery).
    Invalid events are skipped with a warning.
    """
    content = storage.read(f"sessions/{session_id}.jsonl")
    if content is None:
        return []
    events: list[SessionEvent] = []
    for line in content.strip().split("\n"):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            break
        event = _parse_event(data)
        if event is not None:
            events.append(event)
    return events


def list_sessions(
    storage: Storage, *, user_id: str | None = None
) -> list[SessionSummary]:
    """List all sessions with metadata. Sorted by last activity.

    If user_id is provided, only sessions belonging to that user are returned.
    """
    results: list[SessionSummary] = []
    for path in storage.glob("sessions/*.jsonl"):
        content = storage.read(path)
        if content is None:
            continue
        lines = [line for line in content.strip().split("\n") if line.strip()]
        if not lines:
            continue

        try:
            raw_meta = json.loads(lines[0])
        except json.JSONDecodeError:
            continue
        if raw_meta.get("type") != EventType.META:
            continue

        try:
            meta = MetaEvent.model_validate(raw_meta)
        except ValidationError:
            continue

        if user_id is not None and meta.user_id != user_id:
            continue

        updated = meta.ts
        if len(lines) > 1:
            try:
                last = json.loads(lines[-1])
                updated = last.get("ts", meta.ts)
            except json.JSONDecodeError:
                pass

        results.append(
            SessionSummary(
                id=meta.id,
                query=meta.query,
                created=meta.ts,
                updated=updated,
                user_id=meta.user_id,
                origin=meta.origin,
            )
        )

    results.sort(key=lambda s: s.updated, reverse=True)
    return results
