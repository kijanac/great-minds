"""Application service for compiling a vault through all pipeline phases."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import ParamSpec, TypeVar
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.documents import DocumentRepository, DocumentService
from great_minds.core.ideas.repository import IdeaEmbeddingRepository
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
from great_minds.core.pipeline_runs import PipelineProgressRunner
from great_minds.core.search import SearchIndexRepository, SearchService
from great_minds.core.settings import Settings, get_settings
from great_minds.core.storage import Storage
from great_minds.core.telemetry import log_event, telemetry_scope, timed_op
from great_minds.core.topics.repository import TopicRepository
from great_minds.core.topics.schemas import TopicDetail
from great_minds.core.topics.service import TopicService
from great_minds.core.vaults.config import load_vault_config

P = ParamSpec("P")
T = TypeVar("T")


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

    async def run_phase(
        self,
        phase: str,
        total: int,
        done: int | None,
        message: str | None,
        fn: Callable[P, Awaitable[T]],
        *args: P.args,
        **kwargs: P.kwargs,
    ) -> T:
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase=phase,
            status="started",
            done=0,
            total=total,
        )
        with telemetry_scope(phase, phase=phase):
            async with timed_op(phase):
                result = await fn(*args, **kwargs)
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase=phase,
            status="completed",
            **({"done": done} if done is not None else {}),
            total=total,
            **({"message": message} if message is not None else {}),
        )
        return result

    async def run_ingest_step(self) -> None:
        await self.run_phase(
            "ingest", 1, 1, None, self.phases.ingest.run, self.vault_id
        )

    async def run_extract_step(self) -> None:
        await self.run_phase(
            "extract",
            0,
            None,
            None,
            self.phases.extract.run,
            self.vault_id,
            self.pipeline_run_id,
        )

    async def run_abstract_step(self) -> list[dict]:
        topics = await self.run_phase(
            "abstract", 1, 1, None, self.phases.abstract.run, self.vault_id
        )
        result = [topic.model_dump(mode="json") for topic in topics]
        if not result:
            await self.progress.emit(
                pipeline_run_id=self.pipeline_run_id,
                phase="abstract",
                status="completed",
                done=1,
                total=1,
                message="no validated topics",
            )
        return result

    async def run_derive_step(self, validated: list[TopicDetail]) -> None:
        await self.run_phase(
            "derive", 1, 1, None, self.phases.derive.run, self.vault_id, validated
        )

    async def run_render_step(self, validated: list[TopicDetail]) -> None:
        await self.run_phase(
            "render",
            0,
            None,
            None,
            self.phases.render.run,
            self.vault_id,
            self.pipeline_run_id,
            validated,
        )

    async def run_verify_step(self) -> None:
        await self.run_phase(
            "verify", 1, 1, None, self.phases.verify.run, self.vault_id
        )

    async def run_publish_step(self) -> None:
        await self.run_phase(
            "publish", 1, 1, None, self.phases.publish.run, self.vault_id
        )

    async def complete_early_no_topics(self) -> None:
        await self.progress.emit(
            pipeline_run_id=self.pipeline_run_id,
            phase="publish",
            status="completed",
            done=1,
            total=1,
            message="compile completed early: no validated topics",
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
    documents = DocumentService(DocumentRepository(session))
    ideas = IdeaService(
        embedding_repo=IdeaEmbeddingRepository(session),
        storage=storage,
    )
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
            ),
            extract=extract.ExtractPhase(
                storage=storage,
                client=client,
                session=session,
                progress=progress,
                compile_cache=compile_cache,
                documents=documents,
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
                documents=documents,
                thematic_hint=config.thematic_hint,
                settings=settings,
            ),
            derive=derive.DerivePhase(
                topics=topics,
                related_limit=settings.compile_derive_related_limit,
            ),
            render=render.RenderPhase(
                storage=storage,
                client=client,
                session=session,
                progress=progress,
                compile_cache=compile_cache,
                steps=step_runner,
                documents=documents,
                topics=topics,
                search=search,
                source_cards=ideas.source_cards,
                concurrency=settings.compile_write_concurrency,
            ),
            verify=verify.VerifyPhase(
                storage=storage,
                topics=topics,
                documents=documents,
            ),
            publish=publish.PublishPhase(
                storage=storage,
                sidecar_root=compile_sidecar_root,
                topics=topics,
                documents=documents,
                search=search,
            ),
        ),
    )
