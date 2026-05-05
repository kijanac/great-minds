"""Pydantic schemas for topics."""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class ArticleStatus(StrEnum):
    NO_ARTICLE = "no_article"
    RENDERED = "rendered"
    NEEDS_REVISION = "needs_revision"
    ARCHIVED = "archived"


class Topic(BaseModel):
    """Row in the topics registry."""

    model_config = ConfigDict(from_attributes=True)

    topic_id: UUID
    vault_id: UUID
    slug: str
    title: str
    description: str
    article_status: ArticleStatus = ArticleStatus.NO_ARTICLE
    compiled_from_hash: str | None = None
    rendered_from_hash: str | None = None
    supersedes: UUID | None = None
    superseded_by: UUID | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CanonicalTopic(BaseModel):
    """Reducer output — one canonical topic plus its intended link targets.

    link_targets are slugs; validation intersects them with the emitted
    canonical slug set before any topic_id minting happens.
    """

    slug: str
    title: str
    description: str
    merged_local_topic_ids: list[str]
    link_targets: list[str]


class ReduceOutput(BaseModel):
    """Full structured output from phase 2d reduce."""

    canonical_topics: list[CanonicalTopic]


class TopicLink(BaseModel):
    """A directed edge between two topics in a vault's link graph."""

    source_topic_id: UUID
    target_topic_id: UUID


class RelatedTopic(BaseModel):
    """A related-topic row for the sidebar UI."""

    model_config = ConfigDict(from_attributes=True)

    related_topic_id: UUID
    shared_ideas: int
    jaccard: float


class JaccardPair(BaseModel):
    """Raw pairwise Jaccard result from SQL self-join — (topic_a, topic_b,
    shared_idea_count, jaccard_score) for pairs with shared > 0."""

    model_config = ConfigDict(from_attributes=True)

    topic_a: UUID
    topic_b: UUID
    shared: int
    jaccard: float
