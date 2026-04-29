"""Document index service: frontmatter sync and structured queries."""

from uuid import UUID

from great_minds.core.markdown import parse_frontmatter
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import (
    DocKind,
    Document,
    DocumentCreate,
    SourceDocumentFacets,
    WikiArticleSummary,
)
from great_minds.core.pagination import (
    FacetCount,
    FacetedPage,
    Page,
    PageInfo,
    PageParams,
)


class DocumentService:
    def __init__(self, repository: DocumentRepository) -> None:
        self.repo = repository

    async def _commit(self) -> None:
        await self.repo.session.commit()

    async def index_raw_doc(
        self,
        brain_id: UUID,
        file_path: str,
        content: str,
    ) -> UUID:
        """Parse frontmatter and upsert a raw ingested document.

        Always doc_kind=RAW. Wiki articles are indexed by the render phase.
        """
        fm, _ = parse_frontmatter(content)
        doc = DocumentCreate.from_frontmatter(fm, file_path, content, DocKind.RAW)
        result = await self.repo.upsert(brain_id, doc)
        await self._commit()
        return result

    async def get_raw_file_hashes(self, brain_id: UUID) -> dict[str, str]:
        """Return {file_path: file_hash} for every document in this brain.

        Used by bulk ingest to skip unchanged files.
        """
        return await self.repo.get_file_hashes(brain_id)

    async def batch_index_raw_docs(
        self, brain_id: UUID, docs: list[DocumentCreate]
    ) -> list[UUID]:
        """Upsert multiple raw documents in one commit."""
        ids = await self.repo.batch_upsert(brain_id, docs)
        await self._commit()
        return ids

    async def query_documents(self, brain_ids: list[UUID], **filters) -> list[Document]:
        return await self.repo.query_documents(brain_ids, **filters)

    async def list_wiki_articles(
        self, brain_id: UUID, *, pagination: PageParams
    ) -> Page[WikiArticleSummary]:
        items = await self.repo.list_wiki_summaries(
            brain_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.count_wiki_article_paths(brain_id)
        return Page(
            items=items,
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
        )

    async def list_raw_sources(
        self,
        brain_id: UUID,
        *,
        pagination: PageParams,
        content_type: str | None = None,
        search: str | None = None,
        compiled: bool | None = None,
    ) -> FacetedPage[Document, SourceDocumentFacets]:
        """Return raw documents and content-type folder counts."""
        docs = await self.repo.query_documents(
            [brain_id],
            doc_kind=DocKind.RAW,
            content_type=content_type,
            search=search,
            compiled=compiled,
            limit=pagination.limit,
            offset=pagination.offset,
        )
        total = await self.repo.count_documents(
            [brain_id],
            doc_kind=DocKind.RAW,
            content_type=content_type,
            search=search,
            compiled=compiled,
        )
        content_types = await self.repo.get_content_type_counts([brain_id])
        return FacetedPage(
            items=docs,
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
            facets=SourceDocumentFacets(
                content_types=[
                    FacetCount(value=ct, count=count)
                    for ct, count in content_types
                ],
            ),
        )

    async def get_distinct_tags(self, brain_ids: list[UUID]) -> list[str]:
        return await self.repo.get_distinct_tags(brain_ids)
