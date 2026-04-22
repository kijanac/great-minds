"""Pydantic schemas for ideas, anchors, and source cards."""

from __future__ import annotations

from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict


class Anchor(BaseModel):
    """One claim paired with its verbatim supporting quote.

    anchor_id is whatever the LLM assigned (stable within this idea);
    render normalizes to sequential [^n] footnotes at article time.
    """

    anchor_id: str
    claim: str
    quote: str


class Idea(BaseModel):
    """A per-document extraction unit: claim-set plus anchors.

    idea_id is uuid5(document_id, f"{label}|{kind}"). This gives
    stable IDs across re-extractions as long as label + kind agree.
    """

    idea_id: UUID
    document_id: UUID
    kind: str
    label: str
    description: str
    anchors: list[Anchor] = []

    @staticmethod
    def mint_id(document_id: UUID, label: str, kind: str) -> UUID:
        return uuid5(document_id, f"{label}|{kind}")


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

    idea_id: UUID
    brain_id: UUID
    document_id: UUID
    kind: str
    label: str
    description: str
    embedding: list[float]
