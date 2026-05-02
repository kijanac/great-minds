"""Session persistence — JSONL event log + derived markdown.

Each session is stored as two files:
  sessions/{id}.jsonl  — append-only event log (source of truth)
  sessions/{id}.md     — human-readable rendering (derived, never parsed)

Event types:
  MetaEvent      — session metadata (first line of every JSONL)
  ExchangeEvent  — a query/answer pair
  BtwEvent       — a "by the way" side-thread attached to an exchange

Promotion helpers (``generate_session_title``,
``render_session_exchange_source``) live here too: turning a session
exchange into a wiki-source document is a session-derived concern, and
both ``IngestService`` and ``ProposalService`` use them.
"""

import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from enum import StrEnum
from typing import Literal

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from great_minds.core.documents.builder import build_document
from great_minds.core.llm import QUERY_MODEL
from great_minds.core.llm.client import api_call, extract_content
from great_minds.core.pagination import Page, PageInfo, PageParams

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


class BtwExchange(BaseModel):
    """One Q/A round inside a BTW thread.

    Mirrors ExchangeEvent but without exId/ts — those live on the parent
    BtwEvent, since a BTW is a sequence of turns sharing one anchor and
    one position in the parent session.
    """

    query: str
    thinking: list[ThinkingBlock] = []
    answer: str = ""


class SessionOrigin(BaseModel):
    """Where this session was anchored when it was created.

    For sessions started by opening a doc, only ``doc_path`` is set.
    For sessions spun off from a document BTW, the passage triple
    (anchor + paragraph + paragraph_index) is also recorded so the
    UI can scroll back to the source highlight.
    """

    doc_path: str
    anchor: str | None = None
    paragraph: str | None = None
    paragraph_index: int | None = None


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
    user_id: str
    origin: SessionOrigin | None = None


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
    exchanges: list[BtwExchange]
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
    exchanges: list[BtwExchange]


# ---------------------------------------------------------------------------
# Output model for list_sessions
# ---------------------------------------------------------------------------


class SessionSummary(BaseModel):
    id: str
    query: str
    created: str
    updated: str
    user_id: str
    origin: SessionOrigin | None = None


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

    Each BTW reply writes a fresh BtwEvent with the full thread history,
    so multiple BtwEvents per (exId, anchor) accumulate in the JSONL.
    Dedup to the latest by ts before rendering so the markdown shows one
    block per BTW thread, not N progressively-longer blocks.
    """
    exchanges: list[ExchangeEvent] = []
    latest_btw: dict[tuple[str, str], BtwEvent] = {}

    for event in events:
        if isinstance(event, ExchangeEvent):
            exchanges.append(event)
        elif isinstance(event, BtwEvent):
            key = (event.exId, event.anchor)
            existing = latest_btw.get(key)
            if existing is None or event.ts > existing.ts:
                latest_btw[key] = event

    btws_by_ex: dict[str, list[BtwEvent]] = defaultdict(list)
    for btw in latest_btw.values():
        btws_by_ex[btw.exId].append(btw)

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
            for inner in btw.exchanges:
                parts.append(f"> *{inner.query}*\n>\n")
                parts.append(f"> {inner.answer}\n>\n")

    return "".join(parts).rstrip() + "\n"


async def _append_event(
    storage: Storage, session_id: str, event: SessionEvent
) -> None:
    path = f"sessions/{session_id}.jsonl"
    await storage.append(path, json.dumps(event.model_dump()) + "\n")


async def _rebuild_md(storage: Storage, session_id: str) -> None:
    events = await load_events(storage, session_id)
    md = _render_md(events)
    await storage.write(f"sessions/{session_id}.md", md)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def create_session(
    storage: Storage,
    session_id: str,
    exchange: ExchangeInput,
    *,
    origin: SessionOrigin | None = None,
    user_id: str,
) -> str:
    """Create a new session with the first exchange."""
    await storage.mkdir("sessions")

    meta = MetaEvent(
        id=session_id,
        query=exchange.query,
        ts=_now(),
        user_id=user_id,
        origin=origin,
    )
    await _append_event(storage, session_id, meta)

    ex = ExchangeEvent(
        exId=exchange.id,
        query=exchange.query,
        thinking=exchange.thinking,
        answer=exchange.answer,
        ts=_now(),
    )
    await _append_event(storage, session_id, ex)

    await _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


async def append_exchange(
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
    await _append_event(storage, session_id, ex)
    await _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


async def append_btw(
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
        exchanges=btw.exchanges,
        ts=_now(),
    )
    await _append_event(storage, session_id, event)
    await _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


async def load_events(
    storage: Storage, session_id: str
) -> list[SessionEvent]:
    """Load all events from a session's JSONL file.

    Truncates at the first malformed line (partial write recovery).
    Invalid events are skipped with a warning.
    """
    content = await storage.read(f"sessions/{session_id}.jsonl")
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


def find_meta(events: list[SessionEvent]) -> MetaEvent | None:
    """Return the session's MetaEvent, or None if missing/malformed."""
    for event in events:
        if isinstance(event, MetaEvent):
            return event
    return None


