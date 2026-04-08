"""Lint the knowledge base for structural and content issues.

Two modes:
  - detect only (fix=False): scan for issues, return structured results
  - detect + fix (fix=True): scan, then auto-fix what's resolvable

Programmatic checks (fast, free, always run):
  - Dead links: wiki links pointing to articles that don't exist
  - Broken source citations: footnotes pointing to raw files that don't exist
  - Orphan articles: wiki articles that no other article links to
  - Uncompiled documents: raw docs that haven't been processed yet
  - Uncited sources: raw docs that no wiki article references
  - Missing index entries: wiki articles not listed in _index.md
  - Tag health: singleton tags and near-duplicates

Auto-fixes (LLM-assisted, opt-in with fix=True):
  - Dead links: LLM picks the best match from existing articles
  - Broken citations: LLM picks the best match from existing raw docs
  - Missing index entries: LLM writes entries slotted into existing categories
  - Tag normalization: mechanical canonical-form selection
"""

import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Literal

from great_minds.core.brain import load_config, read_index, wiki_path
from great_minds.core.brains._utils import (
    FOOTNOTE_RE,
    MD_LINK_RE,
    api_call,
    extract_content,
    parse_frontmatter,
    parse_json_response,
    serialize_frontmatter,
)
from great_minds.core.llm import EXTRACT_MODEL, get_async_client
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass
class DeadLink:
    article: str  # wiki-relative path, e.g. "imperialism.md"
    link_text: str
    target: str  # the broken path, e.g. "wiki/missing-slug.md"


@dataclass
class BrokenCitation:
    article: str
    footnote_id: str
    label: str
    target: str  # the broken raw path


@dataclass
class OrphanArticle:
    article: str
    incoming_count: int  # always 0


@dataclass
class UncompiledDoc:
    path: str


@dataclass
class UncitedSource:
    path: str


@dataclass
class MissingIndexEntry:
    article: str  # wiki-relative path
    title: str  # extracted H1 or slug
    summary: str  # first paragraph


@dataclass
class TagIssue:
    kind: Literal["duplicate", "low_use"]
    tags: list[str]
    canonical: str | None = None  # for duplicates, the most common form


@dataclass
class ResearchSuggestion:
    """A tag that's popular enough to warrant its own wiki article."""

    tag: str
    usage_count: int
    mentioned_in: list[str]  # sample of raw doc paths


@dataclass
class Fix:
    file: str
    description: str


@dataclass
class LintCounts:
    dead_links: int = 0
    broken_citations: int = 0
    orphans: int = 0
    uncompiled: int = 0
    uncited: int = 0
    missing_index: int = 0
    tag_issues: int = 0


@dataclass
class LintResult:
    fixes_applied: list[Fix] = field(default_factory=list)
    remaining_issues: int = 0
    counts: LintCounts = field(default_factory=LintCounts)
    research_suggestions: list[ResearchSuggestion] = field(default_factory=list)


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
    docs = {}
    for path in storage.glob("raw/texts/**/*.md"):
        content = storage.read(path)
        if content is None:
            continue
        fm, _ = parse_frontmatter(content)
        if fm:
            docs[path] = fm
    return docs


def _extract_title_and_summary(content: str) -> tuple[str, str]:
    """Extract H1 title and first paragraph from article content."""
    _, body = parse_frontmatter(content)
    title = ""
    h1 = re.search(r"^#\s+(.+)", body, re.MULTILINE)
    if h1:
        title = h1.group(1).strip()

    lines = body.split("\n")
    para_lines = []
    in_para = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if in_para:
                break
            continue
        if stripped.startswith("#"):
            if in_para:
                break
            continue
        in_para = True
        para_lines.append(stripped)

    summary = " ".join(para_lines)[:200]
    return title, summary


# ---------------------------------------------------------------------------
# Detection (pure, no LLM, no side effects)
# ---------------------------------------------------------------------------


def detect_dead_links(
    storage: Storage, articles: dict[str, str], known_paths: set[str]
) -> list[DeadLink]:
    issues = []
    for rel_path, content in articles.items():
        for match in MD_LINK_RE.finditer(content):
            target = match.group(2)
            if target.startswith(("http://", "https://", "#")):
                continue
            # Fast set check first, fall back to storage for paths outside known globs
            if target not in known_paths and not storage.exists(target):
                issues.append(
                    DeadLink(article=rel_path, link_text=match.group(1), target=target)
                )
    return issues


