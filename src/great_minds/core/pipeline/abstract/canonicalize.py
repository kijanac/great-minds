"""Phase 2d — canonicalize.

One LLM call that reduces all pre-merged local topics into the
canonical article-level registry. This is the editorial layer — the
reducer sees everything synthesize proposed across chunks and decides
what the wiki's actual articles are.

Cache key includes per-topic content hashes so changing a local
topic's title/description/subsumed ideas (even under the same lt_id)
invalidates correctly. Thematic hint also in the key — it shapes the
output.

Failure handling: any error here is a critical-path failure (the
pipeline can't proceed without a topic registry), so exceptions
propagate. Unknown lt_N tags in LLM output are dropped silently
(hallucinations). Orphaned local topics — ones not referenced by any
canonical — are logged as a quality signal but don't fail the phase;
a lossy registry still beats no registry, and the user can re-run.
"""

from __future__ import annotations

import hashlib
import logging
from uuid import UUID

from great_minds.core.brain import load_prompt
from great_minds.core.llm.client import json_llm_call
from great_minds.core.llm import REDUCE_MODEL
from great_minds.core.pipeline.abstract.schemas import LocalTopic
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.schemas import CanonicalTopic

log = logging.getLogger(__name__)

PHASE = "canonicalize"


async def run(
    ctx: PipelineContext, local_topics: list[LocalTopic]
) -> list[CanonicalTopic]:
    """Consolidate local topics into canonical registry.

    One LLM call, no retries at this layer — failure propagates. Local
    topics are referenced in the prompt by short lt_N tags to keep
    UUIDs out of the LLM's face; parse maps back.
    """
    if not local_topics:
        log_event(
            "pipeline.canonicalize_skipped",
            brain_id=str(ctx.brain_id),
            reason="no_local_topics",
        )
        return []

    prompt_template = await load_prompt(ctx.storage, "canonicalize")
    prompt_hash = hashlib.sha256(prompt_template.encode()).hexdigest()

    ordered = sorted(local_topics, key=lambda t: str(t.local_topic_id))
    tag_to_uuid, local_topic_block = _render_local_topics(ordered)

    cache_key = _cache_key(
        ordered=ordered,
        prompt_hash=prompt_hash,
        thematic_hint=ctx.config.thematic_hint,
    )

    cached = ctx.cache.get(PHASE, cache_key)
    if cached is not None:
        canonical_topics = [
            CanonicalTopic.model_validate(c) for c in cached["canonical_topics"]
        ]
        covered = _covered_local_ids(canonical_topics, set(tag_to_uuid.values()))
        orphans = len(tag_to_uuid) - len(covered)
        enrich(
            canonicalize_cache_hit=True,
            canonicalize_input_local_topics=len(local_topics),
            canonicalize_output_canonical_topics=len(canonical_topics),
            canonicalize_orphan_count=orphans,
        )
        log_event(
            "pipeline.canonicalize_cached",
            brain_id=str(ctx.brain_id),
            canonical_count=len(canonical_topics),
            orphan_count=orphans,
        )
        return canonical_topics

    prompt = _render_prompt(
        prompt_template=prompt_template,
        thematic_hint=ctx.config.thematic_hint,
        local_topic_block=local_topic_block,
    )

    data = await json_llm_call(
        ctx.client,
        model=REDUCE_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )

    canonical_topics, unknown_tag_count = _parse_canonicals(
        data=data, tag_to_uuid=tag_to_uuid
    )

    covered = _covered_local_ids(canonical_topics, set(tag_to_uuid.values()))
    orphans = len(tag_to_uuid) - len(covered)

    ctx.cache.put(
        PHASE,
        cache_key,
        {
            "canonical_topics": [
                c.model_dump(mode="json") for c in canonical_topics
            ]
        },
    )

    enrich(
        canonicalize_cache_hit=False,
        canonicalize_input_local_topics=len(local_topics),
        canonicalize_output_canonical_topics=len(canonical_topics),
        canonicalize_orphan_count=orphans,
        canonicalize_unknown_tag_count=unknown_tag_count,
    )
    log_event(
        "pipeline.canonicalize_completed",
        brain_id=str(ctx.brain_id),
        input_local_topics=len(local_topics),
        output_canonical_topics=len(canonical_topics),
        orphan_count=orphans,
        unknown_tag_count=unknown_tag_count,
    )
    return canonical_topics


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _render_local_topics(
    ordered: list[LocalTopic],
) -> tuple[dict[str, UUID], str]:
    """Assign lt_N tags and format the local-topic block for the prompt."""
    tag_to_uuid: dict[str, UUID] = {}
    lines: list[str] = []
    for i, t in enumerate(ordered, start=1):
        tag = f"lt_{i}"
        tag_to_uuid[tag] = t.local_topic_id
        lines.append(f"## {tag}")
        lines.append(f"slug: {t.slug}")
        lines.append(f"title: {t.title}")
        lines.append(f"description: {t.description}")
        lines.append(f"subsumed idea count: {len(t.subsumed_idea_ids)}")
        lines.append("")
    return tag_to_uuid, "\n".join(lines)


