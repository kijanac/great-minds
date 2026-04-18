"""Postgres cache for the concept registry.

concepts rows mirror the authoritative JSONL on disk. The upsert path
is keyed on (brain_id, slug): when a slug already exists we reuse its
concept_id, otherwise we mint a fresh UUID7. That slug continuity is
what keeps concept identity stable across free re-distillations while
still allowing clustering to reshuffle freely on every run. Retired
slugs are surfaced by registry_diff for the archive flow to absorb.
"""

from __future__ import annotations

import uuid

from sqlalchemy import case, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.subjects.models import ConceptORM
from great_minds.core.subjects.schemas import Concept


async def existing_slugs(
    session: AsyncSession, brain_id: uuid.UUID
) -> dict[str, uuid.UUID]:
    """Return {slug: concept_id} for every concept currently persisted."""
    result = await session.execute(
        select(ConceptORM.slug, ConceptORM.concept_id).where(
            ConceptORM.brain_id == brain_id
        )
    )
    return {row.slug: row.concept_id for row in result}


def reconcile_concept_ids(
    concepts: list[Concept], existing: dict[str, uuid.UUID]
) -> dict[uuid.UUID, uuid.UUID]:
    """Rewrite speculative concept_ids on slug matches; return old→new remap.

    Called before concepts are written to disk so that subjects.jsonl
    and the idea→concept backfill agree with the Postgres cache.
    """
    remap: dict[uuid.UUID, uuid.UUID] = {}
    for concept in concepts:
        durable_id = existing.get(concept.slug)
        if durable_id is None or durable_id == concept.concept_id:
            continue
        remap[concept.concept_id] = durable_id
        concept.concept_id = durable_id
    return remap


async def upsert_concepts(
    session: AsyncSession, brain_id: uuid.UUID, concepts: list[Concept]
) -> None:
    """Upsert every concept, keyed on (brain_id, slug).

    concept_id on each Concept is assumed to already reflect slug
    continuity (see reconcile_concept_ids). Lifecycle columns
    (article_status, rendered_from_hash) are managed outside the
    distiller's write path: defaulted on insert, preserved across
    re-distills, and mutated by the renderer via mark_rendered and
    by the archive flow via M7 helpers.
    """
    if not concepts:
        return
    rows = [
        {
            "concept_id": c.concept_id,
            "brain_id": brain_id,
            "kind": c.kind.value,
            "canonical_label": c.canonical_label,
            "slug": c.slug,
            "description": c.description,
            "article_status": "no_article",
            "compiled_from_hash": c.compiled_from_hash,
            "rendered_from_hash": None,
            "supersedes": None,
            "superseded_by": None,
            "updated_at": func.now(),
        }
        for c in concepts
    ]
    stmt = insert(ConceptORM).values(rows)
    # On conflict, distillation updates only intrinsic fields; it must
    # not stomp on article_status, rendered_from_hash, supersedes, or
    # superseded_by, which are set by the renderer and archive flow.
    stmt = stmt.on_conflict_do_update(
        index_elements=["brain_id", "slug"],
        set_={
            "concept_id": stmt.excluded.concept_id,
            "kind": stmt.excluded.kind,
            "canonical_label": stmt.excluded.canonical_label,
            "description": stmt.excluded.description,
            "compiled_from_hash": stmt.excluded.compiled_from_hash,
            "updated_at": stmt.excluded.updated_at,
        },
    )
    await session.execute(stmt)
    await session.commit()


async def mark_rendered(
    session: AsyncSession,
    brain_id: uuid.UUID,
    rendered_from_hash_by_id: dict[uuid.UUID, str],
) -> None:
    """Update lifecycle columns after a successful render pass.

    Sets article_status='rendered' and rendered_from_hash to the hash
    the article was rendered from (== the concept's compiled_from_hash
    at render time). Subsequent distill runs that shift
    compiled_from_hash without a re-render produce a detectable drift
    (rendered_from_hash != compiled_from_hash = NEEDS_REVISION).
    """
    if not rendered_from_hash_by_id:
        return
    concept_ids = list(rendered_from_hash_by_id.keys())
    mapping = case(rendered_from_hash_by_id, value=ConceptORM.concept_id)
    await session.execute(
        update(ConceptORM)
        .where(ConceptORM.brain_id == brain_id)
        .where(ConceptORM.concept_id.in_(concept_ids))
        .values(
            article_status="rendered",
            rendered_from_hash=mapping,
            updated_at=func.now(),
        )
    )
    await session.commit()


async def registry_diff(
    session: AsyncSession,
    brain_id: uuid.UUID,
    concepts: list[Concept],
) -> tuple[list[Concept], list[Concept], list[Concept]]:
    """Classify concepts vs the cached registry.

    Returns (added, dirty, unchanged):
    - added: slug is new to this brain
    - dirty: slug exists but compiled_from_hash changed → needs re-render
    - unchanged: slug+hash both match → cached article can be reused

    Retired slugs (present in cache but not in `concepts`) are the
    archive flow's responsibility (see M7); not returned here.
    """
    result = await session.execute(
        select(ConceptORM.slug, ConceptORM.compiled_from_hash).where(
            ConceptORM.brain_id == brain_id
        )
    )
    cached = {row.slug: row.compiled_from_hash for row in result}

    added: list[Concept] = []
    dirty: list[Concept] = []
    unchanged: list[Concept] = []
    for concept in concepts:
        prior_hash = cached.get(concept.slug)
        if prior_hash is None:
            added.append(concept)
        elif prior_hash != concept.compiled_from_hash:
            dirty.append(concept)
        else:
            unchanged.append(concept)
    return added, dirty, unchanged


async def retired_slugs(
    session: AsyncSession,
    brain_id: uuid.UUID,
    live_slugs: set[str],
) -> list[tuple[uuid.UUID, str]]:
    """Return (concept_id, slug) for every cached concept not in live_slugs."""
    result = await session.execute(
        select(ConceptORM.concept_id, ConceptORM.slug).where(
            ConceptORM.brain_id == brain_id
        )
    )
    return [
        (row.concept_id, row.slug)
        for row in result
        if row.slug not in live_slugs
    ]
