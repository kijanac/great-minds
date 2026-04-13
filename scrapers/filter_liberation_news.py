"""Filter Liberation News articles to a core subset by target authors.

Scans local corpus files for author attribution, then copies matching
files to corpus/liberation-news-core/.

Usage:
    uv run python scrapers/filter_liberation_news.py          # dry run
    uv run python scrapers/filter_liberation_news.py --copy    # copy matching files
"""

import argparse
import logging
import os
import re
from pathlib import Path

import boto3
from dotenv import load_dotenv

log = logging.getLogger(__name__)

CORPUS_DIR = Path("corpus/liberation-news")
CORE_DIR = Path("corpus/liberation-news-core")

# Match author display names in markdown links like:
# [Brian Becker](https://liberationnews.org/author/brian_becker/ "Brian Becker")
_AUTHOR_RE = re.compile(r"\[([^\]]+)\]\(https://liberationnews\.org/author/[^)]+\)")

KEEP_AUTHORS = {
    "liberation staff",
    "psl editorial",
    "psl staff",
    "psl webmaster",
    "party for socialism and liberation",
    "mazda majidi",
    "ben becker",
    "brian becker",
    "eugene puryear",
    "walter smolarek",
    "nathalie hrizi",
    "karla reyes",
}

KEEP_SLUGS = {
    "eugene_puryear",
    "brian_becker",
    "ben_becker",
    "mazda_majidi",
    "walter_smolarek",
    "nathalie_hrizi",
}

_SLUG_RE = re.compile(r'liberationnews\.org/author/([^/"]+)/')


def get_author(filepath: Path) -> str | None:
    """Extract the first author display name from a Liberation News article."""
    text = filepath.read_text(encoding="utf-8")

    # Check display name
    match = _AUTHOR_RE.search(text)
    if match:
        return match.group(1).strip()

    return None


def get_author_slug(filepath: Path) -> str | None:
    """Extract the author slug from a Liberation News article."""
    text = filepath.read_text(encoding="utf-8")
    match = _SLUG_RE.search(text)
    if match:
        return match.group(1)
    return None


_PSL_STATEMENT_RE = re.compile(r"psl statement", re.IGNORECASE)


def should_keep(filepath: Path) -> bool:
    """Check if an article should be kept based on author or title."""
    text = filepath.read_text(encoding="utf-8")

    # Keep anything with "PSL statement" in the text (title area)
    # Check first ~2000 chars to avoid matching deep in article body
    if _PSL_STATEMENT_RE.search(text[:2000]):
        return True

    author = get_author(filepath)
    if author and author.lower() in KEEP_AUTHORS:
        return True

    slug = get_author_slug(filepath)
    if slug and slug in KEEP_SLUGS:
        return True

    return False


def get_r2_client():
    load_dotenv(override=True)
    account_id = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--copy", action="store_true", help="Copy matching files to core dir"
    )
    args = parser.parse_args()

    files = sorted(CORPUS_DIR.glob("*.md"))
    log.info("scanning %d files in %s", len(files), CORPUS_DIR)

    keep = []
    skip = []

    for f in files:
        if should_keep(f):
            keep.append(f)
        else:
            skip.append(f)

    log.info("keep: %d, skip: %d", len(keep), len(skip))

    if not args.copy:
        log.info("DRY RUN — pass --copy to copy matching files to %s", CORE_DIR)
        return

    import shutil

    CORE_DIR.mkdir(parents=True, exist_ok=True)

    for f in keep:
        shutil.copy2(f, CORE_DIR / f.name)

    log.info("copied %d files to %s/", len(keep), CORE_DIR)


if __name__ == "__main__":
    main()
