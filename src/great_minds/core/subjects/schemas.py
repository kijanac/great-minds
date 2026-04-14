"""Subject domain schemas.

WikiSubject is the canonical record for anything the wiki may cover
(concept, person, event, work, place, movement, organization). A
WikiSubject is composed (via embedding clustering) of one or more
Ideas — per-doc contributions extracted from source material.
SourceCard holds a doc's Ideas and Anchors together. SourceAnchor is
a citable passage in a raw doc.

Authoritative storage is JSONL under .compile/<brain_id>/. Postgres is
a rebuildable cache (wiki_subjects table, idea_embeddings via pgvector).
"""

import uuid
from enum import StrEnum

from pydantic import BaseModel


class SubjectKind(StrEnum):
    CONCEPT = "concept"
    PERSON = "person"
    EVENT = "event"
    ORGANIZATION = "organization"
    WORK = "work"
    PLACE = "place"
    MOVEMENT = "movement"
    OTHER = "other"


class ArticleStatus(StrEnum):
    NO_ARTICLE = "no_article"
    RENDERED = "rendered"
    NEEDS_REVISION = "needs_revision"


class SourceAnchor(BaseModel):
    """An LLM-identified supporting passage for an Idea.

    Doc-level citation: anchors point to their source document via
    document_id; quote is the LLM's excerpt kept for writer context but
    never resolved to precise offsets. Passage-precise grounding is a
    deferred direction (see project_chunk_architecture memory).
    """

    anchor_id: uuid.UUID
    document_id: uuid.UUID
    claim: str
    quote: str


class Idea(BaseModel):
    """A per-doc concept, person, event, etc. contribution.

    A doc expresses many Ideas about different subjects; one or more
    Ideas from across docs cluster into a single WikiSubject during
    canonicalization. label and scope_note are LLM-generated.
    scope_note is the primary disambiguator during canonicalization
    (e.g. distinguishing Marx's "Capital" the work from "capital" the
    economic concept). subject_id is filled when canonicalization
    assigns the Idea to a WikiSubject.
    """

    idea_id: uuid.UUID
    kind: SubjectKind
    label: str
    scope_note: str
    anchor_ids: list[uuid.UUID]
    subject_id: uuid.UUID | None = None


class SourceCard(BaseModel):
    """Per-doc extraction artifact.

    One card per (document_id, extraction_version). Written to
    .compile/<brain_id>/source_cards.jsonl as one object per line.
    """

    document_id: uuid.UUID
    brain_id: uuid.UUID
    extraction_version: int
    ideas: list[Idea]
    anchors: list[SourceAnchor]


class WikiSubject(BaseModel):
    """Canonical record for a wiki subject.

    Produced by canonicalization clustering Ideas across many
    SourceCards. Written to .compile/<brain_id>/subjects.jsonl. When
    article_status is RENDERED, wiki/<slug>.md exists with minimal
    frontmatter mirroring subject_id, slug, canonical_label,
    article_status.
    """

    subject_id: uuid.UUID
    brain_id: uuid.UUID
    kind: SubjectKind
    canonical_label: str
    slug: str
    scope_note: str
    supporting_document_ids: list[uuid.UUID]
    evidence_anchor_ids: list[uuid.UUID]
    article_status: ArticleStatus
