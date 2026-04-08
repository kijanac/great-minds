"""Lint the knowledge base for structural and content issues.

Programmatic checks (fast, free, always run):
  - Dead links: wiki links pointing to articles that don't exist
  - Broken source citations: footnotes pointing to raw files that don't exist
  - Orphan articles: wiki articles that no other article links to
  - Uncompiled documents: raw docs that haven't been processed yet
  - Uncited sources: raw docs that no wiki article references
  - Missing index entries: wiki articles not listed in _index.md

LLM checks (slower, costs money, opt-in with deep=True):
  - Inconsistent concept naming across articles
  - Contradictions between articles
  - Coverage gaps: concepts/debates mentioned but without their own article
"""

import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field

from ruamel.yaml import YAML

from great_minds.core.brain import wiki_path
from great_minds.core.llm import EXTRACT_MODEL, get_sync_client
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)

_FRONTMATTER_RE = re.compile(r"^---\n(.+?)\n---\n", re.DOTALL)
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
_FOOTNOTE_RE = re.compile(r"\[\^(\d+)\]:\s*\[([^\]]*)\]\(([^)]+)\)")


# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------


def collect_wiki_articles(storage: Storage) -> dict[str, str]:
    """Return {filename: content} for all wiki articles.

    Keys are relative to wiki/ (e.g. "imperialism.md"), not the full
    storage path.
    """
    articles = {}
    for path in storage.glob("wiki/*.md"):
        if path.startswith("wiki/_"):
            continue
        filename = path.removeprefix("wiki/")
        articles[filename] = storage.read(path)
    return articles


def collect_raw_docs(storage: Storage) -> dict[str, dict]:
    """Return {path: frontmatter} for all raw docs."""
    yaml = YAML()
    docs = {}
    for path in storage.glob("raw/texts/**/*.md"):
        content = storage.read(path)
        if content is None:
            continue
        match = _FRONTMATTER_RE.match(content)
        if match:
            fm = yaml.load(match.group(1))
            docs[path] = dict(fm) if fm else {}
    return docs


# ---------------------------------------------------------------------------
# Programmatic checks
# ---------------------------------------------------------------------------


def check_dead_links(storage: Storage, articles: dict[str, str]) -> list[str]:
    """Find markdown links to files that don't exist. All paths are root-relative."""
    issues = []
    for rel_path, content in articles.items():
        for match in _MD_LINK_RE.finditer(content):
            target = match.group(2)
            # Skip external URLs
            if target.startswith("http://") or target.startswith("https://"):
                continue
            # Skip anchor-only links
            if target.startswith("#"):
                continue
            # All internal links should be root-relative paths
            if not storage.exists(target):
                issues.append(f"  {rel_path}: dead link [{match.group(1)}]({target})")
    return issues


def check_broken_citations(storage: Storage, articles: dict[str, str]) -> list[str]:
    """Find footnote citations pointing to raw files that don't exist."""
    issues = []
    for rel_path, content in articles.items():
        for match in _FOOTNOTE_RE.finditer(content):
            source_path = match.group(3)
            # All paths are root-relative
            if not storage.exists(source_path):
                issues.append(
                    f"  {rel_path}: footnote [^{match.group(1)}] → {source_path} (not found)"
                )
    return issues


def check_orphan_articles(articles: dict[str, str]) -> list[str]:
    """Find wiki articles that no other article links to."""
    # Count incoming links for each article
    incoming: dict[str, int] = defaultdict(int)
    for rel_path in articles:
        incoming[rel_path] = 0

    # articles dict is keyed by path relative to wiki/ (e.g. "concepts/foo.md")
    # links in articles are root-relative (e.g. "wiki/concepts/foo.md")
    # so strip "wiki/" prefix to match against the articles dict
    for rel_path, content in articles.items():
        for match in _MD_LINK_RE.finditer(content):
            target = match.group(2)
            if not target.startswith("wiki/"):
                continue
            wiki_rel = target.removeprefix("wiki/")
            if wiki_rel in incoming:
                incoming[wiki_rel] += 1

    orphans = [path for path, count in sorted(incoming.items()) if count == 0]
    return [f"  {p} (0 incoming links)" for p in orphans]


