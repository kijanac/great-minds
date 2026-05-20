"""User-visible job application service."""

from uuid import UUID

import httpx

from great_minds.core.ingest_service import IngestService
from great_minds.core.pipeline_runs import (
    PipelineRun,
    PipelineRunCreate,
    PipelineRunService,
    PipelineRunUpdate,
    PipelineTrigger,
    build_progress_steps,
)
from great_minds.core.storage import Storage


class JobNotFoundError(RuntimeError):
    """Raised when a just-created job cannot be reloaded."""


class UrlJobSourceError(ValueError):
    """Raised when URL source ingestion fails before the pipeline can continue."""


URL_INGEST_STEP_LABELS = {
    "fetch_url": "Fetching source URL",
    "convert_document": "Converting source document",
    "index_document": "Indexing source document",
}


class JobService:
    def __init__(
        self,
        *,
        pipeline_service: PipelineRunService,
        ingest_service: IngestService,
    ) -> None:
        self.pipeline_service = pipeline_service
        self.ingest_service = ingest_service

    async def start_url_job(
        self,
        *,
        vault_id: UUID,
        storage: Storage,
        job_id: UUID,
        url: str,
        origin: str | None = None,
    ) -> PipelineRun:
        """Create a URL ingest job and run its source-ingest phase."""
        run = await self.pipeline_service.create(
            PipelineRunCreate(
                id=job_id,
                vault_id=vault_id,
                trigger=PipelineTrigger.URL,
            )
        )
        await self.pipeline_service.update_progress(
            run.id,
            PipelineRunUpdate(
                phase="source_ingest",
                status="started",
                progress_steps=build_progress_steps(
                    URL_INGEST_STEP_LABELS,
                    "fetch_url",
                    counts={"fetch_url": (0, 1)},
                ),
            ),
        )

        try:
            await self.ingest_service.ingest_url(
                vault_id,
                storage,
                url=url,
                origin=origin,
                pipeline_run_id=run.id,
            )
        except Exception as exc:
            message = (
                f"Failed to fetch URL: {exc}"
                if isinstance(exc, httpx.HTTPError)
                else str(exc)
            )
            await self.pipeline_service.update_progress(
                run.id,
                PipelineRunUpdate(
                    phase="source_ingest",
                    status="failed",
                    progress_steps=build_progress_steps(
                        URL_INGEST_STEP_LABELS,
                        "fetch_url",
                        failed={"fetch_url"},
                        details={"fetch_url": message},
                    ),
                    error=message,
                ),
            )
            await self.pipeline_service.commit()
            if isinstance(exc, httpx.HTTPError):
                raise UrlJobSourceError(message) from exc
            raise

        await self.pipeline_service.update_progress(
            run.id,
            PipelineRunUpdate(
                phase="source_ingest",
                status="completed",
                progress_steps=build_progress_steps(
                    URL_INGEST_STEP_LABELS,
                    "index_document",
                    completed=set(URL_INGEST_STEP_LABELS),
                    counts={"fetch_url": (1, 1)},
                ),
            ),
        )
        await self.pipeline_service.commit()

        refreshed = await self.pipeline_service.get(run.id, vault_id)
        if refreshed is None:
            raise JobNotFoundError(f"Job not found after creation: {run.id}")
        return refreshed
