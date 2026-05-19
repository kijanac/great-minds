"""Source document and wiki article domain schemas."""

from typing import Literal
from uuid import UUID
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field

from great_minds.core.pagination import FacetCount
from great_minds.core.paths import wiki_slug

# ---------------------------------------------------------------------------
# Frontmatter ↔ column key mapping
# ---------------------------------------------------------------------------
#
# On-disk frontmatter uses natural names (``date``, ``session_id``,
# ``anchored_to``); columns use prefixed names where needed for clarity
# in the wider source_documents table (``published_date``,
# ``provenance_session_id``). This module owns the mapping in
# ``SourceDocCreate.from_frontmatter``.
#
# Anything outside this known set lands in ``derived_extras`` — that's
# how vault-configured enriched fields (e.g. ``tradition``,
# ``interlocutors``) flow from disk to DB.
_FM_IDENTITY = {"source_type", "url", "origin"}
_FM_PROVENANCE_SESSION = {
    "session_id",
    "exchange_id",
    "session_query",
    "source_doc_path",
    "source_anchor",
    "source_paragraph_index",
}
_FM_PROVENANCE_USER = {"anchored_to", "anchored_section", "intent"}
_FM_LLM_DERIVED = {
    "title",
    "precis",
    "author",
    "date",
    "genre",
    "tags",
}
_FM_KNOWN_KEYS = (
    _FM_IDENTITY | _FM_PROVENANCE_SESSION | _FM_PROVENANCE_USER | _FM_LLM_DERIVED
)


def frontmatter_to_mirror_fields(fm: dict) -> dict:
    """Project parsed frontmatter into the Zone-3 mirror columns.

    Known LLM-derived keys map to typed columns; anything outside
    ``_FM_KNOWN_KEYS`` lands in ``derived_extras`` — that's how
    vault-configured enriched fields flow from disk back to DB.
    ``date`` on disk renames to ``published_date`` in the column.
    """
    return {
        "title": fm.get("title"),
        "precis": fm.get("precis"),
        "author": fm.get("author"),
        "published_date": fm.get("date"),
        "genre": fm.get("genre"),
        "tags": fm.get("tags") or [],
        "derived_extras": {k: v for k, v in fm.items() if k not in _FM_KNOWN_KEYS},
    }


# ---------------------------------------------------------------------------
# Create inputs
# ---------------------------------------------------------------------------


class SourceDocCreate(BaseModel):
    """Input for creating / upserting a source document.

    Carries identity / mechanically-known fields (zone 1) and
    per-source-kind provenance (zone 2). LLM-derived fields (zone 3)
    are owned by extract and never written through this schema —
    ingest sets them to None, and extract reflects them via
    ``reindex_from_file`` after writing new frontmatter.
    """

    model_config = ConfigDict(extra="ignore")

    # Identity / content (zone 1):
    file_path: str
    content: str
    source_type: str = "document"
    etag: str | None = None
    url: str | None = None
    origin: str | None = None
    # SHA-256 of the original uploaded bytes, supplied by the client
    # at ingest time. Only present for staged-file uploads — other
    # ingest shapes (URL fetch, user suggestion, session promotion)
    # leave this NULL.
    client_hash: str | None = None

    # Per-source-kind provenance (zone 2):
    provenance_session_id: UUID | None = None
    provenance_exchange_id: str | None = None
    provenance_session_query: str | None = None
    provenance_source_doc_path: str | None = None
    provenance_source_anchor: str | None = None
    provenance_source_paragraph_index: int | None = None
    provenance_anchored_to: str | None = None
    provenance_anchored_section: str | None = None
    provenance_intent: str | None = None

    @staticmethod
    def from_frontmatter(
        fm: dict,
        file_path: str,
        content: str,
        *,
        client_hash: str | None = None,
    ) -> "SourceDocCreate":
        """Build a SourceDocCreate from parsed frontmatter.

        Maps natural frontmatter key names to typed fields. Zone 3
        keys (title, precis, etc.) and anything in ``derived_extras``
        are deliberately not consumed — those reflect prior extract
        output and the next compile will refresh them from scratch.

        ``client_hash`` is passed separately because it lives outside
        the frontmatter — it's a staged-upload manifest field that the
        worker carries through from the original upload request.
        """
        session_paragraph_index = fm.get("source_paragraph_index")
        if isinstance(session_paragraph_index, str):
            session_paragraph_index = (
                int(session_paragraph_index) if session_paragraph_index else None
            )

        return SourceDocCreate(
            file_path=file_path,
            content=content,
            source_type=fm.get("source_type", "document"),
            url=fm.get("url"),
            origin=fm.get("origin"),
            client_hash=client_hash,
            provenance_session_id=fm.get("session_id"),
            provenance_exchange_id=fm.get("exchange_id"),
            provenance_session_query=fm.get("session_query"),
            provenance_source_doc_path=fm.get("source_doc_path"),
            provenance_source_anchor=fm.get("source_anchor"),
            provenance_source_paragraph_index=session_paragraph_index,
            provenance_anchored_to=fm.get("anchored_to"),
            provenance_anchored_section=fm.get("anchored_section"),
            provenance_intent=fm.get("intent"),
        )


