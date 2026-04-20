"""Detection-only lint report served on demand.

Lint never authors source material. It runs mechanical SQL queries
over the post-compile state and surfaces what the user should look at
next:

- research_suggestions: concepts the corpus clearly cares about (named
  in document frontmatter) that did not make it into the distilled
  registry as first-class entries
- orphans: rendered articles with no incoming wiki links
- dirty_concepts: concepts whose rendered_from_hash drifts from current
  compiled_from_hash (cluster inputs shifted without a re-render)
- contradictions: reserved. Requires reading article bodies; deferred.

No LLM calls. No writes to storage. The user decides what, if
anything, to ingest in response.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.documents.models import BacklinkORM, DocumentORM
from great_minds.core.documents.schemas import DocKind
from great_minds.core.subjects.distiller import slugify_concept_label
from great_minds.core.subjects.models import ConceptORM
from great_minds.core.subjects.schemas import ArticleStatus

DEFAULT_MIN_USES = 2
DEFAULT_SUGGESTION_LIMIT = 50
DEFAULT_MENTIONED_IN_SAMPLE = 5


@dataclass
class ResearchSuggestion:
    topic: str
    mentioned_in: list[str]
    usage_count: int


@dataclass
class Orphan:
    slug: str
    canonical_label: str


@dataclass
class LintReport:
    research_suggestions: list[ResearchSuggestion] = field(default_factory=list)
    orphans: list[Orphan] = field(default_factory=list)
    dirty_concepts: list[uuid.UUID] = field(default_factory=list)
    contradictions: list[dict] = field(default_factory=list)


async def build_lint_report(
    session: AsyncSession,
    brain_id: uuid.UUID,
    *,
    min_uses: int = DEFAULT_MIN_USES,
    suggestion_limit: int = DEFAULT_SUGGESTION_LIMIT,
) -> LintReport:
    """Run every detection pass in parallel-friendly SQL and assemble a report."""
    research = await _research_suggestions(
        session, brain_id, min_uses=min_uses, limit=suggestion_limit
    )
    orphans = await _orphans(session, brain_id)
    dirty = await flag_dirty_concepts(session, brain_id)
    return LintReport(
        research_suggestions=research,
        orphans=orphans,
        dirty_concepts=dirty,
        contradictions=[],
    )


async def flag_dirty_concepts(
    session: AsyncSession, brain_id: uuid.UUID
) -> list[uuid.UUID]:
    """Return concept_ids whose rendered article drifts from current inputs.

    A concept is dirty when it has never been rendered (rendered_from_hash
    IS NULL) or its cluster inputs have shifted since the last successful
    render (rendered_from_hash != compiled_from_hash). The renderer is the
    authority that clears this drift via mark_rendered.
    """
    result = await session.execute(
        select(ConceptORM.concept_id)
        .where(ConceptORM.brain_id == brain_id)
        .where(
            or_(
                ConceptORM.rendered_from_hash.is_(None),
                ConceptORM.rendered_from_hash != ConceptORM.compiled_from_hash,
            )
        )
    )
    return [row.concept_id for row in result]


async def _research_suggestions(
    session: AsyncSession,
    brain_id: uuid.UUID,
    *,
    min_uses: int,
    limit: int,
) -> list[ResearchSuggestion]:
    """Concepts named in doc frontmatter that never became first-class.

    Signal: for each raw document, `extra_metadata["concepts"]` holds an
    LLM-enriched list of topics the document is about. If a topic string
    slugifies to something not in ConceptORM.slug for this brain, it
    never cleared Phase 2 clustering — a research-worthy gap.
    """
    rows = await session.execute(
        select(DocumentORM.file_path, DocumentORM.extra_metadata["concepts"]).where(
            DocumentORM.brain_id == brain_id,
            DocumentORM.doc_kind == DocKind.RAW.value,
            DocumentORM.extra_metadata.has_key("concepts"),
        )
    )
    counts: dict[str, int] = defaultdict(int)
    mentions: dict[str, list[str]] = defaultdict(list)
    for file_path, concepts in rows:
        if not isinstance(concepts, list):
            continue
        for topic in concepts:
            if not isinstance(topic, str) or not topic.strip():
                continue
            key = topic.strip()
            counts[key] += 1
            if len(mentions[key]) < DEFAULT_MENTIONED_IN_SAMPLE:
                mentions[key].append(file_path)

    if not counts:
        return []

    existing_slugs_result = await session.execute(
        select(ConceptORM.slug).where(ConceptORM.brain_id == brain_id)
    )
    existing_slugs = {row.slug for row in existing_slugs_result}

    suggestions: list[ResearchSuggestion] = []
    for topic, count in counts.items():
        if count < min_uses:
            continue
        if slugify_concept_label(topic) in existing_slugs:
            continue
        suggestions.append(
            ResearchSuggestion(
                topic=topic,
                mentioned_in=mentions[topic],
                usage_count=count,
            )
        )
    suggestions.sort(key=lambda s: (-s.usage_count, s.topic.lower()))
    return suggestions[:limit]


async def _orphans(session: AsyncSession, brain_id: uuid.UUID) -> list[Orphan]:
    """Rendered articles with zero inbound wiki links.

    Excludes non-rendered concepts — a concept with no article cannot
    be an orphan, just unrendered. The backlinks table is populated by
    Phase 4 crosslinking (see crosslinker.py).
    """
    incoming_exists = (
        select(BacklinkORM.id)
        .where(BacklinkORM.brain_id == brain_id)
        .where(BacklinkORM.target_slug == ConceptORM.slug)
        .exists()
    )
    result = await session.execute(
        select(ConceptORM.slug, ConceptORM.canonical_label)
        .where(ConceptORM.brain_id == brain_id)
        .where(ConceptORM.article_status == ArticleStatus.RENDERED.value)
        .where(~incoming_exists)
        .order_by(ConceptORM.canonical_label)
    )
    return [
        Orphan(slug=row.slug, canonical_label=row.canonical_label) for row in result
    ]
