"""Fetch 100 CNN articles as raw text using RSS feeds + crawl4ai."""

import asyncio
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, DefaultMarkdownGenerator
from crawl4ai.content_filter_strategy import PruningContentFilter

# CNN RSS feeds to source article URLs from
RSS_FEEDS = [
    "http://rss.cnn.com/rss/cnn_topstories.rss",
    "http://rss.cnn.com/rss/cnn_latest.rss",
    "http://rss.cnn.com/rss/cnn_us.rss",
    "http://rss.cnn.com/rss/cnn_world.rss",
    "http://rss.cnn.com/rss/cnn_tech.rss",
    "http://rss.cnn.com/rss/cnn_health.rss",
    "http://rss.cnn.com/rss/cnn_showbiz.rss",
    "http://rss.cnn.com/rss/cnn_travel.rss",
    "http://rss.cnn.com/rss/money_latest.rss",
]

TARGET = 100
CONCURRENCY = 5
OUTPUT_DIR = Path("cnn_articles")


def slug_from_url(url: str) -> str:
    """Make a safe filename from a URL."""
    path = url.split("cnn.com", 1)[-1].strip("/")
    slug = re.sub(r"[^\w-]", "_", path)[:120]
    return slug or "article"


async def collect_urls(limit: int = TARGET) -> list[str]:
    """Pull article URLs from CNN RSS feeds, deduplicated."""
    seen: set[str] = set()
    urls: list[str] = []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for feed_url in RSS_FEEDS:
            if len(urls) >= limit:
                break
            try:
                resp = await client.get(feed_url)
                resp.raise_for_status()
                root = ET.fromstring(resp.text)
                for item in root.iter("item"):
                    link = item.findtext("link") or ""
                    link = link.strip()
                    if link and link not in seen and "cnn.com" in link:
                        seen.add(link)
                        urls.append(link)
                        if len(urls) >= limit:
                            break
            except Exception as exc:
                print(f"  [warn] {feed_url}: {exc}", file=sys.stderr)

    return urls[:limit]


async def crawl_articles(urls: list[str], out_dir: Path) -> None:
    """Crawl each URL and save clean text to out_dir."""
    out_dir.mkdir(parents=True, exist_ok=True)

    config = CrawlerRunConfig(
        markdown_generator=DefaultMarkdownGenerator(
            content_filter=PruningContentFilter(threshold=0.45)
        ),
        word_count_threshold=50,
        excluded_tags=["nav", "footer", "header", "aside", "script", "style"],
        exclude_external_links=True,
        verbose=False,
    )

    sem = asyncio.Semaphore(CONCURRENCY)
    saved = 0
    failed = 0

    async def fetch_one(crawler: AsyncWebCrawler, url: str, idx: int) -> None:
        nonlocal saved, failed
        async with sem:
            try:
                result = await crawler.arun(url=url, config=config)
                text = (
                    result.markdown.fit_markdown
                    if result.markdown and result.markdown.fit_markdown
                    else (result.markdown.raw_markdown if result.markdown else "")
                )
                if not text or len(text.split()) < 50:
                    print(f"  [{idx:03d}] skip (too short): {url}")
                    failed += 1
                    return
                filename = f"{idx:03d}_{slug_from_url(url)}.txt"
                (out_dir / filename).write_text(text, encoding="utf-8")
                saved += 1
                print(f"  [{idx:03d}] saved {len(text):,} chars → {filename}")
            except Exception as exc:
                failed += 1
                print(f"  [{idx:03d}] error: {url} — {exc}", file=sys.stderr)

    async with AsyncWebCrawler() as crawler:
        tasks = [fetch_one(crawler, url, i + 1) for i, url in enumerate(urls)]
        await asyncio.gather(*tasks)

    print(f"\nDone: {saved} saved, {failed} failed → {out_dir.resolve()}")


async def main() -> None:
    print(f"Collecting up to {TARGET} CNN article URLs from RSS feeds…")
    urls = await collect_urls(TARGET)
    print(f"Found {len(urls)} URLs\n")

    if not urls:
        print("No URLs found — CNN RSS may be unavailable.", file=sys.stderr)
        sys.exit(1)

    print(f"Crawling articles (concurrency={CONCURRENCY})…")
    await crawl_articles(urls, OUTPUT_DIR)


if __name__ == "__main__":
    asyncio.run(main())
