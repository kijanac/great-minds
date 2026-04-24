"""Phase 2e — validate.

Mechanical + one unified LLM cleanup call:

1. Drop link_targets whose slug isn't in the emitted canonical set
   (closes the hallucinated-link error surface).
2. Detect slug collisions among new canonicals and archive candidates
   (previous-compile topics whose slug is gone).
3. If either exists, one cleanup LLM call handles both: renaming
   colliding slugs and deciding thematic successors for archive
   candidates. Unified context lets the LLM pick successor slugs that
   don't accidentally conflict with renames.
4. Apply renames. Any post-rename collision is a hard fail — no
   mechanical suffix fallback, per the decision that cleanup failure
   should surface rather than silently persist a corrupt registry.
5. Slug continuity: reuse existing topic_id for known slugs; mint
   uuid7 for new ones.
6. Archive flow: set article_status=archived, superseded_by pointer,
   move wiki/<slug>.md → archive/<topic_id>/<slug>.md with updated
   frontmatter.
7. Upsert the canonical registry to the topics table.

Output is list[ValidatedCanonicalTopic] — what phase 3 derive consumes.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from uuid import UUID

from uuid6 import uuid7

from great_minds.core.brain import load_prompt
from great_minds.core.llm.client import json_llm_call
from great_minds.core.llm import REDUCE_MODEL
from great_minds.core.markdown import parse_frontmatter, serialize_frontmatter
from great_minds.core.paths import wiki_path
from great_minds.core.pipeline.abstract.schemas import (
    LocalTopic,
    ValidatedCanonicalTopic,
)
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import ArticleStatus, CanonicalTopic, Topic

log = logging.getLogger(__name__)


@dataclass
class _CleanupOutput:
    slug_renames: dict[int, str]  # canonical index → new slug
    supersessions: dict[UUID, int | None]  # archived topic_id → canonical index or None


async def run(
    ctx: PipelineContext,
    canonical_topics: list[CanonicalTopic],
    local_topics: list[LocalTopic],
) -> list[ValidatedCanonicalTopic]:
    if not canonical_topics:
        log_event(
            "pipeline.validate_skipped",
            brain_id=str(ctx.brain_id),
            reason="no_canonicals",
        )
        return []

    canonical_topics = _intersect_link_targets(canonical_topics)
    local_by_id = {t.local_topic_id: t for t in local_topics}

    repo = TopicRepository(ctx.session)
    existing = await repo.list_all(ctx.brain_id)
    active_existing = [
        t for t in existing if t.article_status != ArticleStatus.ARCHIVED
    ]

    emitted_slugs = [c.slug for c in canonical_topics]
    collisions = _detect_collisions(canonical_topics)
    archive_candidates = [t for t in active_existing if t.slug not in emitted_slugs]

    cleanup = _CleanupOutput(slug_renames={}, supersessions={})
    if collisions or archive_candidates:
        cleanup = await _cleanup_llm_call(
            ctx=ctx,
            canonical_topics=canonical_topics,
            collisions=collisions,
            archive_candidates=archive_candidates,
        )

    renamed_canonicals = _apply_renames(canonical_topics, cleanup.slug_renames)
    _assert_no_collision(renamed_canonicals)

    validated = await _assign_topic_ids(
        brain_id=ctx.brain_id,
        repo=repo,
        canonicals=renamed_canonicals,
        local_by_id=local_by_id,
    )

    await _archive_candidates(
        ctx=ctx,
        repo=repo,
        archive_candidates=archive_candidates,
        supersessions=cleanup.supersessions,
        validated=validated,
    )

    await _upsert_topics(repo=repo, brain_id=ctx.brain_id, validated=validated)
    await ctx.session.commit()

    enrich(
        validate_canonical_count=len(validated),
        validate_collisions_resolved=len(cleanup.slug_renames),
        validate_archived_count=len(archive_candidates),
        validate_supersessions_assigned=sum(
            1 for v in cleanup.supersessions.values() if v is not None
        ),
    )
    log_event(
        "pipeline.validate_completed",
        brain_id=str(ctx.brain_id),
        canonical_count=len(validated),
        collisions_resolved=len(cleanup.slug_renames),
        archived_count=len(archive_candidates),
        supersessions_assigned=sum(
            1 for v in cleanup.supersessions.values() if v is not None
        ),
    )
    return validated


# ---------------------------------------------------------------------------
# Step 1 — link_targets intersection
# ---------------------------------------------------------------------------


def _intersect_link_targets(
    canonical_topics: list[CanonicalTopic],
) -> list[CanonicalTopic]:
    """Drop link_targets entries that don't resolve to any emitted slug."""
    slugs = {c.slug for c in canonical_topics}
    out = []
    for c in canonical_topics:
        kept = [t for t in c.link_targets if t in slugs and t != c.slug]
        out.append(c.model_copy(update={"link_targets": kept}))
    return out


