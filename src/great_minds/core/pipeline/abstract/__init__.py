"""Phase 2 — abstract.

Five sub-steps:
  2a. partition    (mechanical)  — seeded k-means over idea embeddings
  2b. synthesize   (LLM)         — per-chunk local thematic topics
  2c. premerge     (mechanical)  — exact-match collapse of local topics
  2d. canonicalize (LLM)         — one call, canonical topic registry
  2e. validate     (mechanical)  — link_targets intersection, slug
                                   collision cleanup, archive flow

Only 2b and 2d draw from the LLM. This orchestrator threads each
sub-step's output into the next; sub-phases fetch source cards lazily
from ``IdeaService`` rather than receiving a shared in-memory snapshot.
Returning composed results rather than mutating a bag keeps each
sub-phase's contract explicit.
"""

from uuid import UUID

from openai import AsyncOpenAI

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.documents import WikiArticleService
from great_minds.core.ideas.service import IdeaService
from great_minds.core.pipeline.abstract import (
    canonicalize,
    partition,
    premerge,
    synthesize,
    validate,
)
from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    PipelineProgressStep,
    build_progress_steps,
)
from great_minds.core.settings import Settings
from great_minds.core.storage import Storage
from great_minds.core.telemetry import (
    current_rss_mb,
    enrich,
    log_event,
    telemetry_scope,
    timed_op,
)
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.topics.service import TopicService


