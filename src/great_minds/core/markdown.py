"""Markdown I/O utilities.

One source of truth for reading, writing, and chunking the vault's
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
    """One markdown block.

    ``chunk_index`` discriminates the variant: ``None`` means a pure
    heading block (``# Chapter`` on its own line), ``int`` means a
    paragraph block with that position. ``heading`` is populated
    whenever the block's first line is a markdown heading — for both
    pure-heading blocks and mixed blocks that open with a heading —
    so downstream code doesn't need to re-match the regex.
    """

    raw: str
    chunk_index: int | None
    heading: str | None


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
        heading = heading_match.group(2).strip() if heading_match else None
        if heading is not None and not rest.strip():
            out.append(Block(raw=raw, chunk_index=None, heading=heading))
        else:
            out.append(Block(raw=raw, chunk_index=para_counter, heading=heading))
            para_counter += 1
    return out


def paragraphs(content: str) -> list[Paragraph]:
    """Return paragraph blocks with running nearest-preceding heading."""
    out: list[Paragraph] = []
    current_heading = ""
    for b in walk(content):
        if b.heading is not None:
            current_heading = b.heading
        if b.chunk_index is None:
            continue
        # chunk_index narrowed to int by the None check above
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
        if b.chunk_index is None:
            parts.append(b.raw)
        else:
            parts.append(f"{b.raw} {_ANCHOR_TAG}{b.chunk_index}")
    return "\n\n".join(parts) + "\n"


def normalized_bodies(paras: list[Paragraph]) -> list[tuple[int, str]]:
    """Precompute whitespace-normalized paragraph bodies for quote matching.

    Callers that look up many quotes against the same paragraph list
    (e.g. extract's per-anchor localization loop) build this once and
    pass it to :func:`paragraph_for_quote` to avoid O(N×M) normalization.
    """
    return [(p.index, _normalize(p.body)) for p in paras]


def paragraph_for_quote(quote: str, bodies: list[tuple[int, str]]) -> int | None:
    """Return the paragraph index whose body contains ``quote``.

    Whitespace-normalized substring match against pre-normalized bodies
    (produced by :func:`normalized_bodies`). None if the quote can't be
    localized — render emits the footnote without a deep-link fragment.
    """
    normalized_quote = _normalize(quote)
    if not normalized_quote:
        return None
    for index, body in bodies:
        if normalized_quote in body:
            return index
    return None


def _normalize(text: str) -> str:
    return _WS_RE.sub(" ", text.strip())
