"""Paragraph-level chunking, shared across ingest / search / extract.

One source of truth for "what is a paragraph" so chunk_index values
stay aligned across:

- Ingest: appends `^pN` Obsidian-style block anchors to each paragraph
  before writing raw markdown to disk (makes raw files Obsidian-
  native: cross-file block references work).
- Search: builds the BM25+vector index row per paragraph.
- Extract: maps each anchor's verbatim quote back to the paragraph
  that contains it, so render can emit deep-link footnote URLs
  (`raw/.../file.md#^p12`).

Paragraph boundaries are blank-line separated. Pure-heading blocks
(e.g. `# Chapter` on its own with nothing beneath before the next
blank line) are preserved in walk output but don't increment the
paragraph counter and don't get `^pN` anchors.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

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

    Strips any prior `^pN` markers so re-running on anchored content is
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
    """Return content with `^pN` appended to each paragraph body.

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
    """Return the chunk_index of the paragraph containing `quote`.

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
