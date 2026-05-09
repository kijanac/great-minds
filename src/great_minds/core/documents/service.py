"""Source document and wiki article services."""

from uuid import UUID

from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.documents.repository import SourceDocumentRepo, WikiArticleRepo
from great_minds.core.documents.schemas import (
    Backlink,
    SourceDocCreate,
    SourceDocument,
    SourceDocumentFacets,
    SourceDocumentUpdate,
    WikiArticle,
    WikiArticleCreate,
    WikiArticleOverview,
)
from great_minds.core.ideas.schemas import SourceCard
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.pagination import FacetedPage, Page, PageParams, create_page
from great_minds.core.pipeline_runs import PipelineRunRepository
from great_minds.core.telemetry import log_event


class SourceDocumentService:
    def __init__(
        self, repo: SourceDocumentRepo, pipeline_run_id: UUID | None = None
    ) -> None:
        self.repo = repo
        self.pipeline_run_id = pipeline_run_id

    async def _commit(self) -> None:
        await self.repo.session.commit()

    async def emit_compile_intent(self, vault_id: UUID) -> None:
        intent_repo = CompileIntentRepository(self.repo.session)
        intent = await intent_repo.upsert_pending(
            vault_id, pipeline_run_id=self.pipeline_run_id
        )
        created = intent is not None
        if intent is None and self.pipeline_run_id is not None:
            intent = await intent_repo.get_pending_for_vault(vault_id)
            if intent is not None and intent.pipeline_run_id is None:
                await intent_repo.attach_pipeline_run(intent.id, self.pipeline_run_id)
        if intent is not None and self.pipeline_run_id is not None:
            await PipelineRunRepository(self.repo.session).attach_compile_intent(
                self.pipeline_run_id, intent.id
            )
        if created and intent is not None:
            log_event(
                "intent_created",
                intent_id=str(intent.id),
                vault_id=str(vault_id),
                trigger="document_indexed",
            )

    async def index(self, vault_id: UUID, file_path: str, content: str) -> UUID:
        fm, _ = parse_frontmatter(content)
        doc = SourceDocCreate.from_frontmatter(fm, file_path, content)
        result = await self.repo.upsert(vault_id, doc)
        await self.emit_compile_intent(vault_id)
        await self._commit()
        return result

    async def file_hashes(self, vault_id: UUID) -> dict[str, str]:
        entries = await self.repo.get_file_hashes(vault_id)
        return {e.file_path: e.file_hash for e in entries}

    async def update_batch(
        self, vault_id: UUID, updates: list[SourceDocumentUpdate]
    ) -> None:
        """Batch-update source documents."""
        await self.repo.update_batch(vault_id, updates)

    async def batch_index(
        self, vault_id: UUID, docs: list[SourceDocCreate]
    ) -> list[UUID]:
        if not docs:
            return []
        ids = await self.repo.batch_upsert(vault_id, docs)
        await self._commit()
        return ids

    async def update_metadata_from_cards(
        self, vault_id: UUID, cards: list[SourceCard]
    ) -> None:
        await self.repo.update_metadata_from_cards(vault_id, cards)

    async def get_by_path(
        self, vault_id: UUID, file_path: str
    ) -> SourceDocument | None:
        return await self.repo.get_by_path(vault_id, file_path)

    async def get_title_by_path(self, vault_id: UUID, file_path: str) -> str | None:
        return await self.repo.get_title_by_path(vault_id, file_path)

    async def list_all(self, vault_id: UUID) -> list[SourceDocument]:
        return await self.repo.list_all(vault_id)

    async def count(self, vault_id: UUID) -> int:
        return await self.repo.count(vault_id)

    async def query_documents(self, vault_ids: list[UUID], **filters):
        return await self.repo.query(vault_ids, **filters)

    async def get_distinct_tags(self, vault_ids: list[UUID]) -> list[str]:
        return await self.repo.distinct_tags(vault_ids)

    async def list_sources(
        self,
        vault_id: UUID,
        *,
        pagination: PageParams,
        content_type: str | None = None,
        search: str | None = None,
        compiled: bool | None = None,
    ) -> FacetedPage[SourceDocument, SourceDocumentFacets]:
        docs = await self.repo.query(
            [vault_id],
            content_type=content_type,
            search=search,
            compiled=compiled,
            limit=pagination.limit,
            offset=pagination.offset,
        )
        total = await self.repo.count_query(
            [vault_id],
            content_type=content_type,
            search=search,
            compiled=compiled,
        )
        facets = SourceDocumentFacets(
            content_types=await self.repo.content_type_counts([vault_id])
        )
        return FacetedPage(
            items=docs,
            pagination=create_page(docs, pagination, total).pagination,
            facets=facets,
        )


class WikiArticleService:
    def __init__(self, repo: WikiArticleRepo) -> None:
        self.repo = repo

    async def upsert(self, vault_id: UUID, article: WikiArticleCreate) -> UUID:
        return await self.repo.upsert(vault_id, article)

    async def get_by_path(self, vault_id: UUID, file_path: str) -> WikiArticle | None:
        return await self.repo.get_by_path(vault_id, file_path)

    async def get_title_by_path(self, vault_id: UUID, file_path: str) -> str | None:
        return await self.repo.get_title_by_path(vault_id, file_path)

    async def get_by_topic(self, vault_id: UUID, topic_id: UUID) -> WikiArticle | None:
        return await self.repo.get_by_topic(vault_id, topic_id)

    async def list_all(self, vault_id: UUID) -> list[WikiArticle]:
        return await self.repo.list_all(vault_id)

    async def count(self, vault_id: UUID) -> int:
        return await self.repo.count(vault_id)

    async def search(
        self,
        vault_id: UUID,
        *,
        slug: str | None = None,
        query: str | None = None,
        limit: int = 20,
    ) -> list[WikiArticleOverview]:
        return await self.repo.list_overviews(
            vault_id, slug=slug, query=query, limit=limit
        )

    async def list_articles(
        self, vault_id: UUID, *, pagination: PageParams, recent: bool = False
    ) -> Page[WikiArticleOverview]:
        items = await self.repo.list_overviews(
            vault_id, limit=pagination.limit, offset=pagination.offset, recent=recent
        )
        total = await self.repo.count_overview_paths(vault_id)
        return create_page(items, pagination, total)

    async def list_orphans(self, vault_id: UUID) -> list[WikiArticleOverview]:
        return await self.repo.list_orphans(vault_id)

    async def update_file_path_for_topic(
        self, vault_id: UUID, topic_id: UUID, new_file_path: str
    ) -> None:
        await self.repo.update_file_path_for_topic(vault_id, topic_id, new_file_path)

    async def replace_backlinks(
        self, *, source_ids: list[UUID], backlinks: list[Backlink]
    ) -> None:
        await self.repo.update_backlinks(source_ids=source_ids, backlinks=backlinks)
        await self.repo.session.commit()
