"""Extract one doc with full diagnostics.

Intended for investigating extraction failures. Runs the core extraction
primitive on a single file with the --source-type provided on the CLI,
bypassing the ingestion pipeline. Does not write source cards.

Usage:
    uv run python scripts/debug_extract.py <path/to/file.md> [--source-type T]
"""

import argparse
import asyncio
import uuid
from pathlib import Path

from great_minds.core.brain_utils import parse_frontmatter
from great_minds.core.llm import get_async_client
from great_minds.core.subjects.schemas import SourceType
from great_minds.core.subjects.service import (
    document_id_for,
    extract_source_card,
)
from great_minds.core.telemetry import setup_logging

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def run(file_path: Path, source_type: SourceType) -> None:
    content = file_path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)
    document_id = document_id_for(PROTOTYPE_BRAIN_ID, file_path.as_posix())

    print(f"doc:          {file_path.name}")
    print(f"document_id:  {document_id}")
    print(f"source_type:  {source_type.value}")
    print(f"body length:  {len(body):,} chars")
    print()

    client = get_async_client()
    try:
        result = await extract_source_card(
            client,
            document_id=document_id,
            brain_id=PROTOTYPE_BRAIN_ID,
            source_type=source_type,
            title=fm.get("title") or "",
            author=fm.get("author") or "",
            date=str(fm.get("date") or ""),
            body=body,
        )
        ideas = result.source_card.ideas
        anchors = sum(len(idea.anchors) for idea in ideas)
        print(f"SUCCESS — {len(ideas)} ideas, {anchors} anchors")
    except Exception as e:
        print(f"FAIL — {type(e).__name__}: {e}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path", type=Path)
    parser.add_argument(
        "--source-type",
        type=SourceType,
        choices=list(SourceType),
        default=SourceType.DOCUMENT,
        help="source_type tag applied to the card (default: document)",
    )
    args = parser.parse_args()
    setup_logging(service="great-minds")
    asyncio.run(run(args.path, args.source_type))


if __name__ == "__main__":
    main()