def check_uncompiled(raw_docs: dict[str, dict]) -> list[str]:
    """Find raw documents that haven't been compiled."""
    uncompiled = [path for path, fm in raw_docs.items() if fm.get("compiled") is False]
    if len(uncompiled) > 20:
        return [f"  {len(uncompiled)} uncompiled documents (showing first 20)"] + [
            f"  {p}" for p in uncompiled[:20]
        ]
    return [f"  {p}" for p in uncompiled]


def check_uncited_sources(
    articles: dict[str, str], raw_docs: dict[str, dict]
) -> list[str]:
    """Find compiled raw docs that no wiki article references in its Sources section."""
    # Collect all source paths mentioned in wiki articles
    cited_paths: set[str] = set()
    for content in articles.values():
        # Look in ## Sources sections and footnotes
        for match in _MD_LINK_RE.finditer(content):
            target = match.group(2)
            if "raw/" in target and target.endswith(".md"):
                cited_paths.add(target)

    # Find compiled docs that aren't cited
    uncited = []
    for path, fm in raw_docs.items():
        if fm.get("compiled") is True and path not in cited_paths:
            uncited.append(path)

    if len(uncited) > 20:
        return [
            f"  {len(uncited)} compiled but uncited documents (showing first 20)"
        ] + [f"  {p}" for p in uncited[:20]]
    return [f"  {p}" for p in uncited]


def check_missing_index_entries(
    storage: Storage, articles: dict[str, str]
) -> list[str]:
    """Find wiki articles not listed in _index.md."""
    index_content = storage.read("wiki/_index.md", strict=False)
    if index_content is None:
        return ["  _index.md does not exist"]
    issues = []
    for rel_path in articles:
        # Index uses root-relative paths like wiki/category/slug.md
        root_path = f"wiki/{rel_path}"
        if root_path not in index_content:
            issues.append(f"  {rel_path} not in _index.md")
    return issues


def check_tag_health(raw_docs: dict[str, dict]) -> list[str]:
    """Report on tag vocabulary: singletons, near-duplicates."""
    tag_counts: dict[str, int] = defaultdict(int)
    for fm in raw_docs.values():
        for tag in fm.get("tags", []):
            tag_counts[tag] += 1

    if not tag_counts:
        return []

    issues = []

    # Singletons
    singletons = [t for t, c in tag_counts.items() if c == 1]
    if singletons:
        preview = singletons[:10]
        issues.append(
            f"  {len(singletons)} singleton tags (used once): {', '.join(preview)}"
        )

    # Near-duplicates (simple: check if removing hyphens creates collisions)
    normalized: dict[str, list[str]] = defaultdict(list)
    for tag in tag_counts:
        norm = tag.replace("-", "").replace("_", "").lower()
        normalized[norm].append(tag)

    for norm, variants in normalized.items():
        if len(variants) > 1:
            issues.append(f"  possible duplicates: {', '.join(variants)}")

    return issues


# ---------------------------------------------------------------------------
# LLM checks (opt-in)
# ---------------------------------------------------------------------------


def check_concept_consistency(articles: dict[str, str]) -> list[str]:
    """Use LLM to find inconsistent concept naming across articles."""
    client = get_sync_client()

    # Build a condensed view: first 300 chars of each article
    summaries = []
    for rel_path, content in articles.items():
        summaries.append(f"### {rel_path}\n{content[:300]}")

    prompt = """\
You are a wiki consistency checker. Given summaries of all articles in a political theory wiki, \
identify:

1. **Inconsistent naming**: The same concept appearing under different names in different articles \
(e.g. "dictatorship of the proletariat" vs "proletarian dictatorship", or "Narodniks" vs "Populists")
2. **Contradictions**: Articles that describe the same position or event differently
3. **Coverage gaps**: Concepts, thinkers, or debates that are mentioned in articles but don't have \
their own dedicated article yet — these are candidates for new articles

For each issue, specify which articles are involved and what the inconsistency is.

Return a JSON object with:
- "naming_issues": list of {"term_variants": [...], "articles": [...], "suggestion": "canonical name"}
- "contradictions": list of {"description": "...", "articles": [...]}
- "gaps": list of {"topic": "...", "mentioned_in": [...], "suggested_category": "concepts|thinkers|traditions|debates"}

Respond with ONLY the JSON object."""

    all_summaries = "\n\n".join(summaries)

    response = client.chat.completions.create(
        model=EXTRACT_MODEL,
        messages=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": all_summaries},
        ],
        temperature=0.2,
        extra_body={"provider": {"allow_fallbacks": True}},
    )

    content = response.choices[0].message.content.strip()
    content = re.sub(r"^```(?:json)?\n?", "", content)
    content = re.sub(r"\n?```$", "", content)

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return [f"  Failed to parse LLM response: {content[:200]}"]

    issues = []

    for item in data.get("naming_issues", []):
        variants = ", ".join(item.get("term_variants", []))
        suggestion = item.get("suggestion", "?")
        arts = ", ".join(item.get("articles", []))
        issues.append(f"  NAMING: [{variants}] → suggest '{suggestion}' (in: {arts})")

    for item in data.get("contradictions", []):
        desc = item.get("description", "?")
        arts = ", ".join(item.get("articles", []))
        issues.append(f"  CONTRADICTION: {desc} (in: {arts})")

    for item in data.get("gaps", []):
        topic = item.get("topic", "?")
        cat = item.get("suggested_category", "?")
        mentioned = ", ".join(item.get("mentioned_in", []))
        issues.append(f"  GAP: '{topic}' ({cat}) — mentioned in: {mentioned}")

    return issues


