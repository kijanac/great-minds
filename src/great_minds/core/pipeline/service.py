"""Application service for compiling a vault through all pipeline phases."""

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.documents import (
    SourceDocumentRepo,
    SourceDocumentService,
    WikiArticleRepo,
    WikiArticleService,
)
from great_minds.core.ideas.repository import IdeaRepository
from great_minds.core.ideas.service import IdeaService
from great_minds.core.paths import sidecar_root
import great_minds.core.pipeline.abstract as abstract
import great_minds.core.pipeline.derive as derive
import great_minds.core.pipeline.extract as extract
import great_minds.core.pipeline.ingest as ingest
import great_minds.core.pipeline.publish as publish
import great_minds.core.pipeline.render as render
import great_minds.core.pipeline.verify as verify
from great_minds.core.pipeline.steps import StepRunner, inline_step_runner
from great_minds.core.pipeline_runs import PipelineProgressRunner, phase_step
from great_minds.core.search import SearchIndexRepository, SearchService
from great_minds.core.settings import Settings, get_settings
from great_minds.core.storage import Storage
from great_minds.core.telemetry import log_event, telemetry_scope, timed_op
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.topics.service import TopicService
from great_minds.core.vaults.config import load_vault_config


@dataclass(frozen=True)
class CompilePhases:
    ingest: ingest.IngestPhase
    extract: extract.ExtractPhase
    abstract: abstract.AbstractPhase
    derive: derive.DerivePhase
    render: render.RenderPhase
    verify: verify.VerifyPhase
    publish: publish.PublishPhase


class CompileService:
    """Orchestrate a full compile run."""

    def __init__(
        self,
        *,
        vault_id: UUID,
        pipeline_run_id: UUID,
        progress: PipelineProgressRunner,
        steps: StepRunner,
        phases: CompilePhases,
    ) -> None:
        self.vault_id = vault_id
        self.pipeline_run_id = pipeline_run_id
        self.progress = progress
        self.steps = steps
        self.phases = phases

    async def run(self) -> None:
        with telemetry_scope(
            "compile",
            vault_id=str(self.vault_id),
            pipeline_run_id=str(self.pipeline_run_id),
        ):
            await self.steps.step("phase-ingest", self.run_ingest_step)
            await self.steps.step("phase-extract", self.run_extract_step)

            validated_raw = await self.steps.step(
                "phase-abstract", self.run_abstract_step
            )
            if not validated_raw:
                await self.complete_early_no_topics()
                return
            validated = [TopicDetail.model_validate(topic) for topic in validated_raw]

            await self.steps.step("phase-derive", self.run_derive_step, validated)
            await self.steps.step("phase-render", self.run_render_step, validated)
            await self.steps.step("phase-verify", self.run_verify_step)
            await self.steps.step("phase-publish", self.run_publish_step)

            log_event("completed")

    async def run_ingest_step(self) -> None:
        with telemetry_scope("ingest", phase="ingest"):
            async with timed_op("ingest"):
                await self.phases.ingest.run(self.vault_id)

    async def run_extract_step(self) -> None:
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="extract",
            status="started",
            steps=self.phases.extract.progress_steps("extract_cards"),
        )
        with telemetry_scope("extract", phase="extract"):
            async with timed_op("extract"):
                await self.phases.extract.run(
                    vault_id=self.vault_id, pipeline_run_id=self.pipeline_run_id
                )

    async def run_abstract_step(self) -> list[dict]:
        with telemetry_scope("abstract", phase="abstract"):
            async with timed_op("abstract"):
                topics = await self.phases.abstract.run(self.vault_id)
        return [topic.model_dump(mode="json") for topic in topics]

    async def run_derive_step(self, validated: list[TopicDetail]) -> None:
        with telemetry_scope("derive", phase="derive"):
            async with timed_op("derive"):
                await self.phases.derive.run(self.vault_id, validated)

    async def run_render_step(self, validated: list[TopicDetail]) -> None:
        with telemetry_scope("render", phase="render"):
            async with timed_op("render"):
                await self.phases.render.run(
                    self.vault_id,
                    self.pipeline_run_id,
                    validated,
                )

    async def run_verify_step(self) -> None:
        with telemetry_scope("verify", phase="verify"):
            async with timed_op("verify"):
                await self.phases.verify.run(self.vault_id)

    async def run_publish_step(self) -> None:
        with telemetry_scope("publish", phase="publish"):
            async with timed_op("publish"):
                await self.phases.publish.run(self.vault_id)

    async def complete_early_no_topics(self) -> None:
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="publish",
            status="completed",
            steps=[
                phase_step(
                    phase="publish",
                    status="completed",
                    label="compile completed early: no validated topics",
                    done=1,
                    total=1,
                )
            ],
        )
        log_event(
            "completed_early",
            reason="no_validated_topics",
        )


