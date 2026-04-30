"""Pydantic schemas for ideas, anchors, and source cards."""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict


class Anchor(BaseModel):
    """One claim paired with its verbatim supporting quote.

    anchor_id is whatever the LLM assigned (stable within this idea);
    render normalizes to sequential [^n] footnotes at article time.

    chunk_index is the paragraph in the source doc where the quote
    lives — resolved post-extract via substring match against the
    doc's paragraphs. Render uses it to emit deep-link footnote URLs
    (`raw/.../file.md#^pN`). None if the quote couldn't be localized.
    """

    anchor_id: str
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

    idea_id: UUID
    document_id: UUID
    kind: str
    label: str
    description: str
    anchors: list[Anchor] = []


class DocMetadata(BaseModel):
    """Document-level metadata extracted alongside ideas.

    Known fields (genre/tags/tradition/interlocutors) are typed; per-brain
    config may declare additional fields which land in the extra bag.
    """

    model_config = ConfigDict(extra="allow")

    genre: str | None = None
    tags: list[str] = []
    tradition: str | None = None
    interlocutors: list[str] = []


class SourceCard(BaseModel):
    """One line in source_cards.jsonl — the full extract output for one doc."""

    document_id: UUID
    title: str
    doc_metadata: DocMetadata
    precis: str
    ideas: list[Idea]


class IdeaEmbedding(BaseModel):
    """Projection of one row in idea_embeddings."""

    model_config = ConfigDict(from_attributes=True)

    idea_id: UUID
    brain_id: UUID
    document_id: UUID
    kind: str
    label: str
    description: str
    embedding: list[float]
