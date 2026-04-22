"""ORM models for article-level state.

Articles are the rendered prose surface (wiki/<slug>.md files). Their
topic mapping is 1:1 — each topic_id corresponds to exactly one article
path — but article-level signals (backlinks extracted from rendered
prose, future article chunks, etc.) live here rather than in
topics/ because they reflect what the prose actually says, not the
topic registry's intent.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from great_minds.core.db import Base


class BacklinkORM(Base):
    """Built by phase 5 verify from actual [title](wiki/<slug>.md) citations
    in rendered article bodies. Keyed by topic_id because 1 topic = 1 article,
    but its semantics are article-level reality, not topic-level intent.
    """

    __tablename__ = "backlinks"

    target_topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
        primary_key=True,
    )
    source_topic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("topics.topic_id", ondelete="CASCADE"),
        primary_key=True,
    )
    source_article_path: Mapped[str] = mapped_column(Text, nullable=False)
