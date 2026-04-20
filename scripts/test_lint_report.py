"""Dump the mechanical lint report for a brain.

Runs build_lint_report against a live brain (default: the prototype)
and prints the results plus basic shape invariants. Not a unit test —
useful for eyeballing what lint would surface on the current registry.

Usage:
    uv run python scripts/test_lint_report.py [--brain-id UUID] [--min-uses N]
"""

from __future__ import annotations

import argparse
import asyncio
import uuid

from sqlalchemy import select

from great_minds.core.db import session_maker
from great_minds.core.subjects.distiller import slugify_concept_label
from great_minds.core.subjects.lint import build_lint_report
from great_minds.core.subjects.models import ConceptORM
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def run(brain_id: uuid.UUID, min_uses: int) -> None:
    async with session_maker() as session:
        report = await build_lint_report(session, brain_id, min_uses=min_uses)

        existing_slugs_result = await session.execute(
            select(ConceptORM.slug).where(ConceptORM.brain_id == brain_id)
        )
        existing_slugs = {row.slug for row in existing_slugs_result}

    print(f"brain_id: {brain_id}")
    print(f"min_uses: {min_uses}")
    print(f"registry size: {len(existing_slugs)}")
    print()

    print(f"research_suggestions ({len(report.research_suggestions)}):")
    for s in report.research_suggestions[:20]:
        sample = ", ".join(s.mentioned_in[:3])
        more = f" (+{len(s.mentioned_in) - 3} more)" if len(s.mentioned_in) > 3 else ""
        print(f"  - {s.topic}  ·  {s.usage_count}x  ·  {sample}{more}")
    if len(report.research_suggestions) > 20:
        print(f"  ... {len(report.research_suggestions) - 20} more")
    print()

    print(f"orphans ({len(report.orphans)}):")
    for o in report.orphans[:20]:
        print(f"  - {o.canonical_label}  ({o.slug})")
    if len(report.orphans) > 20:
        print(f"  ... {len(report.orphans) - 20} more")
    print()

    print(f"dirty_concepts ({len(report.dirty_concepts)})")
    if report.dirty_concepts:
        for cid in report.dirty_concepts[:5]:
            print(f"  - {cid}")
        if len(report.dirty_concepts) > 5:
            print(f"  ... {len(report.dirty_concepts) - 5} more")
    print()

    print(f"contradictions: {len(report.contradictions)}")
    print()

    # Shape invariants — these are the only hard assertions.
    for s in report.research_suggestions:
        assert s.usage_count >= min_uses, (
            f"suggestion {s.topic!r} has usage_count={s.usage_count} "
            f"but min_uses={min_uses}"
        )
        slug = slugify_concept_label(s.topic)
        assert slug not in existing_slugs, (
            f"suggestion {s.topic!r} slugifies to {slug!r} which is already in "
            "the registry — should have been filtered out"
        )
    for o in report.orphans:
        assert o.slug in existing_slugs, (
            f"orphan slug {o.slug!r} not in concept registry — stale row?"
        )
    assert report.contradictions == [], (
        "contradictions is reserved for tool-grounded lint and should stay empty"
    )
    print("invariants OK")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--brain-id", type=uuid.UUID, default=PROTOTYPE_BRAIN_ID)
    parser.add_argument("--min-uses", type=int, default=2)
    args = parser.parse_args()

    setup_logging(service="great-minds")
    asyncio.run(run(args.brain_id, args.min_uses))


if __name__ == "__main__":
    main()
