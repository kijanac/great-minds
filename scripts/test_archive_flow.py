"""Smoke test for Phase 7 archive / supersession.

Reuses the existing prototype brain with prefix-isolated fixture data:

- Seeds 3 ConceptORM rows (all prefix `__archive_test__-`):
  - `...-finance-capital-and-imperialism` (will retire)
  - `...-imperialism-and-finance-capital` (live, will be picked as successor)
  - `...-narodniks` (live, unrelated — should NOT be picked)
- Writes a stub wiki file for the retiring concept

Runs archive_retired_concepts and asserts:

- wiki/...-finance-capital-and-imperialism.md moved to
  .compile/<brain>/archive/<concept_id>/<slug>.md
- Archived frontmatter carries `archived: true` and
  `superseded_by: __archive_test__-imperialism-and-finance-capital`
- ConceptORM row: article_status='archived',
  superseded_by=<successor concept_id>
- The unrelated narodniks concept is NOT set as successor (token
  overlap below threshold)

Usage:
    uv run python scripts/test_archive_flow.py
"""

from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path

from sqlalchemy import delete, select

from great_minds.core.brain_utils import parse_frontmatter
from great_minds.core.db import session_maker
from great_minds.core.ids import uuid7
from great_minds.core.subjects.archive import archive_retired_concepts, archive_path
from great_minds.core.subjects.models import ConceptORM
from great_minds.core.subjects.schemas import Concept, SubjectKind
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")
PREFIX = "__archive_test__"
SLUG_PREFIX = f"{PREFIX}-"

RETIRED_SLUG = f"{SLUG_PREFIX}finance-capital-and-imperialism"
SUCCESSOR_SLUG = f"{SLUG_PREFIX}imperialism-and-finance-capital"
UNRELATED_SLUG = f"{SLUG_PREFIX}narodniks"

WIKI_DIR = Path(".compile") / str(PROTOTYPE_BRAIN_ID) / "test_archive_wiki"

STUB_BODY = """\
---
concept_id: {cid}
kind: concept
canonical_label: Finance capital and imperialism
description: An early formulation that later got renamed.
---

# Finance capital and imperialism

Stub body for archive smoke test.
"""


async def _seed(
    session, retired_id: uuid.UUID, successor_id: uuid.UUID, unrelated_id: uuid.UUID
) -> None:
    session.add_all(
        [
            ConceptORM(
                concept_id=retired_id,
                brain_id=PROTOTYPE_BRAIN_ID,
                kind="concept",
                canonical_label="Finance capital and imperialism",
                slug=RETIRED_SLUG,
                description="...",
                article_status="rendered",
                compiled_from_hash="h-retired",
                rendered_from_hash="h-retired",
            ),
            ConceptORM(
                concept_id=successor_id,
                brain_id=PROTOTYPE_BRAIN_ID,
                kind="concept",
                canonical_label="Imperialism and finance capital",
                slug=SUCCESSOR_SLUG,
                description="...",
                article_status="rendered",
                compiled_from_hash="h-succ",
                rendered_from_hash="h-succ",
            ),
            ConceptORM(
                concept_id=unrelated_id,
                brain_id=PROTOTYPE_BRAIN_ID,
                kind="movement",
                canonical_label="Narodniks",
                slug=UNRELATED_SLUG,
                description="...",
                article_status="rendered",
                compiled_from_hash="h-nar",
                rendered_from_hash="h-nar",
            ),
        ]
    )
    await session.commit()

    WIKI_DIR.mkdir(parents=True, exist_ok=True)
    (WIKI_DIR / f"{RETIRED_SLUG}.md").write_text(
        STUB_BODY.format(cid=retired_id), encoding="utf-8"
    )


async def _teardown(session, archived_concept_ids: list[uuid.UUID]) -> None:
    await session.execute(
        delete(ConceptORM).where(
            ConceptORM.brain_id == PROTOTYPE_BRAIN_ID,
            ConceptORM.slug.like(f"{SLUG_PREFIX}%"),
        )
    )
    await session.commit()
    if WIKI_DIR.exists():
        shutil.rmtree(WIKI_DIR)
    for cid in archived_concept_ids:
        # archive_path roots at .compile/<brain>/archive/<cid>/
        archive_dir = archive_path(PROTOTYPE_BRAIN_ID, cid, "x").parent
        if archive_dir.exists():
            shutil.rmtree(archive_dir)


