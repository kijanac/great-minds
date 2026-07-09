# Code Context

## Files Retrieved
1. `src/great_minds/core/documents/models.py` (lines 20-59, 68-76, 79-92) - current overloaded `documents` ORM plus tag/backlink FKs.
2. `src/great_minds/core/documents/schemas.py` (lines 14-17, 40-71, 86-118, 122-149) - `DocKind`, unified document DTOs, wiki overview, backlink DTO.
3. `src/great_minds/core/documents/repository.py` (lines 36-97, 195-227, 229-261, 263-337, 339-385, 387-500, 503-576) - main persistence/query surface that currently branches on `doc_kind`.
4. `src/great_minds/core/documents/service.py` (lines 67-83, 95-112, 119-144, 151-205) - service facade used by ingest/API/pipeline/query tools.
5. `alembic/versions/0001_initial_schema.py` (lines 461-532, 645-690) - current schema, partial unique wiki index, `document_tags`, `source_proposals` FK, backlinks.
6. `src/great_minds/core/pipeline/render.py` (lines 169-185, 339-345, 486-519, 591-623, 660-710) - render writes wiki rows and uses raw documents for citations.
7. `src/great_minds/core/pipeline/verify.py` (lines 77-112, 124-168, 190-204, 232-238) - verify maps rendered topics to wiki document rows and writes backlinks.
8. `src/great_minds/core/pipeline/extract.py` (lines 120-145, 282-286, 487-528) - extract reads raw docs and enriches raw document metadata.
9. `src/great_minds/core/pipeline/abstract/validate.py` (lines 171-196) - archive moves wiki file and repoints document row by topic.
10. `src/great_minds/core/pipeline/publish.py` (lines 105-130, 188-230) - publish lists raw docs and counts raw/wiki documents.
11. `src/great_minds/core/querier.py` (lines 86-104, 171-193, 344-383, 443-461) - query tools expose `doc_kind` and count raw/wiki docs.
12. `src/great_minds/app/api/wiki_routes.py` (lines 27-111) - `/wiki`, `/raw/sources`, and unified `/doc/{path}` endpoints.
13. `src/great_minds/app/api/schemas/wiki.py` (lines 10-37) - API response schemas wrap unified `Document`.
14. `web/src/api/doc.ts` (lines 5-33) - frontend expects `document.doc_kind` in unified read response.
15. `web/src/api/wiki.ts` (lines 6-14, 19-30) - frontend wiki list shape.
16. `web/src/api/sources.ts` (lines 6-22) - frontend source list shape.
17. `web/src/components/doc-header.tsx` (lines 20-44) - shared raw/wiki header consumes unified metadata.
18. `src/great_minds/core/search/service.py` (lines 107-135) and `src/great_minds/core/search/repository.py` (lines 27-41) - search index is path/prefix-based, not document-FK-based.
19. `src/great_minds/core/ideas/models.py` (lines 15-24), `src/great_minds/core/ideas/repository.py` (lines 27-57), `src/great_minds/core/ideas/source_cards.py` (lines 1-7, 66-82) - source-card/embedding document IDs are raw-source IDs with no DB FK for embeddings.
20. `src/great_minds/core/proposals/models.py` (lines 38-44) - `source_proposals.document_id` FK points at `documents.id` and should become source-document FK.
21. `src/great_minds/core/vaults/repository.py` (lines 56-68) - vault delete comments/cleanup assume cascade through `documents` and tags/backlinks.
22. `src/great_minds/core/workers.py` (lines 236-246, 279-290, 350-365) and `src/great_minds/core/ingest_service.py` (lines 124-173, 225-286) - ingest paths produce raw `DocumentCreate` rows.

## Key Code

Current overloaded table:

```py
# src/great_minds/core/documents/models.py:20-59
class DocumentORM(Base):
    __tablename__ = "documents"
    __table_args__ = (UniqueConstraint("vault_id", "file_path"),)
    ...
    compiled: Mapped[bool] = mapped_column(Boolean, server_default="false")
    doc_kind: Mapped[str] = mapped_column(Text, server_default="raw")
    source_type: Mapped[str | None] = mapped_column(Text)
    topic_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("topics.topic_id", ondelete="CASCADE")
    )
    precis: Mapped[str | None] = mapped_column(Text)
    extra_metadata: Mapped[dict] = mapped_column("metadata", JSONB, server_default="{}")
```

Partial unique index that caused the upsert issue and demonstrates the schema smell:

```py
# alembic/versions/0001_initial_schema.py:645-663
op.add_column("documents", sa.Column("topic_id", sa.UUID(), sa.ForeignKey("topics.topic_id", ondelete="CASCADE"), nullable=True))
op.create_index(
    "ix_documents_topic_id_wiki",
    "documents",
    ["topic_id"],
    unique=True,
    postgresql_where=sa.text("doc_kind = 'wiki'"),
)
```

Repository currently has mixed raw/wiki behavior. `upsert()` has wiki-specific topic conflict logic, while normal raw upserts use `(vault_id, file_path)`:

