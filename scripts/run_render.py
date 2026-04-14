"""Render wiki articles for a brain's canonicalized subjects.

Reads .compile/<brain_id>/subjects.jsonl and .compile/<brain_id>/source_cards.jsonl,
scans raw_dir for source doc bodies, writes markdown articles to wiki_dir.

Usage:
    uv run python scripts/run_render.py <raw_dir> [--wiki-dir <dir>] [--only-multi-doc] [--limit N] [--concurrency N]
"""

import argparse
import asyncio
import uuid
from pathlib import Path

from great_minds.core.llm import get_async_client
from great_minds.core.subjects.renderer import render_brain
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def run(
    brain_id: uuid.UUID,
    raw_dir: Path,
    wiki_dir: Path,
    only_multi_doc: bool,
    limit: int | None,
    concurrency: int,
    raw_link_prefix: str,
) -> None:
    client = get_async_client()
    paths = await render_brain(
        client,
        brain_id=brain_id,
        raw_dir=raw_dir,
        wiki_dir=wiki_dir,
        only_multi_doc=only_multi_doc,
        limit=limit,
        concurrency=concurrency,
        raw_link_prefix=raw_link_prefix,
    )
    print()
    print(f"Rendered {len(paths)} article(s) to {wiki_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("raw_dir", type=Path, help="directory of raw *.md source docs")
    parser.add_argument(
        "--brain-id", type=uuid.UUID, default=PROTOTYPE_BRAIN_ID
    )
    parser.add_argument(
        "--wiki-dir",
        type=Path,
        default=None,
        help="output directory (default: .compile/<brain_id>/wiki/)",
    )
    parser.add_argument(
        "--only-multi-doc",
        action="store_true",
        help="render only subjects with >1 supporting document",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="render at most N subjects"
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=10,
        help="max concurrent writer LLM calls (default: 10)",
    )
    parser.add_argument(
        "--raw-link-prefix",
        default="raw/texts",
        help="path prefix for footnote links (default: raw/texts)",
    )
    args = parser.parse_args()

    wiki_dir = args.wiki_dir or (
        Path(".compile") / str(args.brain_id) / "wiki"
    )

    setup_logging(service="great-minds")
    asyncio.run(
        run(
            args.brain_id,
            args.raw_dir,
            wiki_dir,
            args.only_multi_doc,
            args.limit,
            args.concurrency,
            args.raw_link_prefix,
        )
    )


if __name__ == "__main__":
    main()
