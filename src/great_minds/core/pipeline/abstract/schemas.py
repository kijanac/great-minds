"""Pipeline-internal schemas for phase 2 (abstract).

These types live between sub-phases in memory only — they never hit
Postgres. Canonical topics (the reduce output that does reach the DB)
live in core/topics/schemas.py.
"""

from __future__ import annotations

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