```py
# src/great_minds/core/documents/repository.py:70-90
if doc.doc_kind == DocKind.WIKI.value and doc.topic_id is not None:
    stmt = stmt.on_conflict_do_update(
        index_elements=[DocumentORM.topic_id],
        index_where=(DocumentORM.doc_kind == literal_column(repr(DocKind.WIKI.value))),
        set_={**set_values, "file_path": doc.file_path},
    )
else:
    stmt = stmt.on_conflict_do_update(
        constraint="documents_vault_id_file_path_key",
        set_=set_values,
    )
```

Read/query/list paths all filter on `doc_kind`:

```py
# src/great_minds/core/documents/repository.py:213-227
async def list_by_kind(self, vault_id: UUID, kind: DocKind) -> list[Document]:
    ... where(DocumentORM.vault_id == vault_id, DocumentORM.doc_kind == kind.value)

# src/great_minds/core/documents/service.py:170-196
async def list_raw_sources(...):
    docs = await self.repo.query_documents([vault_id], doc_kind=DocKind.RAW, ...)
```

Render creates wiki artifacts through the document service:

```py
# src/great_minds/core/pipeline/render.py:503-519
await phase.documents.upsert_compiled_doc(
    vault_id,
    DocumentCreate(
        file_path=article_path,
        content=full_content,
        doc_kind=DocKind.WIKI,
        compiled=True,
        topic_id=topic.topic_id,
        metadata=DocumentMetadata(title=topic.title, precis=topic.description, tags=tags),
    ),
)
```

Verify relies on wiki document IDs for backlinks:

```py
# src/great_minds/core/pipeline/verify.py:159-165, 237-238
target_article = article_by_topic[target.topic_id]
backlinks.append(Backlink(source_document_id=source_article.id, target_document_id=target_article.id))
...
docs = await self.documents.list_by_kind(vault_id, DocKind.WIKI)
return {doc.topic_id: doc for doc in docs if doc.topic_id is not None}
```

Frontend unified document schema currently exposes `doc_kind`:

```ts
// web/src/api/doc.ts:5-12
const documentSchema = z.object({
  id: z.string(),
  vault_id: z.string(),
  file_path: z.string(),
  body_hash: z.string(),
  compiled: z.boolean(),
  doc_kind: z.enum(["raw", "wiki"]),
```

## Architecture

Today `documents` is both:

- raw/source registry: ingest writes raw files under `raw/{content_type}/...`; extract reads raw rows, creates source cards/idea embeddings keyed by raw `document_id`, and updates title/precis/metadata.
- wiki artifact registry: render writes generated article files under `wiki/*.md`, stores `topic_id`, and marks `doc_kind='wiki'`; verify uses those row IDs to maintain backlinks; archive repoints the row to `archive/{topic_id}/{slug}.md`.

The split should make those two lifecycles explicit:

### Proposed tables

`source_documents`:
- `id uuid primary key default gen_random_uuid()`; preserve raw `documents.id` values during backfill.
- `vault_id not null references vaults(id) on delete cascade`.
- `file_path text not null`, `file_hash text not null`, `body_hash text not null`.
- source/enrichment fields currently meaningful for raw rows: `title`, `author`, `url`, `origin`, `published_date`, `genre`, `source_type`, `compiled`, `precis`, `metadata jsonb`, timestamps.
- `unique(vault_id, file_path)` plus indexes equivalent to current raw query needs: vault, published_date, author, compiled, source_type maybe, GIN metadata.

`wiki_articles`:
- `id uuid primary key default gen_random_uuid()`; preserve wiki `documents.id` values during backfill if possible to avoid changing backlinks.
- `vault_id not null references vaults(id) on delete cascade`.
- `topic_id uuid not null references topics(topic_id) on delete cascade` with `unique(topic_id)` or preferably `unique(vault_id, topic_id)` if topic IDs are globally unique already but vault scoping is useful.
- `file_path text not null`, `file_hash text not null`, `body_hash text not null`.
- `title text not null`, `precis text`, `metadata jsonb not null default '{}'`, timestamps.
- consider `rendered_from_hash text` because render already computes it (`src/great_minds/core/pipeline/render.py:555-623`) but does not persist it in `documents` today.
- optional explicit status/archive fields only if you want DB to mirror topics/frontmatter; currently status lives on topics and archive info in file/frontmatter.
- `unique(vault_id, file_path)` if archived paths and wiki paths must be addressable by `/doc/{path}`.

`source_document_tags` and `wiki_article_tags` should replace `document_tags`; do not keep one tag table that can FK to two parents. Existing raw metadata query only needs source tags; wiki tags are used for article metadata/backlinks/orphan lists.

`backlinks` should become article-to-article, e.g. `source_article_id` and `target_article_id` FKs to `wiki_articles(id)`. This matches the comment in the migration that backlinks are "article-level reality" and avoids source/wiki ambiguity.

