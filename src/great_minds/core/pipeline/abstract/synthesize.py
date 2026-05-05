"""Phase 2b — synthesize.

One LLM call per chunk. Each chunk's ideas are rendered with doc-level
provenance (grouped by doc to avoid repeating headers). The LLM
proposes 10-30 local thematic topics with slug/title/description and
subsumed_idea_ids. Output is cached per chunk under
.compile/<vault_id>/cache/synthesize/<key>.json so incremental compiles
skip the LLM call for chunks whose idea set hasn't changed.

Idea rendering uses short tags (`idea_1`, `idea_2`, ...) to keep UUIDs
out of the LLM's face; we map tags back to real idea_ids on parse.
Unknown tags in the LLM output are silently dropped as hallucinations.
"""

import asyncio
import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from uuid import UUID

from pydantic import ValidationError
from uuid6 import uuid7

from great_minds.core.hashing import content_hash, prompt_hash
from great_minds.core.vaults.prompts import load_prompt
from great_minds.core.llm.client import json_llm_call
from great_minds.core.ideas.schemas import Idea, SourceCard
from great_minds.core.llm import MAP_MODEL
from great_minds.core.pipeline.abstract.schemas import LocalTopic
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import enrich, log_event

log = logging.getLogger(__name__)

PHASE = "synthesize"
_SLUG_RE = re.compile(r"[^a-z0-9-]+")


async def run(
    ctx: PipelineContext,
    source_cards: list[SourceCard],
    chunks: list[list[UUID]],
) -> list[LocalTopic]:
    """Synthesize local topics for each chunk.

    Chunks come from partition; source_cards are loaded once by the
    phase-2 orchestrator and passed through so we don't re-read jsonl.
    """
    if not chunks:
        return []

    settings = get_settings()
    prompt_template = await load_prompt(ctx.storage, "synthesize")
    ph = prompt_hash(prompt_template)
    idea_index: dict[UUID, tuple[Idea, SourceCard]] = {}
    for card in source_cards:
        for idea in card.ideas:
            idea_index[idea.idea_id] = (idea, card)

    sem = asyncio.Semaphore(settings.compile_enrich_concurrency)
    tasks = [
        _synthesize_one(
            ctx=ctx,
            sem=sem,
            chunk_idx=idx,
            chunk=chunk,
            idea_index=idea_index,
            prompt_template=prompt_template,
            prompt_hash=ph,
        )
        for idx, chunk in enumerate(chunks)
    ]
    outcomes = await asyncio.gather(*tasks)

    local_topics: list[LocalTopic] = []
    chunks_processed = 0
    cache_hits = 0
    cache_misses = 0
    chunks_failed = 0
    for outcome in outcomes:
        if outcome.error is not None:
            chunks_failed += 1
            log_event(
                "synthesize.chunk_failed",
                level=logging.WARNING,
                vault_id=str(ctx.vault_id),
                chunk_idx=outcome.chunk_idx,
                error=outcome.error,
            )
            continue
        chunks_processed += 1
        if outcome.cache_hit:
            cache_hits += 1
        else:
            cache_misses += 1
        local_topics.extend(outcome.local_topics)

    enrich(
        synthesize_chunks_processed=chunks_processed,
        synthesize_cache_hits=cache_hits,
        synthesize_cache_misses=cache_misses,
        synthesize_chunks_failed=chunks_failed,
        synthesize_local_topics=len(local_topics),
    )
    log_event(
        "pipeline.synthesize_completed",
        vault_id=str(ctx.vault_id),
        chunks_processed=chunks_processed,
        cache_hits=cache_hits,
        cache_misses=cache_misses,
        chunks_failed=chunks_failed,
        local_topics=len(local_topics),
    )
    return local_topics


# ---------------------------------------------------------------------------
# Per-chunk synthesize
# ---------------------------------------------------------------------------


@dataclass
class _ChunkOutcome:
    chunk_idx: int
    local_topics: list[LocalTopic] = field(default_factory=list)
    cache_hit: bool = False
    error: str | None = None


