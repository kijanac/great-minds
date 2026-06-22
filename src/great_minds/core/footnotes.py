"""Shared footnote resolution for cited bodies.

Both the wiki render pipeline and the query answer path emit ``[^N]`` markers
against numbered sources, then resolve them identically: renumber contiguously
by first appearance, drop markers whose source is missing (orphans), and append
the resolution section. Keeping it here keeps citations uniform across the
knowledge base.
"""

import re
from dataclasses import dataclass

_FOOTNOTE_RE = re.compile(r"\[\^(\d+)\]")


@dataclass(frozen=True)
class FootnoteSource:
    """A resolved citation target — the source link and its verbatim quote."""

    link: str
    quote: str


def format_source_link(label: str, path: str, chunk_index: int | None) -> str:
    """Markdown link to a source, deep-linking to the paragraph when known.

    The ``^pN`` block-ref anchor is what the doc reader scrolls to. Shared by the
    wiki render pipeline and the query answer path so citations format alike.
    """
    target = f"{path}#^p{chunk_index}" if chunk_index is not None else path
    return f"[{label}]({target})"


def resolve_footnotes(body: str, sources: dict[int, FootnoteSource]) -> str:
    """Renumber ``[^N]`` markers by first appearance, drop orphans, append the
    footnote section.

    ``sources`` maps each number the author emitted to its rendered source link
    and quote. A marker with no entry is dropped — an author can cite a number
    that was never registered. Returns the body plus a trailing footnote block,
    or just the body when nothing resolved.
    """
    used_order: list[int] = []
    for m in _FOOTNOTE_RE.finditer(body):
        n = int(m.group(1))
        if n in sources and n not in used_order:
            used_order.append(n)

    remap = {orig: display for display, orig in enumerate(used_order, start=1)}

    def _replace(m: re.Match) -> str:
        n = int(m.group(1))
        return f"[^{remap[n]}]" if n in remap else ""

    renumbered = _FOOTNOTE_RE.sub(_replace, body)
    # Collapse double spaces left when an orphan marker is removed mid-sentence.
    renumbered = re.sub(r"  +", " ", renumbered)

    if not used_order:
        return renumbered.rstrip() + "\n"

    lines = ["", "---", ""]
    for display, orig in enumerate(used_order, start=1):
        src = sources[orig]
        if src.quote:
            lines.append(f'[^{display}]: {src.link} — "{src.quote}"')
        else:
            lines.append(f"[^{display}]: {src.link}")
    return renumbered.rstrip() + "\n" + "\n".join(lines) + "\n"