# ---------------------------------------------------------------------------
# Targeted lint (for post-compilation checks across brains)
# ---------------------------------------------------------------------------


@dataclass
class BrokenLink:
    brain_label: str
    article: str
    target_slug: str


@dataclass
class TargetedLintResult:
    broken_links: list[BrokenLink] = field(default_factory=list)


def lint_links_to_slugs(
    brains: list[tuple["Storage", str]],
    changed_slugs: list[str],
    source_storage: "Storage",
) -> TargetedLintResult:
    """Check if any brain's articles link to changed slugs that no longer exist.

    Args:
        brains: list of (storage, label) pairs to check
        changed_slugs: slugs that were created/updated/deleted in the source brain
        source_storage: the storage where the slugs changed (to verify they still exist)
    """
    result = TargetedLintResult()

    for slug in changed_slugs:
        target_path = wiki_path(slug)
        slug_exists = source_storage.exists(target_path)

        for storage, label in brains:
            articles = collect_wiki_articles(storage)
            for rel_path, content in articles.items():
                for match in _MD_LINK_RE.finditer(content):
                    link_target = match.group(2)
                    if link_target == target_path and not slug_exists:
                        result.broken_links.append(
                            BrokenLink(
                                brain_label=label,
                                article=rel_path,
                                target_slug=slug,
                            )
                        )

    return result


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_lint(storage: Storage, *, deep: bool = False) -> int:
    """Run all lint checks and return total issue count."""
    log.info("Collecting wiki articles...")
    articles = collect_wiki_articles(storage)
    log.info("Collecting raw documents...")
    raw_docs = collect_raw_docs(storage)
    log.info("Found %d wiki articles, %d raw documents\n", len(articles), len(raw_docs))

    total_issues = 0

    checks: list[tuple[str, object, tuple]] = [
        ("Dead links", check_dead_links, (storage, articles)),
        ("Broken source citations", check_broken_citations, (storage, articles)),
        ("Orphan articles (no incoming links)", check_orphan_articles, (articles,)),
        ("Uncompiled documents", check_uncompiled, (raw_docs,)),
        (
            "Uncited sources (compiled but unreferenced)",
            check_uncited_sources,
            (articles, raw_docs),
        ),
        ("Missing index entries", check_missing_index_entries, (storage, articles)),
        ("Tag health", check_tag_health, (raw_docs,)),
    ]

    for name, check_fn, check_args in checks:
        issues = check_fn(*check_args)
        if issues:
            log.info("--- %s (%d) ---", name, len(issues))
            for issue in issues:
                log.info(issue)
            log.info("")
            total_issues += len(issues)
        else:
            log.info("--- %s: clean ---", name)

    if deep:
        log.info("\n--- LLM consistency check (this may take a minute) ---")
        issues = check_concept_consistency(articles)
        if issues:
            for issue in issues:
                log.info(issue)
            total_issues += len(issues)
        else:
            log.info("  No issues found")

    log.info("\n=== %d total issues ===", total_issues)
    return total_issues
