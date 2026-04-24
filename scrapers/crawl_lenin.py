"""Crawl Lenin's Collected Works from marxists.org to local markdown files.

Downloads individual work pages as markdown and builds a volume manifest
mapping each file to its Collected Works volume number.

Output:
    corpus/lenin/works/...    — markdown files mirroring the site's URL structure
    corpus/lenin/volumes.json — {relative_path: volume_number} manifest

Usage:
    uv run python scrapers/crawl_lenin.py
"""

import asyncio
import json
import logging
import re
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, DefaultMarkdownGenerator
from crawl4ai.deep_crawling import BFSDeepCrawlStrategy
from crawl4ai.deep_crawling.filters import FilterChain, URLPatternFilter

log = logging.getLogger(__name__)

BASE_URL = "https://www.marxists.org/archive/lenin/works/cw/index.htm"
VOLUME_BASE = "https://www.marxists.org/archive/lenin/works/cw/"
CORPUS_DIR = Path("corpus/lenin")

ALLOWED_PATTERNS = [
    "*marxists.org/archive/lenin/works/cw/*.htm*",
    "*marxists.org/archive/lenin/works/18*.htm*",
    "*marxists.org/archive/lenin/works/19*.htm*",
]

_HTM_EXT = re.compile(r"\.html?$")
_WORK_LINK = re.compile(r'href="(\.\./[^"]+\.htm[l]?)"', re.IGNORECASE)
_created_dirs: set[Path] = set()


def url_to_filepath(url: str) -> Path:
    path = urlparse(url).path
    path = path.removeprefix("/archive/lenin/")
    path = _HTM_EXT.sub("", path)
    return CORPUS_DIR / f"{path}.md"


def filepath_to_relative(filepath: Path) -> str:
    return str(filepath.relative_to(CORPUS_DIR))


async def save_result(url: str, markdown: str) -> None:
    if not markdown or not markdown.strip():
        log.warning("skipped empty page: %s", url)
        return

    if urlparse(url).path.rstrip("/").endswith(("/index.htm", "/index.html")):
        log.info("skipped index page: %s", url)
        return

    filepath = url_to_filepath(url)

    if filepath.parent not in _created_dirs:
        filepath.parent.mkdir(parents=True, exist_ok=True)
        _created_dirs.add(filepath.parent)

    await asyncio.to_thread(filepath.write_text, markdown, encoding="utf-8")
    log.info("saved %s (%d chars)", filepath, len(markdown))


async def build_volume_map() -> dict[str, int]:
    """Fetch all 45 volume TOC pages and map each work URL to its volume number."""
    volume_map: dict[str, int] = {}

    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        for vol in range(1, 46):
            url = f"{VOLUME_BASE}volume{vol:02d}.htm"
            log.info("fetching volume %d TOC: %s", vol, url)

            resp = await client.get(url)
            resp.raise_for_status()

            for match in _WORK_LINK.finditer(resp.text):
                absolute = urljoin(url, match.group(1))
                if not urlparse(absolute).path.startswith("/archive/lenin/works/"):
                    continue
                filepath = url_to_filepath(absolute)
                relative = filepath_to_relative(filepath)
                volume_map[relative] = vol

    log.info("volume map built — %d entries across 45 volumes", len(volume_map))
    return volume_map


async def crawl() -> None:
    """BFS-crawl marxists.org and save each page as markdown."""
    config = CrawlerRunConfig(
        deep_crawl_strategy=BFSDeepCrawlStrategy(
            max_depth=3,
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

    volume_map = await build_volume_map()

    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    manifest = CORPUS_DIR / "volumes.json"
    manifest.write_text(json.dumps(volume_map, indent=2), encoding="utf-8")
    log.info("wrote %s (%d entries)", manifest, len(volume_map))

    await crawl()


if __name__ == "__main__":
    asyncio.run(main())
