"""Crawl Liberation News articles to local markdown files.

Uses WordPress sitemaps to discover all article URLs, then fetches each
with crawl4ai. Adapted from ~/Documents/Code/party_scraper which found
that site pagination is broken — sitemaps are the reliable discovery path.

Output:
    corpus/liberation-news/{slug}.md  — one markdown file per article

Usage:
    uv run python scrapers/crawl_liberation_news.py
"""

import asyncio
import logging
import re
from pathlib import Path
from urllib.parse import urlparse

from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, DefaultMarkdownGenerator

log = logging.getLogger(__name__)

CORPUS_DIR = Path("corpus/liberation-news")

SITEMAP_URLS = [
    f"https://liberationnews.org/wp-sitemap-posts-post-{i}.xml" for i in range(1, 8)
]

# WordPress sitemaps render as markdown tables with <url> angle-bracket links
_URL_RE = re.compile(r"<(https://liberationnews\.org/[^>]+)>")
_SKIP_PREFIXES = ("category", "tag", "page", "author", "feed", "wp-")


def url_to_filepath(url: str) -> Path:
    slug = urlparse(url).path.strip("/")
    return CORPUS_DIR / f"{slug}.md"


def is_content_url(url: str) -> bool:
    """Filter to single-level article slugs, skip taxonomy/admin pages."""
    path = urlparse(url).path.strip("/")
    if not path or "/" in path:
        return False
    return not any(path.startswith(p) for p in _SKIP_PREFIXES)


async def fetch_article_urls() -> list[str]:
    """Fetch all article URLs from WordPress sitemaps.

    Uses crawl4ai (real browser) because the site 403s bare HTTP clients.
    crawl4ai renders the XML as a markdown table with <url> angle-bracket
    links, so we regex those out of the markdown.
    """
    urls: list[str] = []

    config = CrawlerRunConfig()
    async with AsyncWebCrawler() as crawler:
        for sitemap_url in SITEMAP_URLS:
            log.info("fetching sitemap: %s", sitemap_url)
            result = await crawler.arun(url=sitemap_url, config=config)
            if not result.success:
                log.warning(
                    "sitemap failed: %s — %s", sitemap_url, result.error_message
                )
                continue

            found = _URL_RE.findall(result.markdown or "")
            urls.extend(found)
            log.info("  %d URLs", len(found))

    seen: set[str] = set()
    unique = [u for u in urls if not (u in seen or seen.add(u))]
    log.info("total: %d unique URLs from sitemaps", len(unique))
    return unique


async def save_result(url: str, markdown: str) -> None:
    if not markdown or not markdown.strip():
        log.warning("skipped empty page: %s", url)
        return

    filepath = url_to_filepath(url)
    filepath.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(filepath.write_text, markdown, encoding="utf-8")
    log.info("saved %s (%d chars)", filepath, len(markdown))


async def crawl(urls: list[str]) -> None:
    """Fetch articles in batches and save as markdown."""
    config = CrawlerRunConfig(
        word_count_threshold=10,
        excluded_tags=["nav", "footer", "header", "aside"],
        markdown_generator=DefaultMarkdownGenerator(
            options={"single_line_break": False},
        ),
    )

    to_fetch = [u for u in urls if not url_to_filepath(u).exists()]
    log.info("%d of %d articles still to fetch", len(to_fetch), len(urls))

    if not to_fetch:
        return

    batch_size = 20
    count = 0

    async with AsyncWebCrawler() as crawler:
        for i in range(0, len(to_fetch), batch_size):
            batch = to_fetch[i : i + batch_size]
            results = await crawler.arun_many(
                urls=batch,
                config=config,
                max_concurrent=5,
            )

            for result in results:
                if result.success:
                    await save_result(result.url, result.markdown)
                    count += 1
                else:
                    log.error("failed %s: %s", result.url, result.error_message)

            log.info(
                "progress: %d / %d fetched",
                min(i + batch_size, len(to_fetch)),
                len(to_fetch),
            )

    log.info("crawl done — saved %d articles to %s/", count, CORPUS_DIR)


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    all_urls = await fetch_article_urls()
    content_urls = [u for u in all_urls if is_content_url(u)]
    log.info("filtered to %d content URLs", len(content_urls))

    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    await crawl(content_urls)


if __name__ == "__main__":
    asyncio.run(main())
