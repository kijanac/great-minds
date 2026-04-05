"""Session persistence — JSONL event log + derived markdown.

Each session is stored as two files:
  sessions/{id}.jsonl  — append-only event log (source of truth)
  sessions/{id}.md     — human-readable rendering (derived, never parsed)

Event types:
  {"type":"meta",     "id":"...", "query":"...", "ts":"..."}
  {"type":"exchange", "exId":"...", "query":"...", "thinking":[...], "cards":[...], "answer":"..."}
  {"type":"btw",      "exId":"...", "anchor":"...", "pi":N, "messages":[...]}
"""

import json
from collections import defaultdict
from datetime import datetime, timezone

from .storage import Storage


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _render_md(events: list[dict]) -> str:
    """Render event log as human-readable markdown.

    Groups BTWs under their parent exchange by exId.
    """
    exchanges: list[dict] = []
    btws_by_ex: dict[str, list[dict]] = defaultdict(list)

    for event in events:
        if event["type"] == "exchange":
            exchanges.append(event)
        elif event["type"] == "btw":
            btws_by_ex[event.get("exId", "")].append(event)

    parts = []
    for i, ex in enumerate(exchanges):
        if i > 0:
            parts.append("\n---\n\n")
        parts.append(f"# {ex['query']}\n\n")

        for block in ex.get("thinking", []):
            if block.get("text"):
                parts.append(f"> {block['text']}\n")
            for src in block.get("sources", []):
                parts.append(f"> `{src}`\n")
            parts.append(">\n")

        parts.append(ex.get("answer", "") + "\n")

        for btw in btws_by_ex.get(ex.get("exId", ""), []):
            anchor = btw.get("anchor", "")
            short = anchor[:60] + "..." if len(anchor) > 60 else anchor
            parts.append(f'\n> **BTW** re: "{short}"\n>\n')
            for msg in btw.get("messages", []):
                if msg["role"] == "user":
                    parts.append(f"> *{msg['text']}*\n>\n")
                else:
                    parts.append(f"> {msg['text']}\n>\n")

    return "".join(parts).rstrip() + "\n"


def _append_event(storage: Storage, session_id: str, event: dict) -> None:
    path = f"sessions/{session_id}.jsonl"
    storage.append(path, json.dumps(event) + "\n")


def _rebuild_md(storage: Storage, session_id: str) -> None:
    events = load_events(storage, session_id)
    md = _render_md(events)
    storage.write(f"sessions/{session_id}.md", md)


def create_session(
    storage: Storage,
    session_id: str,
    exchange: dict,
) -> str:
    """Create a new session with the first exchange."""
    storage.mkdir("sessions")

    meta_event = {
        "type": "meta",
        "id": session_id,
        "query": exchange["query"],
        "ts": _now(),
    }
    _append_event(storage, session_id, meta_event)

    ex_event = {
        "type": "exchange",
        "exId": exchange.get("id", session_id),
        "query": exchange["query"],
        "thinking": exchange.get("thinking", []),
        "cards": exchange.get("cards", []),
        "answer": exchange.get("answer", ""),
        "ts": _now(),
    }
    _append_event(storage, session_id, ex_event)

    _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


def append_exchange(
    storage: Storage,
    session_id: str,
    exchange: dict,
) -> str:
    """Append a follow-up exchange to an existing session."""
    ex_event = {
        "type": "exchange",
        "exId": exchange.get("id", ""),
        "query": exchange["query"],
        "thinking": exchange.get("thinking", []),
        "cards": exchange.get("cards", []),
        "answer": exchange.get("answer", ""),
        "ts": _now(),
    }
    _append_event(storage, session_id, ex_event)
    _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


def append_btw(
    storage: Storage,
    session_id: str,
    btw: dict,
) -> str:
    """Append a BTW thread to an existing session."""
    btw_event = {
        "type": "btw",
        "exId": btw.get("exchangeId", ""),
        "anchor": btw["anchor"],
        "pi": btw.get("paragraphIndex", -1),
        "messages": btw["messages"],
        "ts": _now(),
    }
    _append_event(storage, session_id, btw_event)
    _rebuild_md(storage, session_id)
    return f"sessions/{session_id}.jsonl"


def load_events(storage: Storage, session_id: str) -> list[dict]:
    """Load all events from a session's JSONL file.

    Truncates at the first malformed line (partial write recovery).
    """
    content = storage.read(f"sessions/{session_id}.jsonl")
    events = []
    for line in content.strip().split("\n"):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            break
    return events


def list_sessions(storage: Storage) -> list[dict]:
    """List all sessions with metadata. Sorted by last activity."""
    results = []
    for path in storage.glob("sessions/*.jsonl"):
        content = storage.read(path)
        lines = [l for l in content.strip().split("\n") if l.strip()]
        if not lines:
            continue

        try:
            meta = json.loads(lines[0])
        except json.JSONDecodeError:
            continue
        if meta.get("type") != "meta":
            continue

        # Last event timestamp for sort order
        try:
            last = json.loads(lines[-1])
            meta["updated"] = last.get("ts", meta.get("ts", ""))
        except json.JSONDecodeError:
            meta["updated"] = meta.get("ts", "")

        results.append(meta)

    results.sort(key=lambda s: s.get("updated", ""), reverse=True)
    return results
