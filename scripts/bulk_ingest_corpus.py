"""Bulk-ingest a corpus directory into a vault.

Mirrors workers.staged_file_ingest_task but runs standalone — no absurd
task queue, no heartbeats. For local dev + first-compile sanity checks.

Usage:
    uv run python scripts/bulk_ingest_corpus.py \\
        <vault_id> <source_dir> <dest_rel> [--data-dir PATH] [--origin LABEL]

Example:
    uv run python scripts/bulk_ingest_corpus.py \\
        6d5f211f-a0b3-48c2-a361-fd83816765b8 \\
        corpus/lenin/works/1897 raw/docs/lenin/1897 \\
        --data-dir test_data --origin "MIA Archive"
"""

import argparse
import asyncio
import hashlib
from pathlib import Path
from uuid import UUID

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from great_minds.core.documents.builder import write_document
from great_minds.core.documents.repository import SourceDocumentRepo
from great_minds.core.documents.schemas import SourceDocCreate
from great_minds.core.documents.service import SourceDocumentService
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.settings import get_settings
from great_minds.core.storage import LocalStorage


async def main(
    vault_id: UUID,
    source_dir: Path,
    dest_rel: str,
    data_dir: Path,
    origin: str | None,
) -> None:
    storage = LocalStorage(data_dir / "vaults" / str(vault_id))
    source_files = sorted(source_dir.rglob("*.md"))
    total = len(source_files)
    if total == 0:
        print(f"No .md files found under {source_dir}")
        return

    print(f"Ingesting {total} files from {source_dir} → {dest_rel}/")

    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    async with sm() as session:
        doc_service = SourceDocumentService(SourceDocumentRepo(session))
        existing_hashes = await doc_service.file_hashes(vault_id)

        batch: list[SourceDocCreate] = []
        ingested = 0
        skipped = 0

        for i, fp in enumerate(source_files):
            relative = fp.relative_to(source_dir)
            dest = f"{dest_rel}/{relative}"

            raw_content = fp.read_text(encoding="utf-8")
            content_with_fm = await write_document(
                storage,
                raw_content,
                dest=dest,
                source_type="document",
                origin=origin,
            )
            file_hash = hashlib.sha256(content_with_fm.encode()).hexdigest()

            if existing_hashes.get(dest) == file_hash:
                skipped += 1
                continue

            await storage.write(dest, content_with_fm)
            ingested += 1

            fm, _ = parse_frontmatter(content_with_fm)
            batch.append(SourceDocCreate.from_frontmatter(fm, dest, content_with_fm))

            if len(batch) >= 50:
                await doc_service.batch_index(vault_id, batch)
                batch.clear()

            if (i + 1) % 25 == 0:
                print(f"  {i + 1}/{total} (ingested={ingested}, skipped={skipped})")

        if batch:
            await doc_service.batch_index(vault_id, batch)

    print(f"\nDone: ingested={ingested}, skipped={skipped}, total={total}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("vault_id", type=UUID)
    p.add_argument("source_dir", type=Path)
    p.add_argument(
        "dest_rel",
        help="Destination path relative to vault root, e.g. raw/docs/lenin/1897",
    )
    p.add_argument("--data-dir", type=Path, default=Path("/data"))
    p.add_argument("--origin", default=None, help="Origin label for the ingested batch")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    asyncio.run(
        main(
            args.vault_id,
            args.source_dir,
            args.dest_rel,
            args.data_dir,
            args.origin,
        )
    )