def detect_broken_citations(
    storage: Storage, articles: dict[str, str], known_paths: set[str]
) -> list[BrokenCitation]:
    issues = []
    for rel_path, content in articles.items():
        for match in FOOTNOTE_RE.finditer(content):
            source_path = match.group(3)
            if source_path not in known_paths and not storage.exists(source_path):
                issues.append(
                    BrokenCitation(
                        article=rel_path,
                        footnote_id=match.group(1),
                        label=match.group(2),
                        target=source_path,
                    )
                )
    return issues


def detect_orphan_articles(articles: dict[str, str]) -> list[OrphanArticle]:
    incoming: dict[str, int] = defaultdict(int)
    for rel_path in articles:
        incoming[rel_path] = 0

    for content in articles.values():
        for match in MD_LINK_RE.finditer(content):
            target = match.group(2)
            if not target.startswith("wiki/"):
                continue
            wiki_rel = target.removeprefix("wiki/")
            if wiki_rel in incoming:
                incoming[wiki_rel] += 1

    return [
        OrphanArticle(article=path, incoming_count=0)
        for path, count in sorted(incoming.items())
        if count == 0
    ]


def detect_uncompiled(raw_docs: dict[str, dict]) -> list[UncompiledDoc]:
    return [
        UncompiledDoc(path=path)
        for path, fm in raw_docs.items()
        if fm.get("compiled") is False
    ]


def detect_uncited_sources(
    articles: dict[str, str], raw_docs: dict[str, dict]
) -> list[UncitedSource]:
    cited_paths: set[str] = set()
    for content in articles.values():
        for match in MD_LINK_RE.finditer(content):
            target = match.group(2)
            if "raw/" in target and target.endswith(".md"):
                cited_paths.add(target)

    return [
        UncitedSource(path=path)
        for path, fm in raw_docs.items()
        if fm.get("compiled") is True and path not in cited_paths
    ]


def detect_missing_index_entries(
    storage: Storage,
    articles: dict[str, str],
    article_meta: dict[str, tuple[str, str]],
) -> list[MissingIndexEntry]:
    index_content = read_index(storage)
    if not index_content:
        return []

    missing = []
    for rel_path in articles:
        root_path = f"wiki/{rel_path}"
        if root_path not in index_content:
            title, summary = article_meta[rel_path]
            missing.append(
                MissingIndexEntry(
                    article=rel_path,
                    title=title or rel_path.removesuffix(".md"),
                    summary=summary,
                )
            )
    return missing


def count_tags(
    raw_docs: dict[str, dict],
) -> tuple[dict[str, int], dict[str, list[str]]]:
    """Count tag usage and track which docs use each tag. Single pass."""
    tag_counts: dict[str, int] = defaultdict(int)
    tag_docs: dict[str, list[str]] = defaultdict(list)
    for path, fm in raw_docs.items():
        for tag in fm.get("tags", []):
            tag_counts[tag] += 1
            if len(tag_docs[tag]) < 5:
                tag_docs[tag].append(path)
    return dict(tag_counts), dict(tag_docs)


def detect_tag_issues(
    tag_counts: dict[str, int], *, min_uses: int = 2
) -> list[TagIssue]:
    if not tag_counts:
        return []

    issues: list[TagIssue] = []

    # Near-duplicates (normalize by removing hyphens/underscores, lowercasing)
    normalized: dict[str, list[str]] = defaultdict(list)
    for tag in tag_counts:
        norm = tag.replace("-", "").replace("_", "").lower()
        normalized[norm].append(tag)

    for variants in normalized.values():
        if len(variants) > 1:
            canonical = max(variants, key=lambda t: tag_counts[t])
            issues.append(
                TagIssue(kind="duplicate", tags=variants, canonical=canonical)
            )

    # Low-use tags (below min_uses threshold, not already in a duplicate group)
    duplicate_tags = {t for issue in issues for t in issue.tags}
    low_use = [
        t for t, c in tag_counts.items() if c < min_uses and t not in duplicate_tags
    ]
    if low_use:
        issues.append(TagIssue(kind="low_use", tags=low_use))

    return issues


def detect_promotion_candidates(
    tag_counts: dict[str, int],
    tag_docs: dict[str, list[str]],
    wiki_articles: dict[str, str],
    *,
    min_uses: int = 5,
) -> list[ResearchSuggestion]:
    """Find tags used frequently that don't have a corresponding wiki article."""
    existing_slugs = {rel_path.removesuffix(".md") for rel_path in wiki_articles}

    suggestions = []
    for tag, count in sorted(tag_counts.items(), key=lambda x: -x[1]):
        if count < min_uses:
            continue
        if tag in existing_slugs:
            continue
        suggestions.append(
            ResearchSuggestion(
                tag=tag,
                usage_count=count,
                mentioned_in=tag_docs.get(tag, []),
            )
        )

    return suggestions


