"""Build markdown source documents and write them to vault storage.

Two stages of frontmatter participate in a doc's life cycle:

1. **Ingest** (this module): writes the identity / mechanically-known
   slice — source_type, url, origin, plus per-source-kind provenance
   (session_id/exchange_id for sessions; anchored_to/anchored_section/
   intent for user suggestions). No title / precis / genre / tags / etc.
   — those are extract's territory.
2. **Post-extract** (`pipeline.extract`): rewrites the frontmatter in
   place to *mirror back* the LLM-derived fields plus vault-configured
   ``derived_extras``. The on-disk file becomes the portable record.

Re-ingest reads whatever frontmatter is present and writes only the
zone-1/zone-2 fields into the DB; zone-3 is refreshed by the next
compile, so stale frontmatter values can't clobber live extract output.
"""

import logging
from io import StringIO
from pathlib import Path

from ruamel.yaml import YAML

from great_minds.core.markdown import inject_anchors
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)

_yaml = YAML()
_yaml.default_flow_style = False


def build_frontmatter(known: dict) -> str:
    """Build YAML frontmatter from a dict of already-known field values.

    Pure — no config lookup, no schema, no defaults. Whatever's in
    ``known`` gets emitted in dict iteration order. None values are
    skipped so the on-disk file stays terse.
    """
    fm = {k: v for k, v in known.items() if v is not None}
    buf = StringIO()
    _yaml.dump(fm, buf)
    return f"---\n{buf.getvalue()}---\n"


def build_document(
    content: str,
    *,
    source_type: str = "document",
    url: str | None = None,
    origin: str | None = None,
    # Per-source-kind provenance (set by IngestService.ingest_session_exchange
    # and ingest_user_suggestion respectively):
    session_id: str | None = None,
    exchange_id: str | None = None,
    session_query: str | None = None,
    source_doc_path: str | None = None,
    source_anchor: str | None = None,
    source_paragraph_index: int | None = None,
    anchored_to: str | None = None,
    anchored_section: str | None = None,
    intent: str | None = None,
) -> str:
    """Prepend ingest-time frontmatter to raw content. Pure — no I/O.

    Output is a deterministic function of inputs, safe to hash for dedup.
    Only fields the ingest caller knew at write time are emitted; the
    extract phase rewrites the frontmatter to add LLM-derived fields
    after first compile.
    """
    known = {
        "source_type": source_type,
        "url": url,
        "origin": origin,
        "session_id": session_id,
        "exchange_id": exchange_id,
        "session_query": session_query,
        "source_doc_path": source_doc_path,
        "source_anchor": source_anchor,
        "source_paragraph_index": source_paragraph_index,
        "anchored_to": anchored_to,
        "anchored_section": anchored_section,
        "intent": intent,
    }
    return build_frontmatter(known) + inject_anchors(content)


async def write_document(
    storage: Storage,
    content: str,
    *,
    dest: str,
    source_type: str = "document",
    url: str | None = None,
    origin: str | None = None,
    session_id: str | None = None,
    exchange_id: str | None = None,
    session_query: str | None = None,
    source_doc_path: str | None = None,
    source_anchor: str | None = None,
    source_paragraph_index: int | None = None,
    anchored_to: str | None = None,
    anchored_section: str | None = None,
    intent: str | None = None,
) -> str:
    """Build a document with frontmatter and persist it to storage."""
    built = build_document(
        content,
        source_type=source_type,
        url=url,
        origin=origin,
        session_id=session_id,
        exchange_id=exchange_id,
        session_query=session_query,
        source_doc_path=source_doc_path,
        source_anchor=source_anchor,
        source_paragraph_index=source_paragraph_index,
        anchored_to=anchored_to,
        anchored_section=anchored_section,
        intent=intent,
    )
    await storage.write(dest, built)
    return built


async def write_file(
    storage: Storage,
    filepath: Path,
    dest_dir: str,
    **kwargs,
) -> str:
    """Read a file from the external filesystem and write it to vault storage."""
    content = filepath.read_text(encoding="utf-8")
    dest = f"{dest_dir}/{filepath.name}"
    await write_document(storage, content, dest=dest, **kwargs)
    return dest
