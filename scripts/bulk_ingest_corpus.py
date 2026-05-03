"""Bulk-ingest a corpus directory into a vault.

Mirrors workers.bulk_ingest_task but runs standalone — no absurd task
queue, no heartbeats. For local dev + first-compile sanity checks.

Usage:
    uv run python scripts/bulk_ingest_corpus.py \\
        <vault_id> <source_dir> <dest_rel> [--data-dir PATH] [--author NAME]

Example:
    uv run python scripts/bulk_ingest_corpus.py \\
        6d5f211f-a0b3-48c2-a361-fd83816765b8 \\
        corpus/lenin/works/1897 raw/texts/lenin/1897 \\
        --data-dir test_data --author "V.I. Lenin"
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
from pathlib import Path
from uuid import UUID

from great_minds.core.vaults.config import load_config
from great_minds.core.documents.builder import write_document
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.db import session_maker
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DocumentCreate
from great_minds.core.storage import LocalStorage


async def main(
    vault_id: UUID,
    source_dir: Path,
    dest_rel: str,
    data_dir: Path,
    author: str | None,
) -> None:
    storage = LocalStorage(data_dir / "vaults" / str(vault_id))
    config = await load_config(storage)
    source_files = sorted(source_dir.rglob("*.md"))
    total = len(source_files)
    if total == 0:
        print(f"No .md files found under {source_dir}")
        return

    print(f"Ingesting {total} files from {source_dir} → {dest_rel}/")

    ingest_kwargs: dict = {}
    if author:
        ingest_kwargs["author"] = author

    async with session_maker() as session:
        doc_repo = DocumentRepository(session)
        existing_hashes = await doc_repo.get_file_hashes(vault_id)

        batch: list[DocumentCreate] = []
        ingested = 0
        skipped = 0

        for i, fp in enumerate(source_files):
            relative = fp.relative_to(source_dir)
            dest = f"{dest_rel}/{relative}"

            raw_content = fp.read_text(encoding="utf-8")
            content_with_fm = await write_document(
                storage, config, raw_content, "texts", dest=dest, **ingest_kwargs
            )
            file_hash = hashlib.sha256(content_with_fm.encode()).hexdigest()

            if existing_hashes.get(dest) == file_hash:
                skipped += 1
                continue

            await storage.write(dest, content_with_fm)
            ingested += 1

            fm, _ = parse_frontmatter(content_with_fm)
            batch.append(
                DocumentCreate.from_frontmatter(fm, dest, content_with_fm)
            )

            if len(batch) >= 50:
                await doc_repo.batch_upsert(vault_id, batch)
                await session.commit()
                batch.clear()

            if (i + 1) % 25 == 0:
                print(f"  {i + 1}/{total} (ingested={ingested}, skipped={skipped})")

        if batch:
            await doc_repo.batch_upsert(vault_id, batch)
            await session.commit()

    print(f"\nDone: ingested={ingested}, skipped={skipped}, total={total}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("vault_id", type=UUID)
    p.add_argument("source_dir", type=Path)
    p.add_argument("dest_rel", help="Destination path relative to vault root, e.g. raw/texts/lenin/1897")
    p.add_argument("--data-dir", type=Path, default=Path("/data"))
    p.add_argument("--author", default=None)
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    asyncio.run(
        main(
            vault_id=args.vault_id,
            source_dir=args.source_dir,
            dest_rel=args.dest_rel,
            data_dir=args.data_dir,
            author=args.author,
        )
    )