# ---------------------------------------------------------------------------
# Step 2 — collision detection
# ---------------------------------------------------------------------------


def _detect_collisions(
    canonical_topics: list[CanonicalTopic],
) -> dict[str, list[int]]:
    """Returns {slug: [canonical indices]} for slugs with >1 canonical."""
    groups: dict[str, list[int]] = {}
    for i, c in enumerate(canonical_topics):
        groups.setdefault(c.slug, []).append(i)
    return {s: idxs for s, idxs in groups.items() if len(idxs) > 1}


# ---------------------------------------------------------------------------
# Step 3 — cleanup LLM call
# ---------------------------------------------------------------------------


async def _cleanup_llm_call(
    *,
    ctx: PipelineContext,
    canonical_topics: list[CanonicalTopic],
    collisions: dict[str, list[int]],
    archive_candidates: list[Topic],
) -> _CleanupOutput:
    prompt_template = await load_prompt(ctx.storage, "cleanup")

    canonical_block = _render_canonical_block(canonical_topics)
    collision_block = _render_collision_block(collisions)
    supersession_block = _render_supersession_block(archive_candidates)

    prompt = (
        prompt_template.replace("{canonical_block}", canonical_block)
        .replace("{collision_block}", collision_block)
        .replace("{supersession_block}", supersession_block)
    )

    try:
        data = await json_llm_call(
            ctx.client,
            model=REDUCE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
        )
    except Exception as e:
        log_event(
            "pipeline.validate_cleanup_failed",
            level=logging.ERROR,
            brain_id=str(ctx.brain_id),
            error=repr(e)[:300],
            collisions=len(collisions),
            archive_candidates=len(archive_candidates),
        )
        raise

    slug_renames: dict[int, str] = {}
    for rename in data.get("slug_renames") or []:
        tag = rename.get("canonical_tag") or ""
        new_slug = (rename.get("new_slug") or "").strip().lower()
        idx = _tag_to_index(tag, "c_", len(canonical_topics))
        if idx is None or not new_slug:
            continue
        slug_renames[idx] = new_slug

    supersessions: dict[UUID, int | None] = {}
    archived_by_tag: dict[str, UUID] = {
        f"a_{i + 1}": t.topic_id for i, t in enumerate(archive_candidates)
    }
    for entry in data.get("supersessions") or []:
        archived_tag = entry.get("archived_tag") or ""
        successor_tag = entry.get("successor_tag")
        topic_id = archived_by_tag.get(archived_tag)
        if topic_id is None:
            continue
        successor_idx: int | None = None
        if successor_tag:
            successor_idx = _tag_to_index(
                successor_tag, "c_", len(canonical_topics)
            )
        supersessions[topic_id] = successor_idx

    return _CleanupOutput(slug_renames=slug_renames, supersessions=supersessions)


def _tag_to_index(tag: str, prefix: str, upper_bound: int) -> int | None:
    if not tag.startswith(prefix):
        return None
    try:
        n = int(tag[len(prefix):])
    except ValueError:
        return None
    idx = n - 1
    if 0 <= idx < upper_bound:
        return idx
    return None


def _render_canonical_block(canonical_topics: list[CanonicalTopic]) -> str:
    lines: list[str] = []
    for i, c in enumerate(canonical_topics, start=1):
        lines.append(f"## c_{i}")
        lines.append(f"slug: {c.slug}")
        lines.append(f"title: {c.title}")
        lines.append(f"description: {c.description}")
        lines.append("")
    return "\n".join(lines)


def _render_collision_block(collisions: dict[str, list[int]]) -> str:
    if not collisions:
        return ""
    lines = ["## Slug collisions", ""]
    for slug, idxs in collisions.items():
        tags = ", ".join(f"c_{i + 1}" for i in idxs)
        lines.append(f'- slug "{slug}" is claimed by: {tags}')
    lines.append("")
    return "\n".join(lines)


