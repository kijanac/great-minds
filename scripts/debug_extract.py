"""Extract one doc with full diagnostics.

Intended for investigating extraction failures — runs the extractor on
a single file and prints finish_reason, output_tokens, raw head/tail,
and any parse error. Does not write source cards.

Usage:
    uv run python scripts/debug_extract.py <path/to/file.md>
"""

import argparse
import asyncio
import uuid
from pathlib import Path

from great_minds.core.llm import get_async_client
from great_minds.core.subjects.service import (
    document_id_for,
    extract_source_card,
)
from great_minds.core.telemetry import setup_logging
from great_minds.core.brain_utils import parse_frontmatter

PROTOTYPE_BRAIN_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


async def run(file_path: Path) -> None:
    content = file_path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)
    document_id = document_id_for(PROTOTYPE_BRAIN_ID, file_path.as_posix())

    print(f"doc:          {file_path.name}")
    print(f"document_id:  {document_id}")
    print(f"body length:  {len(body):,} chars")
    print()

    client = get_async_client()
    try:
        result = await extract_source_card(
            client,
            document_id=document_id,
            brain_id=PROTOTYPE_BRAIN_ID,
            title=fm.get("title") or "",
            author=fm.get("author") or "",
            date=str(fm.get("date") or ""),
            body=body,
        )
        print(f"SUCCESS — {len(result.source_card.ideas)} ideas, "
              f"{len(result.source_card.anchors)} anchors")
    except Exception as e:
        print(f"FAIL — {type(e).__name__}: {e}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    setup_logging(service="great-minds")
    asyncio.run(run(args.path))


if __name__ == "__main__":
    main()
