"""Document index service: frontmatter sync, structured queries, backlinks."""

from uuid import UUID

from great_minds.core.brains._utils import parse_frontmatter
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DOC_KIND_RAW, Document, DocumentCreate
from great_minds.core.storage import Storage


class DocumentService:
    def __init__(self, repository: DocumentRepository) -> None:
        self.repo = repository

    async def index_from_content(
        self,
        brain_id: UUID,
        file_path: str,
        content: str,
        *,
        doc_kind: str = DOC_KIND_RAW,
    ) -> UUID:
        """Parse frontmatter from file content and upsert the documents table."""
        fm, _ = parse_frontmatter(content)
        doc = DocumentCreate.model_validate(
            {**fm, "file_path": file_path, "content": content, "doc_kind": doc_kind}
        )
        return await self.repo.upsert(brain_id, doc)

    async def index_brain_file(
        self,
        brain_id: UUID,
        storage: Storage,
        file_path: str,
        *,
        doc_kind: str = DOC_KIND_RAW,
    ) -> UUID:
        """Read a file from storage and index it."""
        content = storage.read(file_path)
        if content is None:
            raise FileNotFoundError(file_path)
        return await self.index_from_content(
            brain_id, file_path, content, doc_kind=doc_kind
        )

    async def query_documents(self, brain_ids: list[UUID], **filters) -> list[Document]:
        return await self.repo.query_documents(brain_ids, **filters)

    async def get_distinct_tags(self, brain_ids: list[UUID]) -> list[str]:
        return await self.repo.get_distinct_tags(brain_ids)

    async def get_distinct_concepts(self, brain_ids: list[UUID]) -> list[str]:
        return await self.repo.get_distinct_concepts(brain_ids)

    async def get_backlinks(self, brain_ids: list[UUID], target_slug: str) -> list[str]:
        return await self.repo.get_backlinks(brain_ids, target_slug)

    async def rebuild_backlinks_for_article(
        self, brain_id: UUID, slug: str, article_content: str
    ) -> None:
        await self.repo.rebuild_backlinks_for_article(brain_id, slug, article_content)
