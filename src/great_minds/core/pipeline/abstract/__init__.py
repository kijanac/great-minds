"""Phase 2 — abstract.

Five sub-steps:
  2a. partition    (mechanical)  — seeded k-means over idea embeddings
  2b. synthesize   (LLM)         — per-chunk local thematic topics
  2c. premerge     (mechanical)  — exact-match collapse of local topics
  2d. canonicalize (LLM)         — one call, canonical topic registry
  2e. validate     (mechanical)  — link_targets intersection, slug
                                   collision cleanup, archive flow

Only 2b and 2d draw from the LLM. This orchestrator owns the shared
state (source_cards loaded once, chunks passed through) and threads
each sub-step's output into the next. Returning composed results
rather than mutating a bag keeps each sub-phase's contract explicit.
"""

from uuid import UUID

from openai import AsyncOpenAI

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.documents import DocumentService
from great_minds.core.ideas.service import IdeaService
from great_minds.core.pipeline.abstract import (
    canonicalize,
    partition,
    premerge,
    synthesize,
    validate,
)
from great_minds.core.settings import Settings
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event, telemetry_scope, timed_op
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.topics.service import TopicService


class AbstractPhase:
    """Phase 2 runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        compile_cache: CompileCacheRepository,
        ideas: IdeaService,
        topics: TopicService,
        documents: DocumentService,
        thematic_hint: str,
        settings: Settings,
    ) -> None:
        self.storage = storage
        self.client = client
        self.compile_cache = compile_cache
        self.ideas = ideas
        self.topics = topics
        self.documents = documents
        self.thematic_hint = thematic_hint
        self.settings = settings

    async def run(self, vault_id: UUID) -> list[TopicDetail]:
        """Return validated canonical topics for phase 3 derive."""
        source_cards = self.ideas.source_cards

        with telemetry_scope("partition", subphase="partition"):
            async with timed_op("abstract_partition"):
                chunks = await partition.PartitionPhase(
                    ideas=self.ideas,
                    compile_cache=self.compile_cache,
                    target_tokens=self.settings.compile_partition_target_tokens,
                    min_factor=self.settings.compile_partition_min_factor,
                    max_factor=self.settings.compile_partition_max_factor,
                ).run(vault_id, source_cards)
        if not chunks:
            log_event(
                "skipped",
                reason="no_chunks",
            )
            return []

        with telemetry_scope("synthesize", subphase="synthesize"):
            async with timed_op("abstract_synthesize"):
                local_topics = await synthesize.SynthesizePhase(
                    storage=self.storage,
                    client=self.client,
                    compile_cache=self.compile_cache,
                    concurrency=self.settings.compile_enrich_concurrency,
                ).run(vault_id, source_cards, chunks)
        with telemetry_scope("premerge", subphase="premerge"):
            async with timed_op("abstract_premerge"):
                merged_topics = premerge.run(
                    local_topics,
                    jaccard_threshold=self.settings.compile_premerge_jaccard_threshold,
                )
        with telemetry_scope("canonicalize", subphase="canonicalize"):
            async with timed_op("abstract_canonicalize"):
                canonical_topics = await canonicalize.CanonicalizePhase(
                    storage=self.storage,
                    client=self.client,
                    compile_cache=self.compile_cache,
                    thematic_hint=self.thematic_hint,
                ).run(vault_id, merged_topics)
        with telemetry_scope("validate", subphase="validate"):
            async with timed_op("abstract_validate"):
                validated = await validate.ValidatePhase(
                    storage=self.storage,
                    client=self.client,
                    topics=self.topics,
                    documents=self.documents,
                ).run(vault_id, canonical_topics, merged_topics)

        enrich(validated_topics=len(validated))
        log_event(
            "completed",
            chunks=len(chunks),
            local_topics=len(local_topics),
            merged_topics=len(merged_topics),
            canonical_topics=len(canonical_topics),
            validated_topics=len(validated),
        )
        return validated
