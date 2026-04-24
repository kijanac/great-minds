"""Crawl Marx & Engels works from marxists.org to local markdown files.

The Marx-Engels Collected Works (MECW) volumes were removed from marxists.org
in 2014 due to a copyright claim by Lawrence & Wishart. This scraper targets
the works that remain available via the date-based index.

Output:
    corpus/marx/works/...  — markdown files mirroring the site's URL structure

Usage:
    uv run python scrapers/crawl_marx.py
"""

import asyncio
import logging
import re
from pathlib import Path
from urllib.parse import urlparse

from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, DefaultMarkdownGenerator
from crawl4ai.deep_crawling import BFSDeepCrawlStrategy
from crawl4ai.deep_crawling.filters import FilterChain, URLPatternFilter

from scrapers._filters import should_skip

log = logging.getLogger(__name__)

BASE_URL = "https://www.marxists.org/archive/marx/works/date/index.htm"
CORPUS_DIR = Path("corpus/marx")

ALLOWED_PATTERNS = [
    "*marxists.org/archive/marx/works/18*.htm*",
    "*marxists.org/archive/marx/works/date/*.htm*",
]

_HTM_EXT = re.compile(r"\.html?$")
_created_dirs: set[Path] = set()


def url_to_filepath(url: str) -> Path:
    path = urlparse(url).path
    path = path.removeprefix("/archive/marx/")
    path = _HTM_EXT.sub("", path)
    return CORPUS_DIR / f"{path}.md"


async def save_result(url: str, markdown: str) -> None:
    if not markdown or not markdown.strip():
        log.warning("skipped empty page: %s", url)
        return

    skip = should_skip(url, markdown)
    if skip is not None:
        log.info("skipped %s: %s", skip, url)
        return

    filepath = url_to_filepath(url)

    if filepath.parent not in _created_dirs:
        filepath.parent.mkdir(parents=True, exist_ok=True)
        _created_dirs.add(filepath.parent)

    await asyncio.to_thread(filepath.write_text, markdown, encoding="utf-8")
    log.info("saved %s (%d chars)", filepath, len(markdown))


async def crawl() -> None:
    """BFS-crawl Marx & Engels works and save each page as markdown."""
    config = CrawlerRunConfig(
        deep_crawl_strategy=BFSDeepCrawlStrategy(
            max_depth=4,
            include_external=False,
            filter_chain=FilterChain([URLPatternFilter(patterns=ALLOWED_PATTERNS)]),
        ),
        markdown_generator=DefaultMarkdownGenerator(
            options={"single_line_break": False},
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


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    await crawl()


if __name__ == "__main__":
    asyncio.run(main())
