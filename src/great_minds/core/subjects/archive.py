"""Archive retired concepts so immutable session links keep resolving.

When Phase 2 clustering retires a slug, the rendered wiki/<slug>.md
goes stale. Sessions may link to it. Sessions are immutable, so we
cannot rewrite those links; we move the article into an archive tree
and record a supersession pointer to the closest surviving concept,
so follow-ups of old session links land on a readable archive view.

Supersession is picked mechanically (Jaccard similarity of slug
tokens) so there is no LLM hallucination surface. If no active
concept clears the threshold, the archive banner says "retired, no
successor."
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain_utils import parse_frontmatter, serialize_frontmatter
from great_minds.core.subjects.models import ConceptORM
from great_minds.core.subjects.schemas import ArticleStatus, Concept
from great_minds.core.telemetry import log_event

log = logging.getLogger(__name__)

SUCCESSOR_MIN_OVERLAP = 0.4
_STOP_TOKENS = frozenset(
    {"a", "an", "the", "of", "and", "or", "for", "in", "on", "to", "vs", "unnamed"}
)


def archive_root(brain_id: uuid.UUID) -> Path:
    """Base directory for a brain's archived articles."""
    return Path(".compile") / str(brain_id) / "archive"


def archive_path(brain_id: uuid.UUID, concept_id: uuid.UUID, slug: str) -> Path:
    """Full path to a specific archived article."""
    return archive_root(brain_id) / str(concept_id) / f"{slug}.md"


@dataclass
class ArchiveEntry:
    """One retired slug absorbed into the archive tree."""

    concept_id: uuid.UUID
    old_slug: str
    old_canonical_label: str
    superseded_by_concept_id: uuid.UUID | None
    superseded_by_slug: str | None
    archive_path: Path | None


async def archive_retired_concepts(
    *,
    session: AsyncSession,
    brain_id: uuid.UUID,
    live_concepts: list[Concept],
    wiki_dir: Path,
) -> list[ArchiveEntry]:
    """Archive every ConceptORM row whose slug is no longer live.

    Called AFTER distill (to know the live set) and BEFORE render (so
    the renderer does not re-emit a retired slug about to be moved out
    of wiki/).

    Idempotent: concepts already marked 'archived' are skipped. A slug
    that returns to the live set gets a fresh 'no_article' row via the
    normal slug-continuity upsert; any prior archive entry sits
    unreferenced (reactivation cleanup is deferred).
    """
    live_slugs = {c.slug for c in live_concepts}
    retired = await _load_retired(session, brain_id, live_slugs)
    if not retired:
        return []

    active_tokens = [(c, _slug_tokens(c.slug)) for c in live_concepts]

    entries: list[ArchiveEntry] = []
    for row in retired:
        successor = _pick_successor(row.slug, active_tokens)
        path = _move_article(
            wiki_dir=wiki_dir,
            dest=archive_path(brain_id, row.concept_id, row.slug),
            successor_slug=successor.slug if successor else None,
        )
        await session.execute(
            update(ConceptORM)
            .where(ConceptORM.brain_id == brain_id)
            .where(ConceptORM.concept_id == row.concept_id)
            .values(
                article_status=ArticleStatus.ARCHIVED.value,
                superseded_by=successor.concept_id if successor else None,
                updated_at=func.now(),
            )
        )
        entries.append(
            ArchiveEntry(
                concept_id=row.concept_id,
                old_slug=row.slug,
                old_canonical_label=row.canonical_label,
                superseded_by_concept_id=successor.concept_id if successor else None,
                superseded_by_slug=successor.slug if successor else None,
                archive_path=path,
            )
        )
    await session.commit()

    log_event(
        "archive_phase_completed",
        brain_id=str(brain_id),
        retired_count=len(entries),
        linked_count=sum(1 for e in entries if e.superseded_by_slug),
        orphaned_count=sum(1 for e in entries if not e.superseded_by_slug),
        moved_count=sum(1 for e in entries if e.archive_path is not None),
    )
    return entries


async def _load_retired(
    session: AsyncSession, brain_id: uuid.UUID, live_slugs: set[str]
):
    stmt = (
        select(
            ConceptORM.concept_id,
            ConceptORM.slug,
            ConceptORM.canonical_label,
        )
        .where(ConceptORM.brain_id == brain_id)
        .where(ConceptORM.article_status != ArticleStatus.ARCHIVED.value)
    )
    if live_slugs:
        stmt = stmt.where(ConceptORM.slug.not_in(live_slugs))
    result = await session.execute(stmt)
    return list(result)


def _pick_successor(
    retired_slug: str, active: list[tuple[Concept, set[str]]]
) -> Concept | None:
    """Best live concept as judged by Jaccard similarity of slug tokens.

    Slugs are used because they are pre-normalized; active tokens are
    precomputed by the caller so we don't repeat the split per retired.
    """
    retired_tokens = _slug_tokens(retired_slug)
    if not retired_tokens or not active:
        return None
    best: Concept | None = None
    best_score = 0.0
    for concept, tokens in active:
        if not tokens:
            continue
        intersection = len(retired_tokens & tokens)
        if intersection == 0:
            continue
        score = intersection / len(retired_tokens | tokens)
        if score > best_score:
            best_score = score
            best = concept
    return best if best_score >= SUCCESSOR_MIN_OVERLAP else None


def _slug_tokens(slug: str) -> set[str]:
    return {
        t for t in re.split(r"[-\s_]+", slug.lower()) if t and t not in _STOP_TOKENS
    }


def _move_article(
    *,
    wiki_dir: Path,
    dest: Path,
    successor_slug: str | None,
) -> Path | None:
    """Move a rendered wiki article into the archive with superseded_by frontmatter.

    Returns the destination, or None if the wiki file did not exist
    (archiving a never-rendered concept is a valid no-op — the
    ConceptORM row is still marked archived).
    """
    slug = dest.stem
    src = wiki_dir / f"{slug}.md"
    if not src.exists():
        return None

    content = src.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)
    fm["superseded_by"] = successor_slug or ""
    updated = serialize_frontmatter(fm, body)

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(updated, encoding="utf-8")
    src.unlink()
    return dest
