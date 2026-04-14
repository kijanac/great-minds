"""Run the source card extractor on a corpus of raw markdown files.

Prototype iteration tool. Reads *.md files from a directory, runs the
extraction service on each (concurrently), writes source cards to
.compile/<brain_id>/source_cards.jsonl, prints per-doc and summary stats.

Usage:
    uv run python scripts/run_extract.py <corpus_dir> [--limit N] [--brain-id UUID] [--concurrency N]
"""

import argparse
import asyncio
import uuid
from pathlib import Path

from great_minds.core.llm import get_async_client
from great_minds.core.subjects.service import (
    ExtractionResult,
    extract_from_file,
    write_source_card,
)
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def _extract_one(
    sem: asyncio.Semaphore,
    client,
    brain_id: uuid.UUID,
    file_path: Path,
) -> tuple[Path, ExtractionResult | Exception]:
    async with sem:
        try:
            result = await extract_from_file(
                client, brain_id=brain_id, file_path=file_path, write_card=False
            )
            print(
                f"  {file_path.name} ... OK  "
                f"{len(result.source_card.ideas)} ideas, "
                f"{len(result.source_card.anchors)} anchors",
                flush=True,
            )
            return file_path, result
        except Exception as e:
            print(f"  {file_path.name} ... FAIL {type(e).__name__}: {e}", flush=True)
            return file_path, e


async def run(
    corpus_dir: Path,
    brain_id: uuid.UUID,
    limit: int | None,
    concurrency: int,
) -> None:
    files = sorted(corpus_dir.glob("*.md"))
    if limit is not None:
        files = files[:limit]
    print(
        f"Extracting {len(files)} file(s) from {corpus_dir} "
        f"(brain={brain_id}, concurrency={concurrency})"
    )

    client = get_async_client()
    sem = asyncio.Semaphore(concurrency)
    outcomes = await asyncio.gather(
        *(_extract_one(sem, client, brain_id, fp) for fp in files)
    )

    # Serial write after all extractions (avoids read-all-replace-all race).
    successes: list[ExtractionResult] = []
    for _, outcome in outcomes:
        if isinstance(outcome, ExtractionResult):
            write_source_card(brain_id=brain_id, card=outcome.source_card)
            successes.append(outcome)

    if not successes:
        print("\nNo successful extractions.")
        return

    idea_counts = [len(r.source_card.ideas) for r in successes]
    anch_counts = [len(r.source_card.anchors) for r in successes]
    print()
    print(f"Source cards: .compile/{brain_id}/source_cards.jsonl")
    print(f"Successful:   {len(successes)}/{len(files)}")
    print(
        f"Ideas/doc       min={min(idea_counts)} max={max(idea_counts)} "
        f"mean={sum(idea_counts) / len(idea_counts):.1f}"
    )
    print(
        f"Anchors/doc     min={min(anch_counts)} max={max(anch_counts)} "
        f"mean={sum(anch_counts) / len(anch_counts):.1f}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("corpus_dir", type=Path, help="directory of raw *.md docs")
    parser.add_argument(
        "--brain-id",
        type=uuid.UUID,
        default=PROTOTYPE_BRAIN_ID,
        help="brain id (default: prototype UUID)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="only process the first N files",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=20,
        help="max concurrent LLM calls (default: 20)",
    )
    args = parser.parse_args()

    setup_logging(service="great-minds")
    asyncio.run(run(args.corpus_dir, args.brain_id, args.limit, args.concurrency))


if __name__ == "__main__":
    main()
