"""Crawl Lenin's Collected Works from marxists.org and ingest into the knowledge base.

Two-phase process:
1. Crawl marxists.org → corpus/lenin/ (raw markdown, no frontmatter)
2. Ingest corpus/lenin/ → raw/texts/lenin/ (with frontmatter from config)

Usage:
    uv run python ingest/crawl_lenin.py                # crawl + ingest
    uv run python ingest/crawl_lenin.py --ingest-only  # skip crawl, just re-ingest
"""

import argparse
import asyncio
import logging
import re
from pathlib import Path
from urllib.parse import urlparse

from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
from crawl4ai.deep_crawling import BFSDeepCrawlStrategy
from crawl4ai.deep_crawling.filters import FilterChain, URLPatternFilter

from tools.ingest import ingest_document, load_fields

log = logging.getLogger(__name__)

BASE_URL = "https://www.marxists.org/archive/lenin/works/cw/index.htm"
CORPUS_DIR = Path("corpus/lenin")
DEST_DIR = Path("raw/texts/lenin")

ALLOWED_PATTERNS = [
    "*marxists.org/archive/lenin/works/cw/*.htm*",
    "*marxists.org/archive/lenin/works/18*.htm*",
    "*marxists.org/archive/lenin/works/19*.htm*",
]

_HTM_EXT = re.compile(r"\.html?$")
_YEAR_RE = re.compile(r"/works/(1[89]\d{2})/")
_created_dirs: set[Path] = set()


def url_to_filepath(url: str) -> Path:
    path = urlparse(url).path
    path = path.removeprefix("/archive/lenin/")
    path = _HTM_EXT.sub("", path)
    return CORPUS_DIR / f"{path}.md"


def url_to_source(url: str) -> str:
    return url


def extract_year_from_path(filepath: Path) -> int | None:
    match = _YEAR_RE.search(str(filepath))
    return int(match.group(1)) if match else None


def is_volume_index(filepath: Path) -> bool:
    return "works/cw/" in str(filepath)


async def save_result(url: str, markdown: str) -> None:
    if not markdown or not markdown.strip():
        log.warning("skipped empty page: %s", url)
        return

    filepath = url_to_filepath(url)

    if filepath.parent not in _created_dirs:
        filepath.parent.mkdir(parents=True, exist_ok=True)
        _created_dirs.add(filepath.parent)

    await asyncio.to_thread(filepath.write_text, markdown, encoding="utf-8")
    log.info("saved %s (%d chars)", filepath, len(markdown))


async def crawl():
    """Phase 1: Crawl marxists.org to corpus/."""
    config = CrawlerRunConfig(
        deep_crawl_strategy=BFSDeepCrawlStrategy(
            max_depth=3,
            include_external=False,
            filter_chain=FilterChain([
                URLPatternFilter(patterns=ALLOWED_PATTERNS),
            ]),
        ),
        stream=True,
        verbose=True,
    )

    count = 0
    async with AsyncWebCrawler() as crawler:
        async for result in await crawler.arun(url=BASE_URL, config=config):
            if result.success:
                await save_result(result.url, result.markdown)
                count += 1
            else:
                log.error("failed %s: %s", result.url, result.error_message)

    log.info("crawl done — saved %d pages to %s/", count, CORPUS_DIR)


def filepath_to_source_url(filepath: Path) -> str:
    """Reconstruct the marxists.org URL from the corpus file path."""
    relative = filepath.relative_to(CORPUS_DIR)
    path_str = str(relative).removesuffix(".md") + ".htm"
    return f"https://www.marxists.org/archive/lenin/{path_str}"


def ingest():
    """Phase 2: Add frontmatter and copy to raw/texts/."""
    processed = 0
    skipped = 0

    for filepath in sorted(CORPUS_DIR.rglob("*.md")):
        if is_volume_index(filepath):
            skipped += 1
            continue

        content = filepath.read_text(encoding="utf-8")
        year = extract_year_from_path(filepath)
        source_url = filepath_to_source_url(filepath)

        relative = filepath.relative_to(CORPUS_DIR)
        dest = DEST_DIR / relative

        ingest_document(
            content,
            "texts",
            author="V.I. Lenin",
            date=year,
            source=source_url,
            dest=dest,
        )
        processed += 1

    log.info("ingest done — %d files to %s/, %d index pages skipped",
             processed, DEST_DIR, skipped)


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(description="Crawl and ingest Lenin's Collected Works")
    parser.add_argument("--ingest-only", action="store_true",
                        help="Skip crawl, just re-ingest from corpus/")
    args = parser.parse_args()

    if not args.ingest_only:
        await crawl()

    ingest()


if __name__ == "__main__":
    asyncio.run(main())
