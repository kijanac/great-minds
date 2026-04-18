"""Phase 4: cross-link wiki articles.

Runs after rendering. For each rendered wiki article:
  - fuzzy-match canonical_labels of other concepts against the body and
    insert `[label](slug.md)` on the first mention we haven't already
    linked
  - strip any link whose target slug isn't in the live registry (the
    writer occasionally invents targets)
  - compute outbound link targets and upsert them into the backlinks
    table so the query layer and UI can surface inbound references

Touches only wiki/*.md — session files are explicitly out of scope;
their links to retired slugs are absorbed by the archive flow (M7).
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.subjects.schemas import Concept
from great_minds.core.telemetry import log_event

# Matches the markdown wiki-link syntax the writer emits:
#     [display text](slug.md)  or  [display text](wiki/slug.md)
_WIKI_LINK_RE = re.compile(
    r"\[(?P<label>[^\]]+)\]\((?:wiki/)?(?P<slug>[A-Za-z0-9][A-Za-z0-9_-]*)\.md\)"
)

# Matches markdown footnote link targets like  [^3]: [...](raw/...) — we skip
# link insertion inside lines that are footnote definitions, since those are
# already citations that must point at raw sources.
_FOOTNOTE_DEF_RE = re.compile(r"^\[\^[^\]]+\]:")


@dataclass
class CrosslinkStats:
    articles_scanned: int = 0
    links_inserted: int = 0
    broken_links_stripped: int = 0
    backlink_edges: int = 0


async def crosslink_wiki(
    *,
    wiki_dir: Path,
    concepts: list[Concept],
    session: AsyncSession,
    brain_id: uuid.UUID,
) -> CrosslinkStats:
    """Rewrite wiki articles in place and refresh the backlinks table.

    Called by compile_pipeline after render. Idempotent — running twice
    on the same articles produces the same files.
    """
    by_slug = {c.slug: c for c in concepts}
    valid_slugs = set(by_slug)

    # Sort labels longest-first so "attention mechanism" wins over "attention"
    # when both would otherwise match. Self-match is prevented per-article.
    label_lookup = sorted(
        ((c.canonical_label, c.slug) for c in concepts),
        key=lambda pair: len(pair[0]),
        reverse=True,
    )

    stats = CrosslinkStats()
    repo = DocumentRepository(session)

    for article_path in sorted(wiki_dir.glob("*.md")):
        slug = article_path.stem
        if slug.startswith("_") or slug == "index":
            continue
        stats.articles_scanned += 1

        original = article_path.read_text(encoding="utf-8")
        rewritten, inserted, stripped = _rewrite_article(
            original,
            self_slug=slug,
            label_lookup=label_lookup,
            valid_slugs=valid_slugs,
        )
        if rewritten != original:
            article_path.write_text(rewritten, encoding="utf-8")
        stats.links_inserted += inserted
        stats.broken_links_stripped += stripped

        outbound = _extract_outbound_slugs(rewritten, valid_slugs, self_slug=slug)
        await repo.upsert_backlinks(brain_id, slug, sorted(outbound))
        stats.backlink_edges += len(outbound)

    await session.commit()
    log_event(
        "crosslink_completed",
        brain_id=str(brain_id),
        articles=stats.articles_scanned,
        inserted=stats.links_inserted,
        stripped=stats.broken_links_stripped,
        backlink_edges=stats.backlink_edges,
    )
    return stats


def _rewrite_article(
    content: str,
    *,
    self_slug: str,
    label_lookup: list[tuple[str, str]],
    valid_slugs: set[str],
) -> tuple[str, int, int]:
    """Strip broken links, then insert missing links on first mention.

    Returns (new_content, links_inserted, broken_stripped).
    """
    stripped_count = [0]

    def _strip(match: re.Match) -> str:
        target = match.group("slug")
        if target in valid_slugs:
            return match.group(0)
        stripped_count[0] += 1
        return match.group("label")

    after_strip = _WIKI_LINK_RE.sub(_strip, content)

    already_linked: set[str] = {
        m.group("slug") for m in _WIKI_LINK_RE.finditer(after_strip)
    }
    lines = after_strip.splitlines(keepends=True)
    inserted = 0
    inside_code = False
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            inside_code = not inside_code
            continue
        if inside_code or _FOOTNOTE_DEF_RE.match(line.lstrip()):
            continue
        for label, slug in label_lookup:
            if slug == self_slug or slug in already_linked:
                continue
            new_line, did = _insert_first(line, label, slug)
            if did:
                lines[i] = new_line
                already_linked.add(slug)
                inserted += 1
                line = new_line
    return "".join(lines), inserted, stripped_count[0]


def _insert_first(line: str, label: str, slug: str) -> tuple[str, bool]:
    """Insert a [label](slug.md) link on the first case-insensitive match.

    Refuses to match inside an existing markdown link bracket so we
    don't double-wrap the same span.
    """
    pattern = re.compile(
        rf"(?<![\w\[])(?P<hit>{re.escape(label)})(?!\w)",
        flags=re.IGNORECASE,
    )
    match = pattern.search(line)
    if match is None:
        return line, False
    # Skip if the match sits inside an existing [...](...) link.
    if _is_inside_link(line, match.start()):
        return line, False
    hit = match.group("hit")
    replacement = f"[{hit}]({slug}.md)"
    return line[: match.start()] + replacement + line[match.end() :], True


def _is_inside_link(line: str, pos: int) -> bool:
    for m in _WIKI_LINK_RE.finditer(line):
        if m.start() <= pos < m.end():
            return True
    return False


def _extract_outbound_slugs(
    content: str, valid_slugs: set[str], *, self_slug: str
) -> set[str]:
    outbound: set[str] = set()
    for m in _WIKI_LINK_RE.finditer(content):
        target = m.group("slug")
        if target == self_slug or target not in valid_slugs:
            continue
        outbound.add(target)
    return outbound
