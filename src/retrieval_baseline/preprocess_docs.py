"""
Pre-convert rich documents (PDF, DOCX, PPTX, …) to plain Markdown so that
subsequent `llama_index index` runs skip the slow markitdown step entirely.

Usage:
    uv run python -m retrieval_baseline.preprocess_docs [OPTIONS]

The cache directory defaults to <docs-dir>/.markitdown_cache.  Re-running is
safe: files whose source mtime is older than the cached version are skipped.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from tqdm import tqdm

# Re-use constants and helpers from the indexer to stay in sync.
from retrieval_baseline.llama_index import (
    DEFAULT_DOCS_DIR,
    MARKITDOWN_EXTENSIONS,
    _cache_path_for,
)

DEFAULT_CACHE_DIR = os.path.join(DEFAULT_DOCS_DIR, ".markitdown_cache")
EXCLUDE_SUFFIXES = {".mp3", ".mp4", ".wav", ".m4a", ".ogg", ".flac", ".zip"}


def preprocess(docs_dir: Path, cache_dir: Path, force: bool = False) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)

    candidates = sorted(
        f for f in docs_dir.rglob("*")
        if f.is_file()
        and not any(part.startswith(".") for part in f.relative_to(docs_dir).parts)
        and f.suffix.lower() in MARKITDOWN_EXTENSIONS
        and f.suffix.lower() not in EXCLUDE_SUFFIXES
    )

    if not candidates:
        print("No rich documents found.")
        return

    fresh, stale = [], []
    for f in candidates:
        cp = _cache_path_for(f, cache_dir)
        if not force and cp.exists() and cp.stat().st_mtime >= f.stat().st_mtime:
            fresh.append(f)
        else:
            stale.append(f)

    if fresh:
        print(f"{len(fresh)} file(s) already cached, skipping.")
    if not stale:
        print("Nothing to do.")
        return

    print(f"Converting {len(stale)} file(s) → {cache_dir}")

    from markitdown import MarkItDown
    converter = MarkItDown()

    errors = 0
    for f in tqdm(stale, unit="file"):
        t0 = time.perf_counter()
        try:
            result = converter.convert(str(f))
            text = result.text_content or ""
        except Exception as exc:
            tqdm.write(f"  [error] {f.name}: {exc}", file=sys.stderr)
            errors += 1
            continue

        elapsed = time.perf_counter() - t0
        if elapsed > 5.0:
            tqdm.write(f"  [slow] {f.name} took {elapsed:.1f}s")

        _cache_path_for(f, cache_dir).write_text(text, encoding="utf-8")

    print(f"Done. {len(stale) - errors} written, {errors} error(s).")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="preprocess_docs",
        description="Pre-convert rich documents to cached Markdown for faster indexing.",
    )
    parser.add_argument(
        "--docs-dir",
        default=os.environ.get("LLAMA_DOCS_DIR", DEFAULT_DOCS_DIR),
        help=f"Directory containing source documents (default: {DEFAULT_DOCS_DIR})",
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help="Where to write cached .md files (default: <docs-dir>/.markitdown_cache)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-convert even files that are already cached",
    )
    args = parser.parse_args()

    docs_dir = Path(args.docs_dir)
    cache_dir = Path(args.cache_dir) if args.cache_dir else docs_dir / ".markitdown_cache"

    if not docs_dir.exists():
        print(f"[error] docs_dir does not exist: {docs_dir}", file=sys.stderr)
        sys.exit(1)

    preprocess(docs_dir, cache_dir, force=args.force)


if __name__ == "__main__":
    main()
