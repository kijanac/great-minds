"""flatten metadata: derived_extras column + provenance columns, drop doc_metadata bag

Enacts the architectural collapse documented in the refactor:

- Drops the per-content-type metadata schema. There is now one universal
  set of LLM-derived columns plus a single JSONB (`derived_extras`) for
  vault-configured enriched fields.
- Pulls session/user provenance fields out of the JSONB bag into typed
  columns. The bag was being overwritten by extract on every compile,
  silently destroying these system-set fields.
- Backfills `genre` and `tags` columns from the previously-JSONB-stored
  LLM extracted values; the columns existed but were only populated from
  frontmatter (which curators don't fill).
- Relaxes `title` NOT NULL. Title is LLM-derived now; NULL until first
  compile rather than an empty-string placeholder.
- Renames source_type='user' rows with origin='session-exchange' to
  source_type='session'. The current shared-as-'user' value conflated
  two distinct source kinds.

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-14
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0009"
down_revision: Union[str, Sequence[str], None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add new columns.
    op.add_column(
        "source_documents",
        sa.Column("derived_extras", JSONB, nullable=False, server_default="{}"),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_session_id", UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_exchange_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_session_query", sa.Text(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_source_doc_path", sa.Text(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_source_anchor", sa.Text(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_source_paragraph_index", sa.Integer(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_anchored_to", sa.Text(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_anchored_section", sa.Text(), nullable=True),
    )
    op.add_column(
        "source_documents",
        sa.Column("provenance_intent", sa.Text(), nullable=True),
    )

    # 2. Re-discriminate source_type. Session-promoted exchanges and user
    #    suggestions both currently land as 'user', distinguished only by
    #    origin. Split them BEFORE we backfill per-kind provenance so the
    #    provenance writes can key off source_type cleanly.
    op.execute(
        """
        UPDATE source_documents
        SET source_type = 'session'
        WHERE source_type = 'user'
          AND origin = 'session-exchange'
        """
    )

    # 3. Session provenance backfill from the now-leaving JSONB bag.
    op.execute(
        """
        UPDATE source_documents
        SET provenance_session_id           = NULLIF(metadata->>'source_session_id', '')::uuid,
            provenance_exchange_id          = metadata->>'source_exchange_id',
            provenance_session_query        = metadata->>'source_query',
            provenance_source_doc_path      = metadata->>'source_doc_path',
            provenance_source_anchor        = metadata->>'source_anchor',
            provenance_source_paragraph_index =
                NULLIF(metadata->>'source_paragraph_index', '')::integer
        WHERE source_type = 'session'
        """
    )

    # 4. User-suggestion provenance backfill.
    op.execute(
        """
        UPDATE source_documents
        SET provenance_anchored_to      = metadata->>'anchored_to',
            provenance_anchored_section = metadata->>'anchored_section',
            provenance_intent           = metadata->>'intent'
        WHERE source_type = 'user'
        """
    )

    # 5. Backfill genre/tags columns from the JSONB bag. The LLM has been
    #    writing extract output into doc_metadata.genre / doc_metadata.tags
    #    while the columns held only the frontmatter values (typically
    #    empty since curators don't author title/genre/tags). The column
    #    becomes the single source of truth going forward.
    op.execute(
        """
        UPDATE source_documents
        SET genre = metadata->>'genre'
        WHERE metadata ? 'genre'
          AND metadata->>'genre' IS NOT NULL
          AND metadata->>'genre' != ''
        """
    )
    op.execute(
        """
        UPDATE source_documents
        SET tags = ARRAY(SELECT jsonb_array_elements_text(metadata->'tags'))
        WHERE jsonb_typeof(metadata->'tags') = 'array'
          AND jsonb_array_length(metadata->'tags') > 0
        """
    )

    # 6. Strip everything we just relocated from the JSONB, leaving only
    #    vault-configured enriched extras (tradition, interlocutors, etc.).
    op.execute(
        """
        UPDATE source_documents
        SET derived_extras = COALESCE(metadata, '{}'::jsonb)
            - 'source_session_id'
            - 'source_exchange_id'
            - 'source_query'
            - 'source_doc_path'
            - 'source_anchor'
            - 'source_paragraph_index'
            - 'anchored_to'
            - 'anchored_section'
            - 'intent'
            - 'genre'
            - 'tags'
            - 'topic_id'
        """
    )

    # 7. Drop the legacy bag.
    op.drop_column("source_documents", "metadata")

    # 8. Relax title NOT NULL (was tightened in 0007 on the now-abandoned
    #    "title always supplied at ingest" premise).
    op.alter_column("source_documents", "title", nullable=True)

    # 9. Drop the dead ``compiled`` column. No writer ever set it to True,
    #    so every row was ``compiled=False`` forever. The frontend gold-dot
    #    indicator that read it was permanent decoration; the API filter
    #    parameter that depended on it was inert.
    op.drop_column("source_documents", "compiled")


def downgrade() -> None:
    op.add_column(
        "source_documents",
        sa.Column(
            "compiled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "source_documents",
        sa.Column("metadata", JSONB, nullable=False, server_default="{}"),
    )

    # Reconstruct the JSONB from columns. Provenance + genre + tags get
    # folded back; derived_extras contents pass through.
    op.execute(
        """
        UPDATE source_documents
        SET metadata = COALESCE(derived_extras, '{}'::jsonb)
            || CASE WHEN genre IS NOT NULL THEN jsonb_build_object('genre', genre) ELSE '{}'::jsonb END
            || CASE WHEN array_length(tags, 1) > 0
                    THEN jsonb_build_object('tags', to_jsonb(tags))
                    ELSE '{}'::jsonb END
            || jsonb_strip_nulls(jsonb_build_object(
                'source_session_id', provenance_session_id::text,
                'source_exchange_id', provenance_exchange_id,
                'source_query', provenance_session_query,
                'source_doc_path', provenance_source_doc_path,
                'source_anchor', provenance_source_anchor,
                'source_paragraph_index', provenance_source_paragraph_index::text,
                'anchored_to', provenance_anchored_to,
                'anchored_section', provenance_anchored_section,
                'intent', provenance_intent
            ))
        """
    )

    op.execute(
        """
        UPDATE source_documents
        SET source_type = 'user'
        WHERE source_type = 'session'
        """
    )

    for col in (
        "provenance_intent",
        "provenance_anchored_section",
        "provenance_anchored_to",
        "provenance_source_paragraph_index",
        "provenance_source_anchor",
        "provenance_source_doc_path",
        "provenance_session_query",
        "provenance_exchange_id",
        "provenance_session_id",
        "derived_extras",
    ):
        op.drop_column("source_documents", col)

    op.alter_column("source_documents", "title", nullable=False)
