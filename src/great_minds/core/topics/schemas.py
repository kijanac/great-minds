"""Pydantic schemas for the topics bounded context."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from great_minds.core.topics.models import ArticleStatus

# ---------------------------------------------------------------------------
# CRUD / registry schemas
# ---------------------------------------------------------------------------


class TopicBase(BaseModel):
    """Shared editable topic fields."""

    model_config = ConfigDict(from_attributes=True)

    slug: str
    title: str
    description: str


class Topic(TopicBase):
    """Read shape for a row in the topics registry."""

    model_config = ConfigDict(from_attributes=True)

    topic_id: UUID
    vault_id: UUID
    article_status: ArticleStatus = ArticleStatus.NO_ARTICLE
    compiled_from_hash: str | None = None
    rendered_from_hash: str | None = None
    supersedes: UUID | None = None
    superseded_by: UUID | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


# ---------------------------------------------------------------------------
# Compile / reduction schemas
# ---------------------------------------------------------------------------


class CanonicalTopicDraft(TopicBase):
    """Reducer output — one canonical topic plus intended link targets.

    ``link_targets`` are slugs; validation intersects them with the emitted
    canonical slug set before any topic_id minting happens.
    """

    merged_local_topic_ids: list[UUID]
    link_targets: list[str]


class TopicReductionOutput(BaseModel):
    """Full structured output from topic canonicalization/reduction."""

    canonical_topics: list[CanonicalTopicDraft]


class TopicDetail(Topic):
    """Topic read shape with joined compile projections.

    Use this when callers need membership/link details in addition to the
    registry row. Basic topic reads should use ``Topic`` to avoid implying
    joins that were not loaded.
    """

    subsumed_idea_ids: list[UUID]
    link_targets: list[str]


# ---------------------------------------------------------------------------
# Graph / projection schemas
# ---------------------------------------------------------------------------


class TopicLink(BaseModel):
    """A directed edge between two topics in a vault's link graph."""

    model_config = ConfigDict(from_attributes=True)

    source_topic_id: UUID
    target_topic_id: UUID


class TopicSimilarityPair(BaseModel):
    """Raw pairwise similarity result from SQL self-join."""

    model_config = ConfigDict(from_attributes=True)

    topic_a: UUID
    topic_b: UUID
    shared: int
    jaccard: float