async def _synthesize_one(
    *,
    ctx: PipelineContext,
    sem: asyncio.Semaphore,
    chunk_idx: int,
    chunk: list[UUID],
    idea_index: dict[UUID, tuple[Idea, SourceCard]],
    prompt_template: str,
    prompt_hash: str,
) -> _ChunkOutcome:
    outcome = _ChunkOutcome(chunk_idx=chunk_idx)

    # Filter to ideas we actually have records for. An idea_id present
    # in partition output but missing from source_cards would be a bug
    # further upstream — log and skip rather than synthesize a phantom.
    present = [iid for iid in chunk if iid in idea_index]
    if not present:
        outcome.error = "no_ideas_indexed"
        return outcome

    cache_key = _cache_key(idea_ids=present, prompt_hash=prompt_hash, model=MAP_MODEL)

    cached = ctx.cache.get(PHASE, cache_key)
    if cached is not None:
        try:
            outcome.local_topics = [
                LocalTopic.model_validate(t) for t in cached["local_topics"]
            ]
            outcome.cache_hit = True
            return outcome
        except ValidationError as e:
            # Cache corrupted / schema drifted — re-run.
            log_event(
                "synthesize.cache_invalid",
                level=logging.WARNING,
                chunk_idx=chunk_idx,
                error=str(e)[:200],
            )

    idea_block, tag_to_uuid = _render_idea_block(present, idea_index)
    prompt = prompt_template.replace("{idea_block}", idea_block)

    try:
        async with sem:
            data = await json_llm_call(
                ctx.client,
                model=MAP_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
            )
        outcome.local_topics = _parse_topics(
            data=data,
            chunk_idx=chunk_idx,
            tag_to_uuid=tag_to_uuid,
        )
    except json.JSONDecodeError as e:
        outcome.error = f"json_parse_exhausted:{e}"
        return outcome
    except Exception as e:
        outcome.error = f"llm_call:{repr(e)[:200]}"
        return outcome

    ctx.cache.put(
        PHASE,
        cache_key,
        {
            "local_topics": [t.model_dump(mode="json") for t in outcome.local_topics],
        },
    )
    return outcome


def _cache_key(*, idea_ids: list[UUID], prompt_hash: str, model: str) -> str:
    return content_hash(
        *sorted(str(iid) for iid in idea_ids),
        f"prompt={prompt_hash}",
        f"model={model}",
    )


def _render_idea_block(
    idea_ids: list[UUID],
    idea_index: dict[UUID, tuple[Idea, SourceCard]],
) -> tuple[str, dict[str, UUID]]:
    """Group ideas by document, render with doc provenance, assign
    local tags (idea_1, idea_2, ...). Returns the prompt block and the
    tag→uuid map used to resolve LLM output.
    """
    by_doc: dict[UUID, list[Idea]] = defaultdict(list)
    card_by_doc: dict[UUID, SourceCard] = {}
    for iid in idea_ids:
        idea, card = idea_index[iid]
        by_doc[idea.document_id].append(idea)
        card_by_doc[idea.document_id] = card

    tag_to_uuid: dict[str, UUID] = {}
    lines: list[str] = []
    counter = 0
    for doc_id in sorted(by_doc, key=str):
        card = card_by_doc[doc_id]
        meta = card.doc_metadata
        lines.append(f"## Doc: {card.title}")
        if meta.genre:
            lines.append(f"Genre: {meta.genre}")
        if card.precis:
            lines.append(f"Precis: {card.precis}")
        context_bits = []
        if meta.tradition:
            context_bits.append(f"Tradition: {meta.tradition}")
        if meta.interlocutors:
            context_bits.append(f"Interlocutors: {', '.join(meta.interlocutors)}")
        if meta.tags:
            context_bits.append(f"Tags: {', '.join(meta.tags)}")
        if context_bits:
            lines.append("; ".join(context_bits))
        lines.append("Ideas:")
        for idea in by_doc[doc_id]:
            counter += 1
            tag = f"idea_{counter}"
            tag_to_uuid[tag] = idea.idea_id
            lines.append(f"- {tag} [{idea.kind}] {idea.label}: {idea.description}")
        lines.append("")

    return "\n".join(lines), tag_to_uuid


def _parse_topics(
    *,
    data: dict,
    chunk_idx: int,
    tag_to_uuid: dict[str, UUID],
) -> list[LocalTopic]:
    out: list[LocalTopic] = []
    for raw in data.get("topics") or []:
        slug = _normalize_slug(raw.get("slug") or "")
        title = (raw.get("title") or "").strip()
        description = (raw.get("description") or "").strip()
        subsumed_tags = raw.get("subsumed_idea_ids") or []
        subsumed_uuids = [
            tag_to_uuid[tag] for tag in subsumed_tags if tag in tag_to_uuid
        ]
        if not slug or not title or not subsumed_uuids:
            continue
        out.append(
            LocalTopic(
                local_topic_id=uuid7(),
                chunk_idx=chunk_idx,
                slug=slug,
                title=title,
                description=description,
                subsumed_idea_ids=subsumed_uuids,
            )
        )
    return out


def _normalize_slug(slug: str) -> str:
    s = slug.strip().lower().replace(" ", "-").replace("_", "-")
    s = _SLUG_RE.sub("", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s
