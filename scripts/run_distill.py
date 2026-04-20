"""Run the distillation pipeline over a brain's source cards.

Reads .compile/<brain_id>/source_cards.jsonl, runs embedding + threshold
clustering + LLM refinement, writes .compile/<brain_id>/subjects.jsonl
and back-fills concept_id into source_cards.jsonl.

Usage:
    uv run python scripts/run_distill.py [--brain-id UUID] [--threshold F] [--concurrency N]
"""

import argparse
import asyncio
import uuid

from great_minds.core.llm import get_async_client
from great_minds.core.subjects.distiller import (
    REFINE_CONCURRENCY,
    SIMILARITY_THRESHOLD,
    distill,
)
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def run(brain_id: uuid.UUID, threshold: float, concurrency: int) -> None:
    print(
        f"Distilling brain={brain_id} threshold={threshold} concurrency={concurrency}"
    )
    client = get_async_client()
    result = await distill(
        client,
        brain_id=brain_id,
        threshold=threshold,
        refine_concurrency=concurrency,
    )
    print()
    print(f"Concepts:       .compile/{brain_id}/subjects.jsonl")
    print(
        f"Source cards:   .compile/{brain_id}/source_cards.jsonl (concept_ids filled)"
    )
    print(f"Ideas:          {len(result.idea_to_concept)}")
    print(f"Clusters:       {result.n_clusters}  (singletons: {result.n_singletons})")
    print(f"Concepts out:   {len(result.concepts)}")
    if result.concepts:
        multi = sum(1 for c in result.concepts if len(c.supporting_document_ids) > 1)
        max_docs = max(len(c.supporting_document_ids) for c in result.concepts)
        print(f"Multi-doc:      {multi}/{len(result.concepts)}")
        print(f"Max docs/cpt:   {max_docs}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--brain-id", type=uuid.UUID, default=PROTOTYPE_BRAIN_ID)
    parser.add_argument(
        "--threshold",
        type=float,
        default=SIMILARITY_THRESHOLD,
        help=f"similarity threshold for edge inclusion (default: {SIMILARITY_THRESHOLD})",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=REFINE_CONCURRENCY,
        help=f"parallel LLM refinement calls (default: {REFINE_CONCURRENCY})",
    )
    args = parser.parse_args()

    setup_logging(service="great-minds")
    asyncio.run(run(args.brain_id, args.threshold, args.concurrency))


if __name__ == "__main__":
    main()