# ---------------------------------------------------------------------------
# Auto-fixes
# ---------------------------------------------------------------------------


async def fix_dead_links(
    storage: Storage,
    dead_links: list[DeadLink],
    article_meta: dict[str, tuple[str, str]],
) -> list[Fix]:
    """Use LLM to resolve dead links to existing articles (single batched call)."""
    if not dead_links:
        return []

    existing_articles = [
        {"path": f"wiki/{rel_path}", "title": title or rel_path.removesuffix(".md")}
        for rel_path, (title, _) in article_meta.items()
    ]

    dead_links_desc = [
        {"article": d.article, "link_text": d.link_text, "target": d.target}
        for d in dead_links
    ]

    prompt = f"""\
A wiki contains links pointing to files that don't exist. For each dead link, \
pick the best matching existing article or null if no good match.

Dead links:
{json.dumps(dead_links_desc, indent=2)}

Existing wiki articles:
{json.dumps(existing_articles, indent=2)}

Return ONLY a JSON array with one entry per dead link, in the same order:
[{{"match": "wiki/slug.md"}}, {{"match": null}}, ...]"""

    client = get_async_client()
    response = await api_call(
        client,
        model=EXTRACT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
    )

    text = extract_content(response)
    if not text:
        return []

    data = parse_json_response(text)
    if not isinstance(data, list) or len(data) != len(dead_links):
        log.warning(
            "dead link fix: expected %d matches, got %s", len(dead_links), type(data)
        )
        return []

    fixes: list[Fix] = []
    for dead, resolution in zip(dead_links, data):
        new_target = resolution.get("match") if isinstance(resolution, dict) else None
        if not new_target or not storage.exists(new_target):
            continue

        article_path = f"wiki/{dead.article}"
        content = storage.read(article_path, strict=False)
        if content is None:
            continue
        old_link = f"[{dead.link_text}]({dead.target})"
        new_link = f"[{dead.link_text}]({new_target})"
        updated = content.replace(old_link, new_link, 1)

        if updated != content:
            storage.write(article_path, updated)
            fixes.append(
                Fix(
                    file=dead.article,
                    description=f"relinked [{dead.link_text}] → {new_target}",
                )
            )

    return fixes


def _narrow_raw_candidates(broken_path: str, all_paths: list[str]) -> list[str]:
    """Pre-filter raw paths to plausible candidates for a broken citation.

    Narrows by: same filename, same parent directory, or shared path segments.
    Returns at most 50 candidates to keep LLM prompts bounded.
    """
    broken_filename = broken_path.rsplit("/", 1)[-1]
    broken_parts = set(broken_path.replace(".md", "").split("/"))

    scored = []
    for path in all_paths:
        filename = path.rsplit("/", 1)[-1]
        parts = set(path.replace(".md", "").split("/"))
        overlap = len(broken_parts & parts)
        same_name = filename == broken_filename
        scored.append((same_name, overlap, path))

    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [path for _, _, path in scored[:50]]


async def fix_broken_citations(
    storage: Storage,
    broken: list[BrokenCitation],
) -> list[Fix]:
    """Use LLM to resolve broken footnote citations (single batched call)."""
    if not broken:
        return []

    all_raw_paths = storage.glob("raw/texts/**/*.md")

    # Pre-filter candidates per citation to keep prompt bounded
    per_citation_candidates = {
        c.target: _narrow_raw_candidates(c.target, all_raw_paths) for c in broken
    }
    # Deduplicate into a single candidate list for the prompt
    candidate_set: set[str] = set()
    for candidates in per_citation_candidates.values():
        candidate_set.update(candidates)
    narrowed_paths = sorted(candidate_set)

    citations_desc = [
        {
            "article": c.article,
            "footnote_id": c.footnote_id,
            "label": c.label,
            "target": c.target,
        }
        for c in broken
    ]

    prompt = f"""\
A wiki has footnote citations pointing to raw source files that don't exist. \
For each broken citation, pick the best matching existing raw document or null.

Broken citations:
{json.dumps(citations_desc, indent=2)}

Candidate raw document paths (pre-filtered by similarity):
{json.dumps(narrowed_paths, indent=2)}

Return ONLY a JSON array with one entry per citation, in the same order:
[{{"match": "raw/texts/..."}}, {{"match": null}}, ...]"""

    client = get_async_client()
    response = await api_call(
        client,
        model=EXTRACT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
    )

    text = extract_content(response)
    if not text:
        return []

    data = parse_json_response(text)
    if not isinstance(data, list) or len(data) != len(broken):
        log.warning(
            "citation fix: expected %d matches, got %s", len(broken), type(data)
        )
        return []

    fixes: list[Fix] = []
    for cite, resolution in zip(broken, data):
        new_target = resolution.get("match") if isinstance(resolution, dict) else None
        if not new_target or not storage.exists(new_target):
            continue

        article_path = f"wiki/{cite.article}"
        content = storage.read(article_path, strict=False)
        if content is None:
            continue
        old_ref = f"[{cite.label}]({cite.target})"
        new_ref = f"[{cite.label}]({new_target})"
        updated = content.replace(old_ref, new_ref, 1)

        if updated != content:
            storage.write(article_path, updated)
            fixes.append(
                Fix(
                    file=cite.article,
                    description=f"relinked footnote [^{cite.footnote_id}] → {new_target}",
                )
            )

    return fixes


