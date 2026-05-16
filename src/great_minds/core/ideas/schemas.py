"""Pydantic schemas for ideas, anchors, and source cards."""

from typing import Annotated
from uuid import UUID

import numpy as np
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, PlainSerializer


# Embedding vectors are stored as ``np.ndarray[float32]`` rather than
# ``list[float]``: a 1500-dim Python float-list is ~48 KB (each PyFloat
# is a heap object), vs ~6 KB as a numpy float32 buffer. At ~40k ideas
# per vault the difference is ~1.7 GB on the partition read path.
# pgvector-python already returns ``np.ndarray`` from the DB; the
# ``BeforeValidator`` only kicks in when the input is a ``list[float]``
# (e.g. fresh from the LLM-provider embeddings API).
Embedding = Annotated[
    np.ndarray,
    BeforeValidator(lambda v: np.asarray(v, dtype=np.float32)),
    PlainSerializer(lambda a: a.tolist(), return_type=list),
]


class Anchor(BaseModel):
    """One claim paired with its verbatim supporting quote.

    Order within an idea's ``anchors`` list is the only identity an
    anchor has — render numbers them sequentially as ``[^n]`` footnotes
    at article time.

    chunk_index is the paragraph in the source doc where the quote
    lives — resolved post-extract via substring match against the
    doc's paragraphs. Render uses it to emit deep-link footnote URLs
    (`raw/.../file.md#^pN`). None if the quote couldn't be localized.
    """

    model_config = ConfigDict(from_attributes=True)

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

    model_config = ConfigDict(from_attributes=True)

    idea_id: UUID
    document_id: UUID
    kind: str
    label: str
    description: str
    anchors: list[Anchor] = Field(default_factory=list)


class IdeaCreate(Idea):
    """Input for inserting/upserting an idea row.

    Extends the domain ``Idea`` with the storage columns (``vault_id``
    and ``embedding``) that extract supplies post-LLM, post-embedding.
    ``_embed_in_batches`` produces these and the repository writes the
    ``ideas`` row plus the corresponding ``anchors`` rows in one pass.
    """

    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True)

    vault_id: UUID
    embedding: Embedding


class IdeaOverview(BaseModel):
    """Narrow read of an idea — ``idea_id`` and ``embedding`` only.

    Used by partition's k-means: only the vector and a row identifier
    are needed to assemble the input matrix. Omitting anchors avoids the
    lazy-load relationship that can't be accessed in an async session,
    and trimming the doc/kind/label/description columns keeps vault-wide
    scans light.
    """

    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True)

    idea_id: UUID
    embedding: Embedding


class SourceCard(BaseModel):
    """Read-time aggregate over ``source_documents`` + ``ideas`` + ``anchors``.

    All fields except ``ideas`` map 1:1 to the LLM-derived columns and
    ``derived_extras`` JSONB on ``source_documents``. ``derived_extras``
    carries whatever vault-configured enriched fields the vault's
    config declared; its shape is dynamic and surfaces in compile's
    editorial context (partition / synthesize) generically.
    """

    document_id: UUID
    title: str
    precis: str
    author: str | None = None
    published_date: str | None = None
    genre: str | None = None
    tags: list[str] = Field(default_factory=list)
    derived_extras: dict = Field(default_factory=dict)
    ideas: list[Idea]