def find_exchange(
    events: list[SessionEvent], exchange_id: str
) -> ExchangeEvent | None:
    """Return the ExchangeEvent with this exId, or None if missing."""
    for event in events:
        if isinstance(event, ExchangeEvent) and event.exId == exchange_id:
            return event
    return None


async def list_sessions(
    storage: Storage,
    *,
    user_id: str | None = None,
    pagination: PageParams,
) -> Page[SessionSummary]:
    """List all sessions with metadata. Sorted by last activity.

    If user_id is provided, only sessions belonging to that user are returned.
    """
    results: list[SessionSummary] = []
    for path in await storage.glob("sessions/*.jsonl"):
        content = await storage.read(path)
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
    total = len(results)
    return Page(
        items=results[pagination.offset : pagination.offset + pagination.limit],
        pagination=PageInfo(
            limit=pagination.limit,
            offset=pagination.offset,
            total=total,
        ),
    )


# ---------------------------------------------------------------------------
# Promotion helpers — turn a session exchange into a wiki-source document
# ---------------------------------------------------------------------------


_SESSION_TITLE_SYSTEM = (
    "You generate concise titles for distilled Q&A excerpts that have "
    "been promoted to a knowledge base. Output a 3-7 word noun phrase "
    "in Title Case, no question marks, no leading articles, no quotes. "
    "Output ONLY the title text — no preamble, no explanation."
)


async def generate_session_title(
    client: AsyncOpenAI, query: str, answer: str
) -> str:
    """One-shot title for a promoted session exchange."""
    response = await api_call(
        client,
        model=QUERY_MODEL,
        messages=[
            {"role": "system", "content": _SESSION_TITLE_SYSTEM},
            {"role": "user", "content": f"Q: {query}\n\nA: {answer}"},
        ],
        temperature=0.4,
    )
    title = (extract_content(response) or "").strip().strip('"').strip()
    if not title:
        raise ValueError("LLM returned empty title")
    return title


def session_exchange_build_args(
    *,
    session_id: str,
    exchange: ExchangeEvent,
    title: str,
    session_origin: SessionOrigin | None,
) -> dict:
    """Args dict shared by ``build_document`` and ``IngestService._ingest_raw``.

    Single source of truth for the shape of a promoted session exchange:
    content, content_type, source_type, origin, title, and the
    ``source_*`` provenance fields. ProposalService consumes it via
    ``render_session_exchange_source`` (it needs the rendered string for
    staging); IngestService consumes it directly via ``_ingest_raw``.
    """
    extras: dict[str, str] = {
        "source_session_id": session_id,
        "source_exchange_id": exchange.exId,
        "source_query": exchange.query,
    }
    if session_origin is not None:
        extras["source_doc_path"] = session_origin.doc_path
        if session_origin.anchor:
            extras["source_anchor"] = session_origin.anchor
        if session_origin.paragraph_index is not None:
            extras["source_paragraph_index"] = str(session_origin.paragraph_index)

    return dict(
        content=exchange.answer,
        content_type="sessions",
        source_type="user",
        title=title,
        origin="session-exchange",
        **extras,
    )


def render_session_exchange_source(
    config: dict,
    *,
    session_id: str,
    exchange: ExchangeEvent,
    title: str,
    session_origin: SessionOrigin | None,
) -> str:
    """Build the full markdown (frontmatter + body) for a promoted exchange.

    Used by ProposalService to stage the same bytes that would have been
    ingested directly. IngestService does not call this — it goes
    through ``session_exchange_build_args`` + ``_ingest_raw`` to avoid
    rebuilding the string only to reparse it on write.
    """
    return build_document(
        config,
        **session_exchange_build_args(
            session_id=session_id,
            exchange=exchange,
            title=title,
            session_origin=session_origin,
        ),
    )