ABSTRACT_STEP_LABELS = {
    "group_ideas": "Grouping ideas",
    "synthesize_topics": "Synthesizing topics",
    "merge_candidates": "Merging similar topics",
    "canonicalize_registry": "Organizing topics",
    "validate_registry": "Finalizing topics",
}


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
        wiki_articles: WikiArticleService,
        thematic_hint: str,
        settings: Settings,
        progress: PipelineProgressRunner,
        pipeline_run_id: UUID,
    ) -> None:
        self.storage = storage
        self.client = client
        self.compile_cache = compile_cache
        self.ideas = ideas
        self.topics = topics
        self.wiki_articles = wiki_articles
        self.thematic_hint = thematic_hint
        self.settings = settings
        self.progress = progress
        self.pipeline_run_id = pipeline_run_id

    def progress_steps(
        self,
        active: str,
        *,
        completed: set[str] | None = None,
        counts: dict[str, tuple[int | None, int | None]] | None = None,
    ) -> list[PipelineProgressStep]:
        return build_progress_steps(
            ABSTRACT_STEP_LABELS,
            active,
            completed=completed,
            counts=counts,
        )

    async def run(self, vault_id: UUID) -> list[TopicDetail]:
        """Return validated canonical topics for phase 3 derive."""
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="abstract",
            status="progress",
            steps=self.progress_steps("group_ideas"),
        )

        async def _report_partition_progress(done: int, total: int) -> None:
            await self.progress.emit(
                pipeline_run_id=self.pipeline_run_id,
                phase="abstract",
                status="progress",
                steps=self.progress_steps(
                    "group_ideas",
                    counts={"group_ideas": (done, total)},
                ),
            )

        log_event(
            "memory_checkpoint", phase="partition", at="start", rss_mb=current_rss_mb()
        )
        with telemetry_scope("partition", subphase="partition"):
            async with timed_op("abstract_partition"):
                chunks = await partition.PartitionPhase(
                    ideas=self.ideas,
                    compile_cache=self.compile_cache,
                    target_tokens=self.settings.compile_partition_target_tokens,
                    min_factor=self.settings.compile_partition_min_factor,
                    max_factor=self.settings.compile_partition_max_factor,
                    report_progress=_report_partition_progress,
                ).run(vault_id)
        log_event(
            "memory_checkpoint", phase="partition", at="end", rss_mb=current_rss_mb()
        )
        if not chunks:
            log_event(
                "skipped",
                reason="no_chunks",
            )
            await self.progress.emit(
                pipeline_run_id=self.pipeline_run_id,
                phase="abstract",
                status="completed",
                steps=self.progress_steps("group_ideas", completed={"group_ideas"}),
            )
            return []

        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="abstract",
            status="progress",
            steps=self.progress_steps(
                "synthesize_topics",
                completed={"group_ideas"},
                counts={"synthesize_topics": (0, len(chunks))},
            ),
        )
        log_event(
            "memory_checkpoint", phase="synthesize", at="start", rss_mb=current_rss_mb()
        )
        with telemetry_scope("synthesize", subphase="synthesize"):
            async with timed_op("abstract_synthesize"):
                local_topics = await synthesize.SynthesizePhase(
                    storage=self.storage,
                    client=self.client,
                    compile_cache=self.compile_cache,
                    concurrency=self.settings.compile_enrich_concurrency,
                    progress=self.progress,
                    pipeline_run_id=self.pipeline_run_id,
                    progress_steps=self.progress_steps,
                ).run(vault_id, self.ideas, chunks)
        log_event(
            "memory_checkpoint", phase="synthesize", at="end", rss_mb=current_rss_mb()
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="abstract",
            status="progress",
            steps=self.progress_steps(
                "merge_candidates",
                completed={"group_ideas", "synthesize_topics"},
                counts={"synthesize_topics": (len(chunks), len(chunks))},
            ),
        )
        log_event(
            "memory_checkpoint", phase="premerge", at="start", rss_mb=current_rss_mb()
        )
        with telemetry_scope("premerge", subphase="premerge"):
            async with timed_op("abstract_premerge"):
                merged_topics = premerge.run(
                    local_topics,
                    jaccard_threshold=self.settings.compile_premerge_jaccard_threshold,
                )
        log_event(
            "memory_checkpoint", phase="premerge", at="end", rss_mb=current_rss_mb()
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="abstract",
            status="progress",
            steps=self.progress_steps(
                "canonicalize_registry",
                completed={
                    "group_ideas",
                    "synthesize_topics",
                    "merge_candidates",
                },
                counts={"synthesize_topics": (len(chunks), len(chunks))},
            ),
        )
        log_event(
            "memory_checkpoint",
            phase="canonicalize",
            at="start",
            rss_mb=current_rss_mb(),
        )
        with telemetry_scope("canonicalize", subphase="canonicalize"):
            async with timed_op("abstract_canonicalize"):
                canonical_topics = await canonicalize.CanonicalizePhase(
                    storage=self.storage,
                    client=self.client,
                    compile_cache=self.compile_cache,
                    thematic_hint=self.thematic_hint,
                ).run(vault_id, merged_topics)
        log_event(
            "memory_checkpoint", phase="canonicalize", at="end", rss_mb=current_rss_mb()
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="abstract",
            status="progress",
            steps=self.progress_steps(
                "validate_registry",
                completed={
                    "group_ideas",
                    "synthesize_topics",
                    "merge_candidates",
                    "canonicalize_registry",
                },
                counts={"synthesize_topics": (len(chunks), len(chunks))},
            ),
        )
        log_event(
            "memory_checkpoint", phase="validate", at="start", rss_mb=current_rss_mb()
        )
        with telemetry_scope("validate", subphase="validate"):
            async with timed_op("abstract_validate"):
                validated = await validate.ValidatePhase(
                    storage=self.storage,
                    client=self.client,
                    topics=self.topics,
                    wiki_articles=self.wiki_articles,
                ).run(vault_id, canonical_topics, merged_topics)
        log_event(
            "memory_checkpoint", phase="validate", at="end", rss_mb=current_rss_mb()
        )

        enrich(validated_topics=len(validated))
        log_event(
            "completed",
            chunks=len(chunks),
            local_topics=len(local_topics),
            merged_topics=len(merged_topics),
            canonical_topics=len(canonical_topics),
            validated_topics=len(validated),
        )
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="abstract",
            status="completed",
            steps=self.progress_steps(
                "validate_registry",
                completed=set(ABSTRACT_STEP_LABELS),
                counts={"synthesize_topics": (len(chunks), len(chunks))},
            ),
        )
        return validated
