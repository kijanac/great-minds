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
from uuid import UUID, uuid7

from openai import AsyncOpenAI
from pydantic import ValidationError

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.hashing import content_hash, prompt_hash
from great_minds.core.vaults.prompts import load_prompt
from great_minds.core.llm.client import json_llm_call
from great_minds.core.ideas.schemas import DocMetadata
from great_minds.core.ideas.source_cards import SourceCardStore
from great_minds.core.llm import MAP_MODEL
from great_minds.core.pipeline.abstract.schemas import LocalTopic
from great_minds.core.pipeline_runs import PipelineProgressRunner
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event

log = logging.getLogger(__name__)

PHASE = "synthesize"
_SLUG_RE = re.compile(r"[^a-z0-9-]+")


class SynthesizePhase:
    """Phase 2b runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        compile_cache: CompileCacheRepository,
        concurrency: int,
        progress: PipelineProgressRunner,
        pipeline_run_id: UUID,
        progress_steps,
    ) -> None:
        self.storage = storage
        self.client = client
        self.compile_cache = compile_cache
        self.concurrency = concurrency
        self.progress = progress
        self.pipeline_run_id = pipeline_run_id
        self.progress_steps = progress_steps

    async def run(
        self,
        vault_id: UUID,
        source_cards: SourceCardStore,
        chunks: list[list[UUID]],
    ) -> list[LocalTopic]:
        """Synthesize local topics for each chunk.

        Chunks come from partition; source cards are loaded lazily per chunk
        so large compiles don't retain every extracted idea/anchor in memory.
        """
        if not chunks:
            return []

        prompt_template = await load_prompt(self.storage, "synthesize")
        ph = prompt_hash(prompt_template)
        synthesis_index = await _build_synthesis_index(source_cards, chunks)

        sem = asyncio.Semaphore(self.concurrency)
        tasks = [
            _synthesize_one(
                vault_id=vault_id,
                client=self.client,
                compile_cache=self.compile_cache,
                sem=sem,
                chunk_idx=idx,
                chunk=chunk,
                synthesis_index=synthesis_index,
                prompt_template=prompt_template,
                prompt_hash=ph,
            )
            for idx, chunk in enumerate(chunks)
        ]
        outcomes: list[_ChunkOutcome] = []
        chunks_done = 0
        for task in asyncio.as_completed(tasks):
            outcome = await task
            outcomes.append(outcome)
            chunks_done += 1
            await self.progress.emit(
                pipeline_run_id=self.pipeline_run_id,
                phase="abstract",
                status="progress",
                steps=self.progress_steps(
                    "synthesize_topics",
                    completed={"group_ideas"},
                    counts={"synthesize_topics": (chunks_done, len(chunks))},
                ),
            )

        local_topics: list[LocalTopic] = []
        chunks_processed = 0
        cache_hits = 0
        cache_misses = 0
        chunks_failed = 0
        for outcome in outcomes:
            if outcome.error is not None:
                chunks_failed += 1
                log_event(
                    "chunk_failed",
                    level=logging.WARNING,
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
            "completed",
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


@dataclass(frozen=True)
class _SynthesisDoc:
    title: str
    precis: str
    metadata: DocMetadata


@dataclass(frozen=True)
class _SynthesisIdea:
    idea_id: UUID
    document_id: UUID
    kind: str
    label: str
    description: str


@dataclass(frozen=True)
class _SynthesisIndex:
    ideas: dict[UUID, _SynthesisIdea]
    docs: dict[UUID, _SynthesisDoc]


@dataclass
class _ChunkOutcome:
    chunk_idx: int
    local_topics: list[LocalTopic] = field(default_factory=list)
    cache_hit: bool = False
    error: str | None = None


async def _synthesize_one(
    *,
    vault_id: UUID,
    client: AsyncOpenAI,
    compile_cache: CompileCacheRepository,
    sem: asyncio.Semaphore,
    chunk_idx: int,
    chunk: list[UUID],
    synthesis_index: _SynthesisIndex,
    prompt_template: str,
    prompt_hash: str,
) -> _ChunkOutcome:
    outcome = _ChunkOutcome(chunk_idx=chunk_idx)

    if not chunk:
        outcome.error = "empty_chunk"
        return outcome

    cache_key = _cache_key(idea_ids=chunk, prompt_hash=prompt_hash, model=MAP_MODEL)

    cached = await compile_cache.get(
        vault_id=vault_id,
        phase=PHASE,
        cache_key=cache_key,
    )
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
                "cache_invalid",
                level=logging.WARNING,
                chunk_idx=chunk_idx,
                error=str(e)[:200],
            )

    # Filter to ideas we actually have records for. An idea_id present
    # in partition output but missing from source_cards would be a bug
    # further upstream — log and skip rather than synthesize a phantom.
    present = [iid for iid in chunk if iid in synthesis_index.ideas]
    if not present:
        outcome.error = "no_ideas_indexed"
        return outcome

    try:
        async with sem:
            idea_block, tag_to_uuid = _render_idea_block(present, synthesis_index)
            prompt = prompt_template.replace("{idea_block}", idea_block)
            data = await json_llm_call(
                client,
                model=MAP_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
            )
        outcome.local_topics = _parse_topics(
            data=data,
            chunk_idx=chunk_idx,
            tag_to_uuid=tag_to_uuid,
        )
    except (json.JSONDecodeError, ValidationError) as e:
        outcome.error = f"output_parse:{e}"
        return outcome
    except Exception as e:
        outcome.error = f"llm_call:{repr(e)[:200]}"
        return outcome

    await compile_cache.put(
        vault_id=vault_id,
        phase=PHASE,
        cache_key=cache_key,
        value={
            "local_topics": [t.model_dump(mode="json") for t in outcome.local_topics],
        },
    )
    return outcome


async def _build_synthesis_index(
    source_cards: SourceCardStore,
    chunks: list[list[UUID]],
) -> _SynthesisIndex:
    wanted = {idea_id for chunk in chunks for idea_id in chunk}
    ideas: dict[UUID, _SynthesisIdea] = {}
    docs: dict[UUID, _SynthesisDoc] = {}
    if not wanted:
        return _SynthesisIndex(ideas=ideas, docs=docs)

    async for card in source_cards.iter_cards():
        matched = False
        for idea in card.ideas:
            if idea.idea_id not in wanted:
                continue
            matched = True
            ideas[idea.idea_id] = _SynthesisIdea(
                idea_id=idea.idea_id,
                document_id=idea.document_id,
                kind=idea.kind,
                label=idea.label,
                description=idea.description,
            )
            wanted.remove(idea.idea_id)
        if matched:
            docs[card.document_id] = _SynthesisDoc(
                title=card.title,
                precis=card.precis,
                metadata=card.doc_metadata,
            )
        if not wanted:
            break
    return _SynthesisIndex(ideas=ideas, docs=docs)


def _cache_key(*, idea_ids: list[UUID], prompt_hash: str, model: str) -> str:
    return content_hash(
        *sorted(str(iid) for iid in idea_ids),
        f"prompt={prompt_hash}",
        f"model={model}",
    )


def _render_idea_block(
    idea_ids: list[UUID],
    synthesis_index: _SynthesisIndex,
) -> tuple[str, dict[str, UUID]]:
    """Group ideas by document, render with doc provenance, assign
    local tags (idea_1, idea_2, ...). Returns the prompt block and the
    tag→uuid map used to resolve LLM output.
    """
    by_doc: dict[UUID, list[_SynthesisIdea]] = defaultdict(list)
    for iid in idea_ids:
        idea = synthesis_index.ideas[iid]
        by_doc[idea.document_id].append(idea)

    tag_to_uuid: dict[str, UUID] = {}
    lines: list[str] = []
    counter = 0
    for doc_id in sorted(by_doc, key=str):
        card = synthesis_index.docs[doc_id]
        meta = card.metadata
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
    """Parse raw LLM JSON into internal local-topic models."""
    out: list[LocalTopic] = []
    for raw in data.get("topics") or []:
        if not isinstance(raw, dict):
            continue
        slug = _normalize_slug(raw.get("slug") or "")
        title = (raw.get("title") or "").strip()
        description = (raw.get("description") or "").strip()
        subsumed_tags = raw.get("subsumed_idea_ids") or []
        subsumed_uuids = sorted(
            {tag_to_uuid[tag] for tag in subsumed_tags if tag in tag_to_uuid}, key=str
        )
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