def _render_supersession_block(archive_candidates: list[Topic]) -> str:
    if not archive_candidates:
        return ""
    lines = ["## Archived candidates (previous-compile topics with no matching slug)", ""]
    for i, t in enumerate(archive_candidates, start=1):
        lines.append(f"## a_{i}")
        lines.append(f"slug: {t.slug}")
        lines.append(f"title: {t.title}")
        lines.append(f"description: {t.description}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Step 4 — apply renames, verify uniqueness
# ---------------------------------------------------------------------------


def _apply_renames(
    canonical_topics: list[CanonicalTopic],
    renames: dict[int, str],
) -> list[CanonicalTopic]:
    out: list[CanonicalTopic] = []
    for i, c in enumerate(canonical_topics):
        new_slug = renames.get(i)
        if new_slug and new_slug != c.slug:
            out.append(c.model_copy(update={"slug": new_slug}))
        else:
            out.append(c)
    return out


def _assert_no_collision(canonical_topics: list[CanonicalTopic]) -> None:
    seen: set[str] = set()
    dupes: list[str] = []
    for c in canonical_topics:
        if c.slug in seen:
            dupes.append(c.slug)
        seen.add(c.slug)
    if dupes:
        raise RuntimeError(
            f"validate: cleanup LLM did not resolve all slug collisions: {dupes}"
        )


# ---------------------------------------------------------------------------
# Step 5 — slug continuity, topic_id assignment
# ---------------------------------------------------------------------------


async def _assign_topic_ids(
    *,
    brain_id: UUID,
    repo: TopicRepository,
    canonicals: list[CanonicalTopic],
    local_by_id: dict[UUID, LocalTopic],
) -> list[ValidatedCanonicalTopic]:
    out: list[ValidatedCanonicalTopic] = []
    for c in canonicals:
        existing = await repo.get_by_slug(brain_id, c.slug)
        if existing is not None:
            topic_id = existing.topic_id
            is_new = False
        else:
            topic_id = uuid7()
            is_new = True
        merged_uuids: list[UUID] = []
        for s in c.merged_local_topic_ids:
            try:
                merged_uuids.append(UUID(s))
            except (ValueError, TypeError):
                continue
        subsumed: set[UUID] = set()
        for lt_id in merged_uuids:
            lt = local_by_id.get(lt_id)
            if lt is not None:
                subsumed.update(lt.subsumed_idea_ids)
        out.append(
            ValidatedCanonicalTopic(
                topic_id=topic_id,
                slug=c.slug,
                title=c.title,
                description=c.description,
                merged_local_topic_ids=merged_uuids,
                subsumed_idea_ids=sorted(subsumed, key=str),
                link_targets=c.link_targets,
                is_new=is_new,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Step 6 — archive flow
# ---------------------------------------------------------------------------


async def _archive_candidates(
    *,
    ctx: PipelineContext,
    repo: TopicRepository,
    archive_candidates: list[Topic],
    supersessions: dict[UUID, int | None],
    validated: list[ValidatedCanonicalTopic],
) -> None:
    for candidate in archive_candidates:
        successor_idx = supersessions.get(candidate.topic_id)
        successor_topic_id: UUID | None = (
            validated[successor_idx].topic_id if successor_idx is not None else None
        )
        await repo.set_archived(candidate.topic_id, superseded_by=successor_topic_id)
        await _move_wiki_to_archive(
            storage=ctx.storage,
            topic=candidate,
            successor_topic_id=successor_topic_id,
        )


async def _move_wiki_to_archive(
    *,
    storage,
    topic: Topic,
    successor_topic_id: UUID | None,
) -> None:
    article_path = wiki_path(topic.slug)
    content = await storage.read(article_path, strict=False)
    if content is None:
        # Topic had no rendered article yet (e.g., archived before render ran).
        # Nothing on disk to move.
        return
    fm, body = parse_frontmatter(content)
    fm["archived"] = True
    if successor_topic_id is not None:
        fm["superseded_by"] = str(successor_topic_id)
    updated = serialize_frontmatter(fm, body)
    archive_path = f"archive/{topic.topic_id}/{topic.slug}.md"
    await storage.write(archive_path, updated)
    await storage.delete(article_path)


# ---------------------------------------------------------------------------
# Step 7 — topics table upsert
# ---------------------------------------------------------------------------


async def _upsert_topics(
    *,
    repo: TopicRepository,
    brain_id: UUID,
    validated: list[ValidatedCanonicalTopic],
) -> None:
    for v in validated:
        compiled_from_hash = _topic_content_hash(v)
        await repo.upsert(
            topic_id=v.topic_id,
            brain_id=brain_id,
            slug=v.slug,
            title=v.title,
            description=v.description,
            compiled_from_hash=compiled_from_hash,
        )


def _topic_content_hash(v: ValidatedCanonicalTopic) -> str:
    """Content hash per architecture: topic_membership + title + description."""
    parts = [
        v.title,
        v.description,
        *sorted(str(i) for i in v.subsumed_idea_ids),
    ]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]