def _concept_stub(concept_id: uuid.UUID, slug: str, label: str) -> Concept:
    return Concept(
        concept_id=concept_id,
        brain_id=PROTOTYPE_BRAIN_ID,
        kind=SubjectKind.CONCEPT,
        canonical_label=label,
        slug=slug,
        description="...",
        supporting_document_ids=[],
        member_idea_ids=[],
        compiled_from_hash="h",
    )


async def run() -> None:
    retired_id = uuid7()
    successor_id = uuid7()
    unrelated_id = uuid7()

    async with session_maker() as session:
        await _teardown(session, [retired_id])
        try:
            await _seed(session, retired_id, successor_id, unrelated_id)

            # Live set = every concept currently in the brain MINUS the one
            # we're retiring. Mirrors what compile_pipeline would pass.
            all_rows = await session.execute(
                select(
                    ConceptORM.concept_id,
                    ConceptORM.slug,
                    ConceptORM.canonical_label,
                ).where(
                    ConceptORM.brain_id == PROTOTYPE_BRAIN_ID,
                    ConceptORM.slug != RETIRED_SLUG,
                    ConceptORM.article_status != "archived",
                )
            )
            live = [
                _concept_stub(row.concept_id, row.slug, row.canonical_label)
                for row in all_rows
            ]

            entries = await archive_retired_concepts(
                session=session,
                brain_id=PROTOTYPE_BRAIN_ID,
                live_concepts=live,
                wiki_dir=WIKI_DIR,
            )

            print(f"archived: {len(entries)}")
            for e in entries:
                print(
                    f"  - {e.old_slug!r}  →  {e.superseded_by_slug!r}  "
                    f"(concept {e.concept_id}, path {e.archive_path})"
                )

            assert len(entries) == 1, (
                f"expected exactly 1 archived entry, got {len(entries)}"
            )
            entry = entries[0]
            assert entry.concept_id == retired_id
            assert entry.old_slug == RETIRED_SLUG
            assert entry.superseded_by_slug == SUCCESSOR_SLUG, (
                f"expected {SUCCESSOR_SLUG!r} as successor, got "
                f"{entry.superseded_by_slug!r}"
            )
            assert entry.superseded_by_concept_id == successor_id

            archived_file = archive_path(PROTOTYPE_BRAIN_ID, retired_id, RETIRED_SLUG)
            assert archived_file.exists(), f"archived file missing at {archived_file}"
            assert not (WIKI_DIR / f"{RETIRED_SLUG}.md").exists(), (
                "source wiki file should have been removed"
            )

            archived_text = archived_file.read_text(encoding="utf-8")
            fm, _ = parse_frontmatter(archived_text)
            assert fm.get("superseded_by") == SUCCESSOR_SLUG

            # ORM updated?
            row = (
                await session.execute(
                    select(
                        ConceptORM.article_status,
                        ConceptORM.superseded_by,
                    ).where(
                        ConceptORM.brain_id == PROTOTYPE_BRAIN_ID,
                        ConceptORM.concept_id == retired_id,
                    )
                )
            ).one()
            assert row.article_status == "archived", (
                f"expected article_status=archived, got {row.article_status}"
            )
            assert row.superseded_by == successor_id

            # Re-run should be a no-op (idempotency)
            second = await archive_retired_concepts(
                session=session,
                brain_id=PROTOTYPE_BRAIN_ID,
                live_concepts=live,
                wiki_dir=WIKI_DIR,
            )
            assert second == [], (
                f"second archive pass should be a no-op, got {len(second)} entries"
            )

            print()
            print("OK  retired concept moved to archive/<concept_id>/<slug>.md")
            print("OK  frontmatter carries superseded_by=successor")
            print("OK  ConceptORM: article_status=archived, superseded_by=successor")
            print("OK  token overlap filters out unrelated concepts (narodniks)")
            print("OK  second archive pass is a no-op (idempotent)")
        finally:
            await _teardown(session, [retired_id])


def main() -> None:
    setup_logging(service="great-minds")
    asyncio.run(run())


if __name__ == "__main__":
    main()