`source_proposals.document_id` should become `source_document_id` FK to `source_documents(id)` (`src/great_minds/core/proposals/models.py:42-44`). `idea_embeddings.document_id` and source cards are raw-source IDs; rename at code/schema level to `source_document_id` only if willing to migrate JSONL/source-card payloads and embedding columns. Since embeddings have no FK (`src/great_minds/core/ideas/models.py:20`), DB migration can preserve values and a later cleanup can rename.

Search is mostly unaffected because `search_index` keys by `path` and prefix (`src/great_minds/core/search/service.py:107-135`), not by document ID.

### Migration plan

1. Add new ORM classes and repository split first in code, but keep compatibility DTOs while migrating API call sites:
   - `SourceDocumentORM`, `SourceDocumentTagORM`, `WikiArticleORM`, `WikiArticleTagORM`, `BacklinkORM` updated to article IDs.
   - `SourceDocumentRepository` for raw ingest/extract/source list/query.
   - `WikiArticleRepository` for render/list/wiki read/backlinks/archive.
   - A thin `DocumentReadService` can keep `/doc/{path}` working by trying `source_documents` then `wiki_articles` and returning a discriminated response.

2. Alembic migration:
   - create `source_documents` and `wiki_articles`.
   - backfill source rows from `documents where doc_kind='raw'`, preserving IDs.
   - backfill wiki rows from `documents where doc_kind='wiki'`, preserving IDs and requiring non-null `topic_id`; handle/null-log any malformed wiki rows before `NOT NULL`.
   - create `source_document_tags` by joining tags to raw document IDs.
   - create `wiki_article_tags` by joining tags to wiki article IDs.
   - create new `backlinks_new(source_article_id references wiki_articles(id), target_article_id references wiki_articles(id))` from old backlink IDs; because wiki IDs are preserved, this is a direct copy after filtering to wiki rows.
   - change `source_proposals.document_id` FK from `documents(id)` to `source_documents(id)`; either rename column to `source_document_id` or leave DB column temporarily and rename in a later migration.
   - update indexes and constraints; drop old `backlinks`, `document_tags`, `documents` only after code deploy/migration is atomic.

3. Code changes by area:
   - `documents/models.py`: replace `DocumentORM` with separate models. Keep Pydantic types or introduce `SourceDocument`, `WikiArticle`, and `DocumentRead` union.
   - `documents/repository.py`: split methods:
     - raw: `upsert_source`, `batch_upsert_sources`, `list_sources`, `query_source_documents`, `count_source_documents`, `update_metadata_from_cards`, `get_source_title_by_path`, tag facets.
     - wiki: `upsert_article_by_topic`, `list_article_overviews`, `count_articles`, `get_article_by_path`, `update_file_path_for_topic`, `replace_backlinks`, `list_orphan_articles`.
   - `documents/service.py`: rename raw APIs and add wiki APIs. Keep deprecated wrappers (`list_by_kind`, `count_by_kind`) only if it reduces churn, but remove `DocKind` from core flows at the end.
   - `render.py`: replace `upsert_compiled_doc(DocumentCreate(doc_kind=WIKI))` with `upsert_wiki_article(...)`; raw citation loading becomes `list_source_documents`.
   - `verify.py`: `_load_wiki_articles()` should query `wiki_articles`; backlinks DTO should use article IDs.
   - `abstract/validate.py`: `update_file_path_for_topic` moves to wiki repository.
   - `extract.py`: `list_by_kind(DocKind.RAW)` becomes `list_source_documents`; metadata update targets `source_documents`.
   - `publish.py` and `querier.py`: replace `count_by_kind` with explicit counts; query tool parameter should stop exposing `doc_kind` or map old `raw/wiki` to source/article backends during transition.
   - `api/wiki_routes.py`: `/wiki*` from wiki service, `/raw/sources` from source service, `/doc/{path}` from compatibility read service.
   - `api/schemas/wiki.py` and `web/src/api/doc.ts`: decide response shape. Minimal-compatible shape can keep `document.doc_kind` synthesized (`raw` for source row, `wiki` for article row) even though DB no longer has `doc_kind`. Cleaner v2 shape is discriminated `{kind: 'source'|'wiki', document/article, body}` but touches more frontend.

4. Tests/regressions to add:
   - rerender same topic with changed slug updates one `wiki_articles` row by `topic_id`, not insert duplicate.
   - raw ingest upsert remains idempotent by `(vault_id,file_path)`.
   - `/doc/raw/...` and `/doc/wiki/...` both resolve after split.
   - verify writes backlinks only between `wiki_articles`.
   - source proposals still retain accepted source link.
   - extract source cards/idea embeddings still find raw source IDs after migration.

## Start Here

Start with `src/great_minds/core/documents/repository.py`. It is the choke point where overloaded behavior is visible: raw upsert/query/tag logic and wiki topic-upsert/backlink/archive/list logic all live together. Splitting this file cleanly will drive the ORM, migration, service, API, and pipeline changes.

## Supervisor coordination

No supervisor decision needed. Key risk: preserving IDs during backfill is important because source cards, idea embeddings, proposals, and old backlinks all store document IDs. If IDs are preserved, the migration is straightforward; if not, storage JSONL source cards and embedding/proposal references need an explicit ID mapping step.
