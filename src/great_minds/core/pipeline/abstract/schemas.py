"""Pipeline-internal schemas for phase 2 (abstract).

These types live between sub-phases in memory only — they never hit
Postgres. Canonical topics (the reduce output that does reach the DB)
live in core/topics/schemas.py.
"""


from uuid import UUID

from pydantic import BaseModel


class LocalTopic(BaseModel):
    """One thematic topic proposed by the synthesize LLM for one chunk.

    `local_topic_id` is uuid7 minted at parse time — identity is opaque,
    like everything else in the pipeline. `chunk_idx` is kept for
    debugging and for the slug-collision cleanup call in 2e validate.
    """

    local_topic_id: UUID
    chunk_idx: int
    slug: str
    title: str
    description: str
    subsumed_idea_ids: list[UUID]


class ValidatedCanonicalTopic(BaseModel):
    """Canonical topic after phase 2e validate: link_targets filtered,
    slug collisions resolved, topic_id assigned via slug continuity,
    subsumed ideas resolved from merged local topics.

    This is what phase 3 derive consumes — topic_id is the stable
    Postgres key, subsumed_idea_ids populates topic_membership.
    """

    topic_id: UUID
    slug: str
    title: str
    description: str
    merged_local_topic_ids: list[UUID]
    subsumed_idea_ids: list[UUID]
    link_targets: list[str]
    is_new: bool
