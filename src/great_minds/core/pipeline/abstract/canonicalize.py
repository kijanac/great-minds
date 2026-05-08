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

import logging
from uuid import UUID

from openai import AsyncOpenAI

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.hashing import content_hash, prompt_hash
from great_minds.core.llm import REDUCE_MODEL
from great_minds.core.llm.client import json_llm_call
from great_minds.core.pipeline.abstract.schemas import LocalTopic
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.topics.schemas import CanonicalTopicDraft
from great_minds.core.vaults.prompts import load_prompt

log = logging.getLogger(__name__)

PHASE = "canonicalize"


class CanonicalizePhase:
    """Phase 2d runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        compile_cache: CompileCacheRepository,
        thematic_hint: str,
    ) -> None:
        self.storage = storage
        self.client = client
        self.compile_cache = compile_cache
        self.thematic_hint = thematic_hint

    async def run(
        self, vault_id: UUID, local_topics: list[LocalTopic]
    ) -> list[CanonicalTopicDraft]:
        """Consolidate local topics into canonical registry.

        One LLM call, no retries at this layer — failure propagates. Local
        topics are referenced in the prompt by short lt_N tags to keep
        UUIDs out of the LLM's face; parse maps back.
        """
        if not local_topics:
            log_event(
                "pipeline.canonicalize_skipped",
                vault_id=str(vault_id),
                reason="no_local_topics",
            )
            return []

        prompt_template = await load_prompt(self.storage, "canonicalize")
        ph = prompt_hash(prompt_template)

        ordered = sorted(local_topics, key=lambda t: str(t.local_topic_id))
        tag_to_uuid, local_topic_block = _render_local_topics(ordered)

        cache_key = _cache_key(
            ordered=ordered,
            prompt_hash=ph,
            thematic_hint=self.thematic_hint,
        )

        cached = await self.compile_cache.get(
            vault_id=vault_id,
            phase=PHASE,
            cache_key=cache_key,
        )
        if cached is not None:
            canonical_topics = [
                CanonicalTopicDraft.model_validate(c)
                for c in cached["canonical_topics"]
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
                vault_id=str(vault_id),
                canonical_count=len(canonical_topics),
                orphan_count=orphans,
            )
            return canonical_topics

        prompt = _render_prompt(
            prompt_template=prompt_template,
            thematic_hint=self.thematic_hint,
            local_topic_block=local_topic_block,
        )

        data = await json_llm_call(
            self.client,
            model=REDUCE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
        )

        canonical_topics, unknown_tag_count = _parse_canonicals(
            data=data, tag_to_uuid=tag_to_uuid
        )

        covered = _covered_local_ids(canonical_topics, set(tag_to_uuid.values()))
        orphans = len(tag_to_uuid) - len(covered)

        await self.compile_cache.put(
            vault_id=vault_id,
            phase=PHASE,
            cache_key=cache_key,
            value={
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
            vault_id=str(vault_id),
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
            f"The wiki's editorial lens for this vault:\n\n{thematic_hint.strip()}\n\n"
        )
    return prompt_template.replace("{thematic_hint_block}", hint_block).replace(
        "{local_topic_block}", local_topic_block
    )


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_canonicals(
    *, data: dict, tag_to_uuid: dict[str, UUID]
) -> tuple[list[CanonicalTopicDraft], int]:
    """Parse raw LLM JSON into the internal canonical-topic model."""
    out: list[CanonicalTopicDraft] = []
    unknown_tag_count = 0
    for raw in data.get("canonical_topics") or []:
        if not isinstance(raw, dict):
            continue
        slug = (raw.get("slug") or "").strip()
        title = (raw.get("title") or "").strip()
        description = (raw.get("description") or "").strip()
        raw_tags = raw.get("merged_local_topic_ids") or []
        raw_link_targets = raw.get("link_targets") or []

        resolved_ids: set[UUID] = set()
        for tag in raw_tags:
            uuid = tag_to_uuid.get(tag)
            if uuid is None:
                unknown_tag_count += 1
                continue
            resolved_ids.add(uuid)

        if not slug or not title or not resolved_ids:
            # Missing slug/title or no local topics subsumed — can't
            # build a sensible canonical. Drop.
            continue

        out.append(
            CanonicalTopicDraft(
                slug=slug,
                title=title,
                description=description,
                merged_local_topic_ids=sorted(resolved_ids, key=str),
                link_targets=[str(t).strip() for t in raw_link_targets if t],
            )
        )
    return out, unknown_tag_count


def _covered_local_ids(
    canonicals: list[CanonicalTopicDraft], all_uuids: set[UUID]
) -> set[UUID]:
    return {
        local_topic_id
        for c in canonicals
        for local_topic_id in c.merged_local_topic_ids
        if local_topic_id in all_uuids
    }


# ---------------------------------------------------------------------------
# Cache key
# ---------------------------------------------------------------------------


def _topic_content_hash(t: LocalTopic) -> str:
    return content_hash(
        t.slug,
        t.title,
        t.description,
        *sorted(str(i) for i in t.subsumed_idea_ids),
    )


def _cache_key(
    *,
    ordered: list[LocalTopic],
    prompt_hash: str,
    thematic_hint: str,
) -> str:
    return content_hash(
        *(str(t.local_topic_id) + ":" + _topic_content_hash(t) for t in ordered),
        f"prompt={prompt_hash}",
        f"hint={content_hash(thematic_hint)}",
        f"model={REDUCE_MODEL}",
    )
