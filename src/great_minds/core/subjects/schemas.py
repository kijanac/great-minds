"""Subject domain schemas.

A Concept is the canonical record for anything the wiki may cover
(concept, person, event, work, place, movement, organization). A
Concept is composed (via embedding clustering) of one or more Ideas —
per-doc contributions extracted from source material. SourceCard holds
a doc's Ideas and Anchors together. SourceAnchor is a citable passage
in a raw doc.

Authoritative storage is JSONL under .compile/<brain_id>/. Postgres is
a rebuildable cache (concepts table, idea_embeddings via pgvector).

Identifier scheme (mixed by purpose):
- document_id, idea_id, anchor_id: UUID5 (content-addressable, derived
  from natural keys at their call sites)
- concept_id: UUID7 (minted at distillation; identity is assigned,
  not derived). Stability across runs comes from slug continuity: on
  re-distillation, an existing (brain_id, slug) reuses its
  concept_id.
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


class SourceType(StrEnum):
    """Provenance class for a source document and every artifact derived
    from it. Drives Phase 3 citation filtering and downstream UI filters.

    - document: primary source material ingested by the user
    - user: user suggestion authored through the structured UI
    - lint: LLM-authored finding written as a substantive-prose source

    All three flow through the same Phase 1 → Phase 2 → Phase 3 rail.
    """

    DOCUMENT = "document"
    USER = "user"
    LINT = "lint"


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
    Ideas from across docs cluster into a single Concept during
    distillation. label and description are LLM-generated.
    description answers "what is this?" in one sentence and is embedded
    alongside the label for clustering. Anchors are the specific
    passages that ground this Idea; each Idea owns its own anchors so
    the claim↔concept relationship survives into Phase 3. concept_id
    is filled when distillation assigns the Idea to a Concept.
    """

    idea_id: uuid.UUID
    kind: SubjectKind
    label: str
    description: str
    anchors: list[SourceAnchor]
    concept_id: uuid.UUID | None = None


class SourceCard(BaseModel):
    """Per-doc extraction artifact.

    One card per (document_id, extraction_version). Written to
    .compile/<brain_id>/source_cards.jsonl as one object per line.
    source_type propagates from the ingested document's frontmatter
    and flows through each Idea's anchors to Phase 3 citation filtering.
    """

    document_id: uuid.UUID
    brain_id: uuid.UUID
    extraction_version: int
    source_type: SourceType = SourceType.DOCUMENT
    ideas: list[Idea]


class Concept(BaseModel):
    """Canonical record for a wiki subject — the intrinsic concept.

    Produced by distillation clustering Ideas across many SourceCards.
    Written to .compile/<brain_id>/subjects.jsonl (authoritative) and
    mirrored to ConceptORM.

    description serves triple duty: editorial brief for Phase 3
    rendering, entry text for the mechanical index.md assembly in
    Phase 5, and the canonical summary shown in UIs.

    compiled_from_hash is sha256 of the sorted member_idea_ids +
    canonical_label + description — the intrinsic identity of a
    concept's inputs. Stable for a given cluster; changes when
    clustering shifts. Drives dirty-flagging downstream.

    Render lifecycle state (article_status, rendered_from_hash) and
    archive lineage (supersedes, superseded_by) live on ConceptORM
    only: they describe pipeline state rather than properties of the
    concept itself.
    """

    concept_id: uuid.UUID
    brain_id: uuid.UUID
    kind: SubjectKind
    canonical_label: str
    slug: str
    description: str
    supporting_document_ids: list[uuid.UUID]
    member_idea_ids: list[uuid.UUID]
    compiled_from_hash: str