async def fix_missing_index_entries(
    storage: Storage,
    missing: list[MissingIndexEntry],
) -> list[Fix]:
    """Use LLM to write index entries and slot them into the right categories."""
    if not missing:
        return []

    current_index = read_index(storage)
    if not current_index:
        return []

    articles_desc = "\n".join(
        f'- wiki/{m.article}: title="{m.title}", summary="{m.summary}"' for m in missing
    )

    prompt = f"""\
You are maintaining the master index for a research knowledge base wiki.

Current index:
{current_index}

The following wiki articles exist but are missing from the index:
{articles_desc}

Add entries for ONLY the missing articles, slotting each into the most \
appropriate existing category (## heading). If no category fits well, add it \
to the most general one.

Each entry format: - [Article Title](wiki/slug.md): 1-2 sentence description

Return the complete updated index. Start with "# Wiki Index". Keep all \
existing entries exactly as they are."""

    client = get_async_client()
    response = await api_call(
        client,
        model=EXTRACT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )

    text = extract_content(response)
    if not text or not text.startswith("# Wiki Index"):
        log.warning("index fix returned unexpected format, skipping")
        return []

    storage.write("wiki/_index.md", text + "\n")

    return [Fix(file="_index.md", description=f"added {len(missing)} missing entries")]


def fix_tags(
    storage: Storage,
    raw_docs: dict[str, dict],
    tag_issues: list[TagIssue],
) -> list[Fix]:
    """Normalize duplicate tags and prune low-use tags. No LLM needed."""
    rename_map: dict[str, str] = {}
    prune_set: set[str] = set()

    for issue in tag_issues:
        if issue.kind == "duplicate" and issue.canonical:
            for tag in issue.tags:
                if tag != issue.canonical:
                    rename_map[tag] = issue.canonical
        elif issue.kind == "low_use":
            prune_set.update(issue.tags)

    if not rename_map and not prune_set:
        return []

    fixes: list[Fix] = []
    for path, fm in raw_docs.items():
        tags = fm.get("tags", [])
        if not tags:
            continue

        new_tags = [rename_map.get(t, t) for t in tags if t not in prune_set]
        if new_tags == tags:
            continue

        content = storage.read(path)
        if content is None:
            continue

        fm_parsed, body = parse_frontmatter(content)
        fm_parsed["tags"] = new_tags
        storage.write(path, serialize_frontmatter(fm_parsed, body))

        changes = []
        renamed = [f"{old}→{new}" for old, new in rename_map.items() if old in tags]
        pruned = [t for t in tags if t in prune_set]
        if renamed:
            changes.append(f"renamed: {', '.join(renamed)}")
        if pruned:
            changes.append(f"pruned: {', '.join(pruned)}")
        fixes.append(Fix(file=path, description=f"tags: {'; '.join(changes)}"))

    return fixes


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
    """Check if any brain's articles link to changed slugs that no longer exist."""
    result = TargetedLintResult()
    missing_targets = {
        wiki_path(slug)
        for slug in changed_slugs
        if not source_storage.exists(wiki_path(slug))
    }
    if not missing_targets:
        return result

    for storage, label in brains:
        articles = collect_wiki_articles(storage)
        for rel_path, content in articles.items():
            for match in MD_LINK_RE.finditer(content):
                link_target = match.group(2)
                if link_target in missing_targets:
                    slug = link_target.removeprefix("wiki/").removesuffix(".md")
                    result.broken_links.append(
                        BrokenLink(
                            brain_label=label, article=rel_path, target_slug=slug
                        )
                    )

    return result


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def _load_tag_thresholds(storage: Storage) -> dict:
    """Load tag governance thresholds from brain config."""
    config = load_config(storage)
    fields = config.get("fields", {})
    return {
        "min_uses_to_keep": fields.get("tags", {}).get("min_uses_to_keep", 2),
        "promotion_threshold": fields.get("concepts", {}).get("min_uses_to_promote", 5),
    }


