"""Pydantic schemas for ideas, anchors, and source cards."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class Anchor(BaseModel):
    """One claim paired with its verbatim supporting quote.

    Order within an idea's ``anchors`` list is the only identity an
    anchor has — render numbers them sequentially as ``[^n]`` footnotes
    at article time.

    chunk_index is the paragraph in the source doc where the quote
    lives — resolved post-extract via substring match against the
    doc's paragraphs. Render uses it to emit deep-link footnote URLs
    (`raw/.../file.md#^pN`). None if the quote couldn't be localized.
    """

    model_config = ConfigDict(from_attributes=True)

    claim: str
    quote: str
    chunk_index: int | None = None


class Idea(BaseModel):
    """A per-document extraction unit: claim-set plus anchors.

    idea_id is a fresh uuid7 minted at extract time. Stability across
    cache-hit incremental compiles comes from the extract cache
    returning the cached source_card (id included), not from the uuid
    scheme. On cache miss the LLM re-draws and fresh ids are minted;
    delete-then-insert keyed on document_id handles cleanup.
    """

    model_config = ConfigDict(from_attributes=True)

    idea_id: UUID
    document_id: UUID
    kind: str
    label: str
    description: str
    anchors: list[Anchor] = Field(default_factory=list)


class SourceCard(BaseModel):
    """Read-time aggregate over ``source_documents`` + ``ideas`` + ``anchors``.

    All fields except ``ideas`` map 1:1 to the LLM-derived columns and
    ``derived_extras`` JSONB on ``source_documents``. ``derived_extras``
    carries whatever vault-configured enriched fields the vault's
    config declared; its shape is dynamic and surfaces in compile's
    editorial context (partition / synthesize) generically.
    """

    document_id: UUID
    title: str
    precis: str
    author: str | None = None
    published_date: str | None = None
    genre: str | None = None
    tags: list[str] = Field(default_factory=list)
    derived_extras: dict = Field(default_factory=dict)
    ideas: list[Idea]


class IdeaEmbedding(BaseModel):
    """Write-shape for one row in ``ideas`` — carries embedding + anchors.

    Used during extract: ``_embed_in_batches`` produces these from the
    domain ``Idea`` plus the freshly-computed embedding vector, and the
    repository writes the ``ideas`` row and the corresponding ``anchors``
    rows from this single record.
    """

    model_config = ConfigDict(from_attributes=True)

    idea_id: UUID
    vault_id: UUID
    document_id: UUID
    kind: str
    label: str
    description: str
    anchors: list[Anchor] = Field(default_factory=list)
    embedding: list[float]
