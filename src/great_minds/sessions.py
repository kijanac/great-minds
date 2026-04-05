"""Session persistence — serialize query threads as markdown files.

Sessions are records of query conversations including thinking blocks,
answers, and BTW threads. They live in sessions/ and are separate from
the knowledge graph.
"""

from datetime import datetime, timezone

from ruamel.yaml import YAML

from .storage import Storage

_YAML = YAML()
_YAML.default_flow_style = False


def _frontmatter(meta: dict) -> str:
    """Render YAML frontmatter block."""
    import io

    buf = io.StringIO()
    _YAML.dump(meta, buf)
    return f"---\n{buf.getvalue().strip()}\n---\n\n"


def _render_thinking(thinking: list[dict]) -> str:
    """Render thinking blocks as blockquotes."""
    if not thinking:
        return ""
    lines = []
    for block in thinking:
        if block.get("text"):
            lines.append(f"> {block['text']}")
        for source in block.get("sources", []):
            lines.append(f"> `{source}`")
        lines.append(">")
    # Remove trailing >
    if lines and lines[-1] == ">":
        lines.pop()
    return "\n".join(lines) + "\n\n"


def _render_btws(btws: list[dict]) -> str:
    """Render BTW threads as blockquotes."""
    if not btws:
        return ""
    parts = []
    for btw in btws:
        anchor = btw.get("anchor", "")
        short = anchor[:60] + "..." if len(anchor) > 60 else anchor
        lines = [f'> **BTW** re: "{short}"', ">"]
        for msg in btw.get("messages", []):
            prefix = "*" if msg["role"] == "user" else ""
            suffix = "*" if msg["role"] == "user" else ""
            lines.append(f"> {prefix}{msg['text']}{suffix}")
            lines.append(">")
        if lines and lines[-1] == ">":
            lines.pop()
        parts.append("\n".join(lines))
    return "\n\n".join(parts) + "\n\n"


def _render_exchange(exchange: dict) -> str:
    """Render a single exchange (query + thinking + answer + btws)."""
    parts = []
    parts.append(f"# {exchange['query']}\n\n")
    parts.append(_render_thinking(exchange.get("thinking", [])))
    parts.append(exchange.get("answer", "") + "\n\n")
    parts.append(_render_btws(exchange.get("btws", [])))
    return "".join(parts).rstrip() + "\n"


def create_session(
    storage: Storage,
    session_id: str,
    exchange: dict,
) -> str:
    """Create a new session file with the first exchange. Returns the path."""
    now = datetime.now(timezone.utc).isoformat()
    sources = exchange.get("cards", [])

    meta = {
        "id": session_id,
        "status": "session",
        "created": now,
        "updated": now,
        "sources": sources,
    }

    content = _frontmatter(meta) + _render_exchange(exchange)
    path = f"sessions/{session_id}.md"
    storage.mkdir("sessions")
    storage.write(path, content)
    return path


def append_exchange(
    storage: Storage,
    session_id: str,
    exchange: dict,
) -> str:
    """Append a follow-up exchange to an existing session. Returns the path."""
    path = f"sessions/{session_id}.md"
    existing = storage.read(path)

    # Update the "updated" timestamp in frontmatter
    now = datetime.now(timezone.utc).isoformat()
    new_sources = exchange.get("cards", [])

    # Parse existing frontmatter to update metadata
    if existing.startswith("---\n"):
        end = existing.index("\n---\n", 4)
        fm_text = existing[4:end]
        body = existing[end + 5:]
        import io
        fm = dict(_YAML.load(io.StringIO(fm_text)))
        fm["updated"] = now
        existing_sources = fm.get("sources", [])
        fm["sources"] = list(dict.fromkeys(existing_sources + new_sources))
        content = _frontmatter(fm) + body.strip() + "\n\n---\n\n" + _render_exchange(exchange)
    else:
        content = existing.rstrip() + "\n\n---\n\n" + _render_exchange(exchange)

    storage.write(path, content)
    return path


def append_btw(
    storage: Storage,
    session_id: str,
    btw: dict,
) -> str:
    """Append a BTW thread to the end of an existing session. Returns the path."""
    path = f"sessions/{session_id}.md"
    existing = storage.read(path)
    content = existing.rstrip() + "\n\n" + _render_btws([btw])
    storage.write(path, content)
    return path


def list_sessions(storage: Storage) -> list[dict]:
    """List all sessions with their frontmatter metadata."""
    results = []
    for path in storage.glob("sessions/*.md"):
        content = storage.read(path)
        if content.startswith("---\n"):
            end = content.index("\n---\n", 4)
            fm_text = content[4:end]
            import io
            fm = dict(_YAML.load(io.StringIO(fm_text)))
            fm["path"] = path
            results.append(fm)
    results.sort(key=lambda s: s.get("updated", ""), reverse=True)
    return results