def _render_prompt(
    *,
    prompt_template: str,
    thematic_hint: str,
    local_topic_block: str,
) -> str:
    hint_block = ""
    if thematic_hint.strip():
        hint_block = (
            "The wiki's editorial lens for this brain:\n\n"
            f"{thematic_hint.strip()}\n\n"
        )
    return prompt_template.replace("{thematic_hint_block}", hint_block).replace(
        "{local_topic_block}", local_topic_block
    )


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_canonicals(
    *, data: dict, tag_to_uuid: dict[str, UUID]
) -> tuple[list[CanonicalTopic], int]:
    out: list[CanonicalTopic] = []
    unknown_tag_count = 0
    for raw in data.get("canonical_topics") or []:
        slug = (raw.get("slug") or "").strip()
        title = (raw.get("title") or "").strip()
        description = (raw.get("description") or "").strip()
        raw_tags = raw.get("merged_local_topic_ids") or []
        raw_link_targets = raw.get("link_targets") or []

        resolved_ids: list[str] = []
        for tag in raw_tags:
            uuid = tag_to_uuid.get(tag)
            if uuid is None:
                unknown_tag_count += 1
                continue
            resolved_ids.append(str(uuid))

        if not slug or not title or not resolved_ids:
            # Missing slug/title or no local topics subsumed — can't
            # build a sensible canonical. Drop.
            continue

        out.append(
            CanonicalTopic(
                slug=slug,
                title=title,
                description=description,
                merged_local_topic_ids=resolved_ids,
                link_targets=[str(t).strip() for t in raw_link_targets if t],
            )
        )
    return out, unknown_tag_count


def _covered_local_ids(
    canonicals: list[CanonicalTopic], all_uuids: set[UUID]
) -> set[UUID]:
    covered: set[UUID] = set()
    for c in canonicals:
        for s in c.merged_local_topic_ids:
            try:
                covered.add(UUID(s))
            except (ValueError, TypeError):
                continue
    return covered & all_uuids


# ---------------------------------------------------------------------------
# Cache key
# ---------------------------------------------------------------------------


def _topic_content_hash(t: LocalTopic) -> str:
    parts = [
        t.slug,
        t.title,
        t.description,
        *sorted(str(i) for i in t.subsumed_idea_ids),
    ]
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


def _cache_key(
    *,
    ordered: list[LocalTopic],
    prompt_hash: str,
    thematic_hint: str,
) -> str:
    h = hashlib.sha256()
    for t in ordered:
        h.update(str(t.local_topic_id).encode())
        h.update(b":")
        h.update(_topic_content_hash(t).encode())
        h.update(b";")
    h.update(f"prompt={prompt_hash}".encode())
    hint_hash = hashlib.sha256(thematic_hint.encode()).hexdigest()[:16]
    h.update(f"::hint={hint_hash}::model={REDUCE_MODEL}".encode())
    return h.hexdigest()
