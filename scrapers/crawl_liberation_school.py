"""Crawl Liberation School articles (pre-2009) to local markdown files.

Fetches article URLs from the WordPress sitemap, filters to articles
with date-prefixed slugs from 2008 or earlier, and downloads each.

Output:
    corpus/liberation-school/{slug}.md

Usage:
    uv run python scrapers/crawl_liberation_school.py
"""

import asyncio
import logging
import re
from pathlib import Path
from urllib.parse import urlparse

from crawl4ai import AsyncWebCrawler, CrawlerRunConfig

log = logging.getLogger(__name__)

CORPUS_DIR = Path("corpus/liberation-school")
SITEMAP_URL = "https://liberationschool.org/post-sitemap.xml"

_URL_RE = re.compile(r"<(https://liberationschool\.org/[^>]+)>")
_PRE_2009 = re.compile(r"^0[0-8]-\d{2}-\d{2}-")


def url_to_filepath(url: str) -> Path:
    slug = urlparse(url).path.strip("/")
    return CORPUS_DIR / f"{slug}.md"


async def fetch_article_urls() -> list[str]:
    config = CrawlerRunConfig()
    async with AsyncWebCrawler() as crawler:
        result = await crawler.arun(url=SITEMAP_URL, config=config)
        if not result.success:
            log.error("sitemap failed: %s", result.error_message)
            return []

        all_urls = _URL_RE.findall(result.markdown or "")
        pre_2009 = [u for u in all_urls if _PRE_2009.match(urlparse(u).path.strip("/"))]
        log.info("sitemap: %d total, %d pre-2009", len(all_urls), len(pre_2009))
        return pre_2009


async def save_result(url: str, markdown: str) -> None:
    if not markdown or not markdown.strip():
        log.warning("skipped empty page: %s", url)
        return

    filepath = url_to_filepath(url)
    filepath.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(filepath.write_text, markdown, encoding="utf-8")
    log.info("saved %s (%d chars)", filepath.name, len(markdown))


async def crawl(urls: list[str]) -> None:
    config = CrawlerRunConfig(
        word_count_threshold=10,
        excluded_tags=["nav", "footer", "header", "aside"],
    )

    to_fetch = [u for u in urls if not url_to_filepath(u).exists()]
    log.info("%d of %d articles still to fetch", len(to_fetch), len(urls))

    if not to_fetch:
        return

    count = 0
    async with AsyncWebCrawler() as crawler:
        results = await crawler.arun_many(
            urls=to_fetch,
            config=config,
            max_concurrent=5,
        )
        for result in results:
            if result.success:
                await save_result(result.url, result.markdown)
                count += 1
            else:
                log.error("failed %s: %s", result.url, result.error_message)

    log.info("crawl done — saved %d articles to %s/", count, CORPUS_DIR)


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    urls = await fetch_article_urls()
    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    await crawl(urls)


if __name__ == "__main__":
    asyncio.run(main())
