"""Document index service: frontmatter sync and structured queries."""

from uuid import UUID

from great_minds.core.compile_intents.repository import CompileIntentRepository
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
    FacetedPage,
    Page,
    PageInfo,
    PageParams,
)
from great_minds.core.telemetry import log_event


class DocumentService:
    def __init__(self, repository: DocumentRepository) -> None:
        self.repo = repository

    async def _commit(self) -> None:
        await self.repo.session.commit()

    async def _emit_compile_intent(self, vault_id: UUID) -> None:
        """Mark the vault as having pending changes for the reconciler.

        ``upsert_pending`` is idempotent — the partial unique index on
        ``(vault_id) WHERE dispatched_at IS NULL`` coalesces concurrent
        ingests into one pending intent, so emitting per-write is safe.
        Logs ``intent_created`` only when a new row is inserted.
        """
        intent = await CompileIntentRepository(self.repo.session).upsert_pending(
            vault_id
        )
        if intent is not None:
            log_event(
                "intent_created",
                intent_id=str(intent.id),
                vault_id=str(vault_id),
                trigger="document_indexed",
            )

    async def index_raw_doc(
        self,
        vault_id: UUID,
        file_path: str,
        content: str,
    ) -> UUID:
        """Parse frontmatter, upsert a raw doc, and emit a compile intent.

        Always doc_kind=RAW. Wiki articles are written by the render
        phase via ``DocumentRepository.upsert`` directly — they're
        compile *outputs*, not inputs, so they don't trigger a recompile.
        """
        fm, _ = parse_frontmatter(content)
        doc = DocumentCreate.from_frontmatter(fm, file_path, content, DocKind.RAW)
        result = await self.repo.upsert(vault_id, doc)
        await self._emit_compile_intent(vault_id)
        await self._commit()
        return result

    async def get_raw_file_hashes(self, vault_id: UUID) -> dict[str, str]:
        """Return {file_path: file_hash} for every document in this vault.

        Used by bulk ingest to skip unchanged files.
        """
        return await self.repo.get_file_hashes(vault_id)

    async def batch_index_raw_docs(
        self, vault_id: UUID, docs: list[DocumentCreate]
    ) -> list[UUID]:
        """Upsert raw docs in one batch and emit a compile intent.

        Empty input is a no-op — no DB write, no intent. Lets callers
        flush conditionally without an empty-batch guard.
        """
        if not docs:
            return []
        ids = await self.repo.batch_upsert(vault_id, docs)
        await self._emit_compile_intent(vault_id)
        await self._commit()
        return ids

    async def query_documents(self, vault_ids: list[UUID], **filters) -> list[Document]:
        return await self.repo.query_documents(vault_ids, **filters)

    async def search_wiki_articles(
        self,
        vault_id: UUID,
        *,
        slug: str | None = None,
        query: str | None = None,
        limit: int = 20,
    ) -> list[WikiArticleSummary]:
        return await self.repo.search_wiki_articles(
            vault_id, slug=slug, query=query, limit=limit
        )

    async def get_title_by_path(self, vault_id: UUID, file_path: str) -> str | None:
        return await self.repo.get_title_by_path(vault_id, file_path)

    async def count_by_kind(self, vault_id: UUID, kind: DocKind) -> int:
        return await self.repo.count_by_kind(vault_id, kind)

    async def list_wiki_articles(
        self, vault_id: UUID, *, pagination: PageParams
    ) -> Page[WikiArticleSummary]:
        items = await self.repo.list_wiki_summaries(
            vault_id, limit=pagination.limit, offset=pagination.offset
        )
        total = await self.repo.count_wiki_article_paths(vault_id)
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
        vault_id: UUID,
        *,
        pagination: PageParams,
        content_type: str | None = None,
        search: str | None = None,
        compiled: bool | None = None,
    ) -> FacetedPage[Document, SourceDocumentFacets]:
        """Return raw documents and content-type folder counts."""
        docs = await self.repo.query_documents(
            [vault_id],
            doc_kind=DocKind.RAW,
            content_type=content_type,
            search=search,
            compiled=compiled,
            limit=pagination.limit,
            offset=pagination.offset,
        )
        total = await self.repo.count_documents(
            [vault_id],
            doc_kind=DocKind.RAW,
            content_type=content_type,
            search=search,
            compiled=compiled,
        )
        content_types = await self.repo.get_content_type_counts([vault_id])
        return FacetedPage(
            items=docs,
            pagination=PageInfo(
                limit=pagination.limit,
                offset=pagination.offset,
                total=total,
            ),
            facets=SourceDocumentFacets(content_types=content_types),
        )

    async def get_distinct_tags(self, vault_ids: list[UUID]) -> list[str]:
        return await self.repo.get_distinct_tags(vault_ids)
