"""Markdown I/O utilities.

One source of truth for reading, writing, and chunking the brain's
markdown files. Covers three related concerns:

- Frontmatter parsing + serialization (YAML between ``---`` fences)
- Wiki-link extraction (``[label](wiki/<slug>.md)`` citations in
  rendered articles)
- Paragraph-level chunking with Obsidian-style ``^pN`` block anchors,
  shared across ingest (bakes anchors into raw files), search (one
  index row per paragraph), and extract (maps LLM-emitted verbatim
  quotes back to their paragraph for deep-link footnotes).

Paragraph boundaries are blank-line separated. Pure-heading blocks
(``# Chapter`` on its own before the next blank line) are preserved
in walk output but don't increment the paragraph counter and don't
get ``^pN`` anchors.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from io import StringIO

from ruamel.yaml import YAML

# ---------------------------------------------------------------------------
# Frontmatter
# ---------------------------------------------------------------------------

_FRONTMATTER_RE = re.compile(r"^---\n(.+?)\n---\n", re.DOTALL)
_yaml = YAML()
_yaml.preserve_quotes = True


def parse_frontmatter(content: str) -> tuple[dict, str]:
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return {}, content
    fm = _yaml.load(match.group(1))
    body = content[match.end() :]
    return dict(fm) if fm else {}, body


def serialize_frontmatter(fm: dict, body: str) -> str:
    buf = StringIO()
    _yaml.dump(fm, buf)
    return f"---\n{buf.getvalue()}---\n{body}"


# ---------------------------------------------------------------------------
# Wiki-link citations
# ---------------------------------------------------------------------------

_WIKI_LINK_RE = re.compile(r"\[([^\]]*)\]\((wiki/[^)]+\.md)\)")


def extract_wiki_link_targets(content: str) -> list[str]:
    """Extract unique wiki article paths from markdown links."""
    return list(dict.fromkeys(m.group(2) for m in _WIKI_LINK_RE.finditer(content)))


# ---------------------------------------------------------------------------
# Paragraph chunking + Obsidian block anchors
# ---------------------------------------------------------------------------

_PARA_SPLIT_RE = re.compile(r"\n\s*\n")
_HEADING_LINE_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_ANCHOR_MARKER_RE = re.compile(r"\s*\^p\d+\s*$", re.MULTILINE)
_WS_RE = re.compile(r"\s+")
_ANCHOR_TAG = "^p"


@dataclass
class Block:
    """One markdown block: either a pure heading or a paragraph."""

    raw: str
    is_paragraph: bool
    chunk_index: int | None  # None for pure-heading blocks


@dataclass
class Paragraph:
    """A paragraph block with its position and nearest-preceding heading."""

    index: int
    heading: str
    body: str


def walk(content: str) -> list[Block]:
    """Walk content block-by-block, preserving structure.

    Strips any prior ``^pN`` markers so re-running on anchored content is
    idempotent: you'll get the same chunk_index values.
    """
    out: list[Block] = []
    para_counter = 0
    for raw in _PARA_SPLIT_RE.split(content):
        raw = _ANCHOR_MARKER_RE.sub("", raw).strip()
        if not raw:
            continue
        first_line, _, rest = raw.partition("\n")
        heading_match = _HEADING_LINE_RE.match(first_line)
        is_heading_only = bool(heading_match) and not rest.strip()
        if is_heading_only:
            out.append(Block(raw=raw, is_paragraph=False, chunk_index=None))
        else:
            out.append(
                Block(raw=raw, is_paragraph=True, chunk_index=para_counter)
            )
            para_counter += 1
    return out


def paragraphs(content: str) -> list[Paragraph]:
    """Return paragraph blocks with running nearest-preceding heading."""
    out: list[Paragraph] = []
    current_heading = ""
    for b in walk(content):
        first_line, _, _ = b.raw.partition("\n")
        hm = _HEADING_LINE_RE.match(first_line)
        if hm:
            current_heading = hm.group(2).strip()
        if b.is_paragraph:
            assert b.chunk_index is not None
            out.append(
                Paragraph(
                    index=b.chunk_index,
                    heading=current_heading,
                    body=b.raw,
                )
            )
    return out


def inject_anchors(content: str) -> str:
    """Return content with ``^pN`` appended to each paragraph body.

    Pure heading blocks and blank-line separators are preserved. Safe
    to re-run on already-anchored content.
    """
    blocks = walk(content)
    if not blocks:
        return content
    parts: list[str] = []
    for b in blocks:
        if b.is_paragraph:
            parts.append(f"{b.raw} {_ANCHOR_TAG}{b.chunk_index}")
        else:
            parts.append(b.raw)
    return "\n\n".join(parts) + "\n"


def paragraph_for_quote(quote: str, paras: list[Paragraph]) -> int | None:
    """Return the chunk_index of the paragraph containing ``quote``.

    Whitespace-normalized substring match. None if the quote can't be
    localized — render emits the footnote without a deep-link fragment.
    """
    normalized = _normalize(quote)
    if not normalized:
        return None
    for p in paras:
        if normalized in _normalize(p.body):
            return p.index
    return None


def _normalize(text: str) -> str:
    return _WS_RE.sub(" ", text.strip())