class WikiArticleCreate(BaseModel):
    """Input for creating / upserting a rendered wiki article.

    ``title`` and ``precis`` are snapshots from the topic at render
    time. They live on the article row so reads don't JOIN topics for
    display; drift between snapshot and live topic is a queryable
    staleness signal.
    """

    file_path: str
    content: str
    topic_id: UUID
    title: str
    precis: str


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------


class SourceDocument(BaseModel):
    """Indexed source document. Body lives in storage.

    Flat by design: every field maps 1:1 to a column on the
    ``source_documents`` table so reads are a clean
    ``SourceDocument.model_validate(orm)`` with no helper.

    ``kind`` is a class-Literal tag used as the discriminator for the
    ``SourceDocument | WikiArticle`` union exposed at the API edge.
    It's not stored — class identity is the source of truth, and the
    default kicks in for ``model_validate(orm)`` calls since the ORM
    has no corresponding column.
    """

    model_config = ConfigDict(from_attributes=True)

    kind: Literal["source"] = "source"

    # Identity / mechanically-known:
    id: UUID
    vault_id: UUID
    file_path: str
    body_hash: str
    source_type: str
    etag: str | None = None
    url: str | None = None
    origin: str | None = None

    # Per-source-kind provenance:
    provenance_session_id: UUID | None = None
    provenance_exchange_id: str | None = None
    provenance_session_query: str | None = None
    provenance_source_doc_path: str | None = None
    provenance_source_anchor: str | None = None
    provenance_source_paragraph_index: int | None = None
    provenance_anchored_to: str | None = None
    provenance_anchored_section: str | None = None
    provenance_intent: str | None = None

    # LLM-derived (NULL until first compile):
    title: str | None = None
    precis: str | None = None
    author: str | None = None
    published_date: str | None = None
    genre: str | None = None
    tags: list[str] = Field(default_factory=list)
    derived_extras: dict = Field(default_factory=dict)

    created_at: datetime | None = None
    updated_at: datetime | None = None


class WikiArticle(BaseModel):
    """Rendered wiki article. Title / precis are snapshots from the
    topic at render time, stored on the article row.

    ``kind`` is a class-Literal tag used as the discriminator for the
    ``SourceDocument | WikiArticle`` union exposed at the API edge.
    See ``SourceDocument`` for the full rationale.
    """

    model_config = ConfigDict(from_attributes=True)

    kind: Literal["wiki"] = "wiki"
    id: UUID
    vault_id: UUID
    topic_id: UUID
    file_path: str
    body_hash: str
    title: str
    precis: str
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def slug(self) -> str:
        return wiki_slug(self.file_path)


class WikiArticleOverview(BaseModel):
    """Wiki article list row — title / precis read directly from the
    article row (snapshot at last render)."""

    model_config = ConfigDict(from_attributes=True)

    file_path: str
    title: str
    precis: str
    updated_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def slug(self) -> str:
        return wiki_slug(self.file_path)


# ---------------------------------------------------------------------------
# Backlinks
# ---------------------------------------------------------------------------


class Backlink(BaseModel):
    source_article_id: UUID
    target_article_id: UUID


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


class FileHash(BaseModel):
    """(file_path, file_hash) row for staged ingest skip detection."""

    model_config = ConfigDict(from_attributes=True)
    file_path: str
    file_hash: str


class IngestedDocument(BaseModel):
    """Result of a successful source ingest operation."""

    file_path: str


class SourceDocumentFacets(BaseModel):
    source_types: list[FacetCount] = Field(default_factory=list)