async def run_lint(
    storage: Storage, *, deep: bool = False, fix: bool = False
) -> LintResult:
    """Run all lint checks and optionally auto-fix resolvable issues."""
    log.info("lint: collecting wiki articles")
    articles = collect_wiki_articles(storage)
    log.info("lint: collecting raw documents")
    raw_docs = collect_raw_docs(storage)
    log.info(
        "lint: found %d wiki articles, %d raw documents", len(articles), len(raw_docs)
    )

    # Load governance thresholds from brain config
    thresholds = _load_tag_thresholds(storage)
    min_uses = thresholds["min_uses_to_keep"]
    promotion_threshold = thresholds["promotion_threshold"]

    # Precompute title/summary for all articles (used by detection + fixes)
    article_meta = {
        rel_path: _extract_title_and_summary(content)
        for rel_path, content in articles.items()
    }

    # Build a set of all known paths for fast membership checks
    known_paths = set(storage.glob("wiki/*.md"))
    known_paths.update(storage.glob("raw/texts/**/*.md"))

    # --- Detection ---
    dead_links = detect_dead_links(storage, articles, known_paths)
    broken_citations = detect_broken_citations(storage, articles, known_paths)
    orphans = detect_orphan_articles(articles)
    uncompiled = detect_uncompiled(raw_docs)
    uncited = detect_uncited_sources(articles, raw_docs)
    missing_index = detect_missing_index_entries(storage, articles, article_meta)
    tag_counts, tag_docs = count_tags(raw_docs)
    tag_issues = detect_tag_issues(tag_counts, min_uses=min_uses)

    suggestions = detect_promotion_candidates(
        tag_counts, tag_docs, articles, min_uses=promotion_threshold
    )
    if suggestions:
        log.info(
            "lint: %d research suggestions (tags that could become articles)",
            len(suggestions),
        )
        for s in suggestions:
            log.info("lint: suggestion — '%s' (used %d times)", s.tag, s.usage_count)

    counts = LintCounts(
        dead_links=len(dead_links),
        broken_citations=len(broken_citations),
        orphans=len(orphans),
        uncompiled=len(uncompiled),
        uncited=len(uncited),
        missing_index=len(missing_index),
        tag_issues=len(tag_issues),
    )
    total_detected = sum(
        [
            counts.dead_links,
            counts.broken_citations,
            counts.orphans,
            counts.uncompiled,
            counts.uncited,
            counts.missing_index,
            counts.tag_issues,
        ]
    )

    log.info(
        "lint: detected %d issues (dead_links=%d broken_citations=%d orphans=%d "
        "uncompiled=%d uncited=%d missing_index=%d tag_issues=%d)",
        total_detected,
        counts.dead_links,
        counts.broken_citations,
        counts.orphans,
        counts.uncompiled,
        counts.uncited,
        counts.missing_index,
        counts.tag_issues,
    )

    if not fix:
        return LintResult(
            remaining_issues=total_detected,
            counts=counts,
            research_suggestions=suggestions,
        )

    # --- Auto-fix ---
    log.info("lint: applying auto-fixes")

    # Tag fixes are synchronous (no LLM): merge duplicates + prune low-use
    tag_fixes = fix_tags(storage, raw_docs, tag_issues)

    # LLM-assisted fixes (each is a single batched call)
    link_fixes = await fix_dead_links(storage, dead_links, article_meta)
    citation_fixes = await fix_broken_citations(storage, broken_citations)
    index_fixes = await fix_missing_index_entries(storage, missing_index)

    all_fixes = tag_fixes + link_fixes + citation_fixes + index_fixes

    for f in all_fixes:
        log.info("lint: fixed %s — %s", f.file, f.description)

    # Remaining = issues that weren't auto-fixable
    links_fixed = len(link_fixes)
    citations_fixed = len(citation_fixes)
    index_fixed = len(missing_index) if index_fixes else 0
    tags_fixed = (
        sum(1 for i in tag_issues if i.kind in ("duplicate", "low_use"))
        if tag_fixes
        else 0
    )
    remaining = (
        total_detected - links_fixed - citations_fixed - index_fixed - tags_fixed
    )

    log.info("lint: %d fixes applied, %d issues remaining", len(all_fixes), remaining)

    return LintResult(
        fixes_applied=all_fixes,
        remaining_issues=max(0, remaining),
        counts=counts,
        research_suggestions=suggestions,
    )
