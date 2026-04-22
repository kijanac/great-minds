"""PipelineContext bundles everything each phase needs.

Rather than threading (client, session, storage, brain_id, config, ...)
through every phase signature, we pass one context object. Fields are
read-only from the phase's perspective — phases produce Result objects
that flow back through the orchestrator, not by mutating context.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain_config import BrainConfig
from great_minds.core.pipeline.cache import ContentHashCache
from great_minds.core.storage import Storage


@dataclass
class PipelineContext:
    brain_id: UUID
    storage: Storage
    session: AsyncSession
    client: AsyncOpenAI
    config: BrainConfig
    cache: ContentHashCache