async def build_compile_service(
    *,
    vault_id: UUID,
    pipeline_run_id: UUID,
    progress: PipelineProgressRunner,
    storage: Storage,
    session: AsyncSession,
    client: AsyncOpenAI,
    steps: StepRunner | None = None,
    settings: Settings | None = None,
) -> CompileService:
    settings = settings or get_settings()
    compile_sidecar_root = sidecar_root(Path(settings.data_dir), vault_id)
    source_docs = SourceDocumentService(SourceDocumentRepo(session))
    wiki_articles = WikiArticleService(WikiArticleRepo(session))
    ideas = IdeaService(repo=IdeaRepository(session))
    search = SearchService(SearchIndexRepository(session))
    topics = TopicService(TopicRepository(session))
    compile_cache = CompileCacheRepository(session)
    step_runner = steps or inline_step_runner()
    config = await load_vault_config(storage)
    return CompileService(
        vault_id=vault_id,
        pipeline_run_id=pipeline_run_id,
        progress=progress,
        steps=step_runner,
        phases=CompilePhases(
            ingest=ingest.IngestPhase(
                storage=storage,
                client=client,
                search=search,
                progress=progress,
                pipeline_run_id=pipeline_run_id,
                source_docs=source_docs,
            ),
            extract=extract.ExtractPhase(
                storage=storage,
                client=client,
                session=session,
                progress=progress,
                compile_cache=compile_cache,
                source_docs=source_docs,
                ideas=ideas,
                config=config,
                concurrency=settings.compile_enrich_concurrency,
            ),
            abstract=abstract.AbstractPhase(
                storage=storage,
                client=client,
                compile_cache=compile_cache,
                ideas=ideas,
                topics=topics,
                wiki_articles=wiki_articles,
                thematic_hint=config.thematic_hint,
                settings=settings,
                progress=progress,
                pipeline_run_id=pipeline_run_id,
            ),
            derive=derive.DerivePhase(
                topics=topics,
                related_limit=settings.compile_derive_related_limit,
                progress=progress,
                pipeline_run_id=pipeline_run_id,
            ),
            render=render.RenderPhase(
                storage=storage,
                client=client,
                session=session,
                progress=progress,
                compile_cache=compile_cache,
                steps=step_runner,
                source_docs=source_docs,
                wiki_articles=wiki_articles,
                topics=topics,
                search=search,
                ideas=ideas,
                concurrency=settings.compile_write_concurrency,
            ),
            verify=verify.VerifyPhase(
                storage=storage,
                topics=topics,
                wiki_articles=wiki_articles,
                progress=progress,
                pipeline_run_id=pipeline_run_id,
            ),
            publish=publish.PublishPhase(
                storage=storage,
                sidecar_root=compile_sidecar_root,
                topics=topics,
                source_docs=source_docs,
                search=search,
                progress=progress,
                pipeline_run_id=pipeline_run_id,
            ),
        ),
    )
