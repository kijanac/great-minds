"""Shared skip filters for marxists.org-style crawls.

These sites publish content pages alongside navigation/TOC/placeholder
pages under the same URL patterns the BFS crawl follows. Filtering
them out pre-save avoids polluting the corpus with non-content
markdown.

Call from each crawler's save_result() after the empty-body check::

    if should_skip(url, markdown):
        log.info("skipped %s", url)
        return
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

_TOC_FILENAMES = frozenset(
    [
        "index.htm",
        "index.html",
        "contents.htm",
        "contents.html",
    ]
)
_VOLUME_TOC_RE = re.compile(r"^volume\d+\.html?$")

# The Lenin CW preface pages that weren't digitized use a literal
# bracketed placeholder in place of the preface body. Content check
# is conservative enough not to false-positive on real prose.
_PLACEHOLDER_MARKERS = (
    "[INSERT HERE]",
)


def should_skip(url: str, markdown: str) -> str | None:
    """Return a skip reason (for logging) if the page is non-content, else None."""
    path = urlparse(url).path.rstrip("/")
    filename = path.rsplit("/", 1)[-1]

    if filename in _TOC_FILENAMES:
        return "toc"
    if _VOLUME_TOC_RE.match(filename):
        return "volume_toc"
    if any(m in markdown for m in _PLACEHOLDER_MARKERS):
        return "placeholder"
    return None
