"""Run the source card extractor on a corpus of raw markdown files.

Prototype iteration tool for dev loops that bypass the full ingestion
pipeline. Reads *.md files from a directory, parses any YAML frontmatter
they already carry for title/author/date, and calls the core extraction
primitive with the --source-type provided on the CLI. Writes source
cards to .compile/<brain_id>/source_cards.jsonl.

Production ingestion lives at `ingest_service` and writes full
frontmatter (including source_type) through the ingester. Use this
script when you want fast extraction iteration on a raw corpus dir
without spinning up the API + DB + workers path.

Usage:
    uv run python scripts/run_extract.py <corpus_dir> [--source-type T]
        [--limit N] [--sample N --seed S] [--brain-id UUID] [--concurrency N]
"""

import argparse
import asyncio
import random
import uuid
from pathlib import Path

from great_minds.core.brain_utils import parse_frontmatter
from great_minds.core.llm import get_async_client
from great_minds.core.subjects.schemas import SourceType
from great_minds.core.subjects.service import (
    ExtractionResult,
    document_id_for,
    extract_source_card,
    write_source_card,
)
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def _extract_one(
    sem: asyncio.Semaphore,
    client,
    brain_id: uuid.UUID,
    source_type: SourceType,
    file_path: Path,
) -> tuple[Path, ExtractionResult | Exception]:
    async with sem:
        try:
            content = file_path.read_text(encoding="utf-8")
            fm, body = parse_frontmatter(content)
            document_id = document_id_for(brain_id, file_path.as_posix())
            result = await extract_source_card(
                client,
                document_id=document_id,
                brain_id=brain_id,
                source_type=source_type,
                title=fm.get("title") or "",
                author=fm.get("author") or "",
                date=str(fm.get("date") or ""),
                body=body,
            )
            anchor_total = sum(
                len(idea.anchors) for idea in result.source_card.ideas
            )
            print(
                f"  {file_path.name} ... OK  "
                f"{len(result.source_card.ideas)} ideas, "
                f"{anchor_total} anchors",
                flush=True,
            )
            return file_path, result
        except Exception as e:
            print(f"  {file_path.name} ... FAIL {type(e).__name__}: {e}", flush=True)
            return file_path, e


async def run(
    corpus_dir: Path,
    brain_id: uuid.UUID,
    source_type: SourceType,
    limit: int | None,
    sample: int | None,
    seed: int,
    concurrency: int,
) -> None:
    all_files = sorted(corpus_dir.rglob("*.md"))
    if sample is not None:
        rng = random.Random(seed)
        files = rng.sample(all_files, k=min(sample, len(all_files)))
        files.sort()
    else:
        files = all_files
    if limit is not None:
        files = files[:limit]
    print(
        f"Extracting {len(files)} file(s) from {corpus_dir} "
        f"(brain={brain_id}, source_type={source_type.value}, "
        f"concurrency={concurrency}"
        f"{f', sample={sample} seed={seed}' if sample else ''})"
    )

    client = get_async_client()
    sem = asyncio.Semaphore(concurrency)
    outcomes = await asyncio.gather(
        *(_extract_one(sem, client, brain_id, source_type, fp) for fp in files)
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
    anch_counts = [
        sum(len(idea.anchors) for idea in r.source_card.ideas) for r in successes
    ]
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
        "--source-type",
        type=SourceType,
        choices=list(SourceType),
        default=SourceType.DOCUMENT,
        help="source_type tag applied to every card (default: document)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="only process the first N files (applied after --sample if both set)",
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=None,
        help="randomly sample N files from the corpus (representative picks)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="random seed for --sample (default: 42)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=20,
        help="max concurrent LLM calls (default: 20)",
    )
    args = parser.parse_args()

    setup_logging(service="great-minds")
    asyncio.run(
        run(
            args.corpus_dir,
            args.brain_id,
            args.source_type,
            args.limit,
            args.sample,
            args.seed,
            args.concurrency,
        )
    )


if __name__ == "__main__":
    main()
