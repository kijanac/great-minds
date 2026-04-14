"""Run the canonicalization pipeline over a brain's source cards.

Reads .compile/<brain_id>/source_cards.jsonl, runs embedding + threshold
clustering + LLM refinement, writes .compile/<brain_id>/subjects.jsonl
and back-fills subject_id into source_cards.jsonl.

Usage:
    uv run python scripts/run_canonicalize.py [--brain-id UUID] [--threshold F] [--concurrency N]
"""

import argparse
import asyncio
import uuid

from great_minds.core.llm import get_async_client
from great_minds.core.subjects.canonicalizer import (
    REFINE_CONCURRENCY,
    SIMILARITY_THRESHOLD,
    canonicalize,
)
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def run(brain_id: uuid.UUID, threshold: float, concurrency: int) -> None:
    print(f"Canonicalizing brain={brain_id} threshold={threshold} concurrency={concurrency}")
    client = get_async_client()
    result = await canonicalize(
        client,
        brain_id=brain_id,
        threshold=threshold,
        refine_concurrency=concurrency,
    )
    print()
    print(f"Subjects:      .compile/{brain_id}/subjects.jsonl")
    print(f"Source cards:  .compile/{brain_id}/source_cards.jsonl (subject_ids filled)")
    print(f"Candidates:    {len(result.candidate_to_subject)}")
    print(f"Clusters:      {result.n_clusters}  (singletons: {result.n_singletons})")
    print(f"Subjects out:  {len(result.subjects)}")
    if result.subjects:
        multi = sum(
            1 for s in result.subjects if len(s.supporting_document_ids) > 1
        )
        max_docs = max(len(s.supporting_document_ids) for s in result.subjects)
        print(f"Multi-doc subj: {multi}/{len(result.subjects)}")
        print(f"Max docs/subj:  {max_docs}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--brain-id", type=uuid.UUID, default=PROTOTYPE_BRAIN_ID
    )
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
