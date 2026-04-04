"""Compiler: process raw texts into the wiki knowledge base.

Library module called by Brain.compile(). Receives a ``brain`` object that
provides storage I/O (``brain.storage``) and prompt loading
(``brain.load_prompt``).

Pipeline architecture:
  Phase 1: Enrich all docs in parallel (Gemma -- cheap extraction)
  Phase 2: Plan all docs in parallel (Gemma -- cheap planning)
  Phase 3: Reconcile plans deterministically (no LLM -- deduplicate slugs)
  Phase 4: Write all articles in parallel (DeepSeek -- expensive reasoning)
  Phase 5: Update _index.md (Gemma -- cheap summarization)
  Phase 6: Backlinks + mark compiled (deterministic)

Two-model strategy:
  - Gemma 4 31B: enrichment, planning, index updates (cheap, fast)
  - DeepSeek V3.2: article writing (expensive, high quality reasoning)

The _index.md file serves dual duty:
  - Navigation for the query layer (agent reads it to decide what to pull)
  - Link vocabulary for the writing step (model reads it to know what to link to)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from io import StringIO
from typing import TYPE_CHECKING

from openai import AsyncOpenAI
from ruamel.yaml import YAML

if TYPE_CHECKING:
    from .brain import Brain

_yaml = YAML()
_yaml.preserve_quotes = True

log = logging.getLogger(__name__)

EXTRACT_MODEL = "google/gemma-4-31b-it"
REASON_MODEL = "deepseek/deepseek-v3.2"
OPENROUTER_BASE = "https://openrouter.ai/api/v1"

MAX_SOURCE_CHARS = 30_000
MAX_CONCURRENT = 5
MAX_RETRIES = 2

_FRONTMATTER_RE = re.compile(r"^---\n(.+?)\n---\n", re.DOTALL)


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def get_client() -> AsyncOpenAI:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Set OPENROUTER_API_KEY environment variable. "
            "Get one at https://openrouter.ai/keys"
        )
    return AsyncOpenAI(base_url=OPENROUTER_BASE, api_key=api_key)


async def api_call(client: AsyncOpenAI, **kwargs):
    """Wrap API calls with retries for transient failures."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return await client.chat.completions.create(**kwargs)
        except Exception as e:
            if attempt == MAX_RETRIES:
                raise
            log.warning("api call failed (attempt %d/%d): %s",
                        attempt, MAX_RETRIES, e)
            await asyncio.sleep(2 ** attempt)


def parse_frontmatter(content: str) -> tuple[dict, str]:
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return {}, content
    fm = _yaml.load(match.group(1))
    body = content[match.end():]
    return dict(fm) if fm else {}, body


def serialize_frontmatter(fm: dict, body: str) -> str:
    buf = StringIO()
    _yaml.dump(fm, buf)
    return f"---\n{buf.getvalue()}---\n{body}"


def truncate_body(body: str, max_chars: int = MAX_SOURCE_CHARS) -> str:
    if len(body) <= max_chars:
        return body
    return body[:max_chars] + "\n\n[...truncated...]"


def strip_json_fencing(raw: str) -> str:
    raw = re.sub(r"^```(?:json)?\n?", "", raw)
    raw = re.sub(r"\n?```$", "", raw)
    return raw


def extract_content(response) -> str | None:
    choice = response.choices[0] if response.choices else None
    if not choice or not choice.message or not choice.message.content:
        return None
    return choice.message.content.strip()


def _stem_from_path(path: str) -> str:
    """Extract the filename stem from a relative path string.

    Example: "raw/texts/lenin/works/1893/market/01.md" -> "01"
    """
    filename = path.rsplit("/", 1)[-1]
    if filename.endswith(".md"):
        return filename[:-3]
    dot = filename.rfind(".")
    return filename[:dot] if dot != -1 else filename


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

# A document after enrichment: (relative path string, frontmatter, body)
type EnrichedDoc = tuple[str, dict, str]

# A planned article with its source document index
type PlannedArticle = dict  # has slug, action, tags, key_points, connections, source_idx


# ---------------------------------------------------------------------------
# Phase 1: Enrich (parallel, cheap)
# ---------------------------------------------------------------------------

async def enrich_one(
    brain: Brain,
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    filepath: str,
) -> EnrichedDoc:
    content = brain.storage.read(filepath)
    fm, body = parse_frontmatter(content)
    title = fm.get("title", _stem_from_path(filepath))

    async with sem:
        prompt = brain.load_prompt("enrich").format(author=fm["author"])
        response = await api_call(
            client,
            model=EXTRACT_MODEL,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": truncate_body(body)},
            ],
            temperature=0.2,
        )

    text = extract_content(response)
    if text:
        raw = strip_json_fencing(text)
        try:
            data = json.loads(raw)
            fm.update({
                "genre": data.get("genre", ""),
                "tradition": data.get("tradition", ""),
                "interlocutors": data.get("interlocutors", []),
                "concepts": data.get("concepts", []),
                "tags": data.get("tags", []),
            })
            log.info("enriched %s -- genre=%s, concepts=%d",
                     title, fm["genre"], len(fm["concepts"]))
        except json.JSONDecodeError:
            log.warning("failed to parse enrichment for %s: %s", title, raw[:200])
    else:
        log.warning("empty enrichment response for %s", title)

    return filepath, fm, body


# ---------------------------------------------------------------------------
# Phase 2: Plan (parallel, cheap)
# ---------------------------------------------------------------------------

def read_index(brain: Brain) -> str:
    if brain.storage.exists("wiki/_index.md"):
        return brain.storage.read("wiki/_index.md")
    return "(no articles yet)"


async def plan_one(
    brain: Brain,
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    doc_idx: int,
    fm: dict,
    body: str,
) -> list[PlannedArticle]:
    """Plan wiki articles for one document. Returns articles tagged with source doc index."""
    prompt = brain.load_prompt("plan").format(
        title=fm.get("title", ""),
        author=fm.get("author", ""),
        date=fm.get("date", ""),
        period=fm.get("period", ""),
        genre=fm.get("genre", ""),
        interlocutors=", ".join(fm.get("interlocutors", [])) or "none",
        concepts=", ".join(fm.get("concepts", [])) or "none",
        wiki_index=read_index(brain),
    )

    async with sem:
        response = await api_call(
            client,
            model=EXTRACT_MODEL,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": truncate_body(body)},
            ],
            temperature=0.3,
        )

    text = extract_content(response)
    if not text:
        log.warning("empty planning response for doc %d", doc_idx)
        return []

    raw = strip_json_fencing(text)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("failed to parse plan for doc %d: %s", doc_idx, raw[:200])
        return []

    articles = data.get("articles", [])
    for a in articles:
        a["source_idx"] = doc_idx
    return articles


# ---------------------------------------------------------------------------
# Phase 3: Reconcile (deterministic, no LLM)
# ---------------------------------------------------------------------------

def normalize_slug(slug: str) -> str:
    """Normalize a slug for deduplication comparison."""
    # Remove common prefixes/suffixes, sort words
    words = slug.lower().replace("-", " ").split()
    # Drop filler words
    filler = {"the", "a", "an", "of", "in", "on", "and", "for", "to", "by"}
    words = [w for w in words if w not in filler]
    return " ".join(sorted(words))


def reconcile_plans(
    all_plans: list[list[PlannedArticle]],
) -> list[PlannedArticle]:
    """Merge plans from all documents, deduplicating slugs.

    When multiple documents plan the same article:
    - First occurrence becomes the primary (action="create")
    - Subsequent occurrences merge their key_points into the primary
    - connections are merged
    """
    flat: list[PlannedArticle] = []
    for plan in all_plans:
        flat.extend(plan)

    # Group by normalized slug
    groups: dict[str, list[PlannedArticle]] = defaultdict(list)
    for article in flat:
        slug = article.get("slug", "")
        if not slug:
            continue
        groups[normalize_slug(slug)].append(article)

    reconciled: list[PlannedArticle] = []
    merge_count = 0

    for _norm, group in groups.items():
        primary = group[0].copy()

        if len(group) > 1:
            merge_count += 1
            slugs_seen = {a["slug"] for a in group}
            if len(slugs_seen) > 1:
                log.info("  merged slugs: %s -> %s", slugs_seen, primary["slug"])

            # Merge key_points from all contributors
            all_points = []
            all_connections = set()
            source_indices = set()
            for a in group:
                all_points.extend(a.get("key_points", []))
                all_connections.update(a.get("connections", []))
                source_indices.add(a.get("source_idx", 0))

            # Deduplicate key_points (crude: keep unique strings)
            seen_points: set[str] = set()
            deduped_points = []
            for p in all_points:
                normalized = p.strip().lower()
                if normalized not in seen_points:
                    seen_points.add(normalized)
                    deduped_points.append(p)

            primary["key_points"] = deduped_points
            primary["connections"] = list(all_connections)
            primary["source_indices"] = sorted(source_indices)
        else:
            primary["source_indices"] = [primary.get("source_idx", 0)]

        reconciled.append(primary)

    if merge_count:
        log.info("reconciled %d duplicate article plans", merge_count)
    log.info("reconciled plan: %d unique articles from %d raw plans",
             len(reconciled), len(flat))

    return reconciled


# ---------------------------------------------------------------------------
# Phase 4: Write (parallel, expensive)
# ---------------------------------------------------------------------------

async def write_one(
    brain: Brain,
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    article: PlannedArticle,
    all_articles: list[PlannedArticle],
    docs: list[EnrichedDoc],
) -> PlannedArticle | None:
    """Write a single wiki article using the primary source document."""
    slug = article.get("slug", "")
    if not slug:
        return None

    source_indices = article.get("source_indices", [0])
    primary_idx = source_indices[0]
    _, fm, body = docs[primary_idx]

    source_paths = [docs[idx][0] for idx in source_indices]
    source_paths_str = "\n".join(f"  - {p}" for p in source_paths)

    article_path = f"wiki/{slug}.md"
    action = article.get("action", "create")

    existing_content_section = ""
    if action == "update" and brain.storage.exists(article_path):
        existing = brain.storage.read(article_path)
        existing_content_section = f"Existing article content:\n\n{existing}"
    elif action == "update":
        action = "create"

    action_instructions = brain.load_prompt("create_article") if action == "create" else brain.load_prompt("update_article")
    key_points = "\n".join(f"- {p}" for p in article.get("key_points", []))
    connections = ", ".join(article.get("connections", [])) or "none"
    tags = ", ".join(article.get("tags", []))

    batch_lines = []
    for a in all_articles:
        s = a.get("slug", "")
        if s:
            pts = "; ".join(a.get("key_points", [])[:2])
            batch_lines.append(f"  wiki/{s}.md -- {pts}")
    batch_articles = "\n".join(batch_lines) if batch_lines else "  (none)"

    prompt = brain.load_prompt("write_article").format(
        slug=slug,
        tags=tags,
        action=action,
        existing_content_section=existing_content_section,
        title=fm.get("title", ""),
        author=fm.get("author", ""),
        date=fm.get("date", ""),
        genre=fm.get("genre", ""),
        concepts=", ".join(fm.get("concepts", [])),
        source_paths=source_paths_str,
        key_points=key_points,
        connections=connections,
        wiki_index=read_index(brain),
        batch_articles=batch_articles,
        source_excerpt=truncate_body(body),
        action_instructions=action_instructions,
    )

    async with sem:
        response = await api_call(
            client,
            model=REASON_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            extra_body={"reasoning": {"effort": "high"}},
        )

    content = extract_content(response)
    if not content:
        log.error("empty response writing %s", slug)
        return None

    brain.storage.write(article_path, content)
    log.info("wrote wiki/%s.md", slug)
    return article


# ---------------------------------------------------------------------------
# Phase 5: Index update (cheap)
# ---------------------------------------------------------------------------

async def update_index(brain: Brain, client: AsyncOpenAI, written_articles: list[PlannedArticle]):
    current_index = read_index(brain)

    summaries = []
    for a in written_articles:
        slug = a.get("slug", "")
        article_path = f"wiki/{slug}.md"
        if brain.storage.exists(article_path):
            content = brain.storage.read(article_path)[:500]
            summaries.append(f"### wiki/{slug}.md\n{content}")

    if not summaries:
        return

    changed_list = "\n".join(
        f"- {a.get('action', 'create')} wiki/{a.get('slug', '')}.md"
        for a in written_articles
    )

    prompt = brain.load_prompt("index_update").format(
        current_index=current_index,
        changed_articles=changed_list,
        article_summaries="\n\n".join(summaries),
    )

    response = await api_call(
        client,
        model=EXTRACT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )

    new_index = extract_content(response)
    if not new_index:
        log.warning("empty response from index update, skipping")
        return

    if new_index.startswith("# Wiki Index"):
        brain.storage.write("wiki/_index.md", new_index + "\n")
        log.info("updated _index.md with %d articles", len(written_articles))
    else:
        log.warning("index update returned unexpected format, skipping")


# ---------------------------------------------------------------------------
# Phase 6: Backlinks + mark compiled (deterministic)
# ---------------------------------------------------------------------------

def insert_backlinks(brain: Brain):
    # Build slug -> display name map from all wiki articles
    slug_map: dict[str, str] = {}
    for path in brain.storage.glob("wiki/*.md"):
        # path is like "wiki/slug.md"; skip internal files
        if path.startswith("wiki/_"):
            continue
        content = brain.storage.read(path)
        heading_match = re.search(r"^#\s+(.+)", content, re.MULTILINE)
        # Extract stem: strip "wiki/" prefix and ".md" suffix
        stem = path[5:-3]  # len("wiki/") == 5, len(".md") == 3
        display = heading_match.group(1).strip() if heading_match else stem
        slug_map[stem] = display

    for path in brain.storage.glob("wiki/*.md"):
        if path.startswith("wiki/_"):
            continue
        content = brain.storage.read(path)
        own_slug = path[5:-3]
        modified = False

        for slug, display in slug_map.items():
            if slug == own_slug:
                continue

            link_target = f"wiki/{slug}.md"
            if link_target in content:
                continue

            for pattern_text in [slug.replace("-", " "), display]:
                bold_pattern = re.compile(
                    r"\*\*" + re.escape(pattern_text) + r"\*\*",
                    re.IGNORECASE,
                )
                if bold_pattern.search(content):
                    content = bold_pattern.sub(
                        f"[{display}]({link_target})", content, count=1
                    )
                    modified = True
                    break

            if modified:
                brain.storage.write(path, content)

    log.info("backlink pass complete")


def mark_compiled(brain: Brain, docs: list[EnrichedDoc]):
    for filepath, fm, body in docs:
        fm["compiled"] = True
        brain.storage.write(filepath, serialize_frontmatter(fm, body))
    log.info("marked %d documents as compiled", len(docs))


def append_changelog(brain: Brain, docs: list[EnrichedDoc], articles: list[PlannedArticle]):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    titles = [d[1].get("title", _stem_from_path(d[0])) for d in docs]

    entry = f"\n## {timestamp}\n\nCompiled {len(docs)} documents:\n"
    for t in titles:
        entry += f"- {t}\n"
    entry += f"\nArticles written: {len(articles)}\n"
    for a in articles:
        entry += f"- {a.get('action', '?')} wiki/{a.get('slug', '')}.md\n"

    changelog_path = "wiki/_changelog.md"
    if brain.storage.exists(changelog_path):
        existing = brain.storage.read(changelog_path)
    else:
        existing = "# Compilation Changelog\n"

    brain.storage.write(changelog_path, existing + entry)


def find_uncompiled(brain: Brain) -> list[str]:
    results = []
    for path in brain.storage.glob("raw/texts/**/*.md"):
        content = brain.storage.read(path)
        fm, _ = parse_frontmatter(content)
        if fm and fm.get("compiled") is False:
            results.append(path)
    return results


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def run(brain: Brain, *, limit: int | None = None):
    client = get_client()
    sem = asyncio.Semaphore(MAX_CONCURRENT)

    uncompiled = find_uncompiled(brain)
    log.info("found %d uncompiled documents", len(uncompiled))

    if limit:
        uncompiled = uncompiled[:limit]
        log.info("limiting to %d documents", limit)

    if not uncompiled:
        log.info("nothing to compile")
        return

    # --- Phase 1: Enrich all docs in parallel (cheap) ---
    log.info("=== phase 1: enriching %d documents ===", len(uncompiled))
    enrichment_results = await asyncio.gather(
        *(enrich_one(brain, client, sem, fp) for fp in uncompiled),
        return_exceptions=True,
    )

    docs: list[EnrichedDoc] = []
    for r in enrichment_results:
        if isinstance(r, Exception):
            log.error("enrichment failed: %s", r)
        else:
            docs.append(r)

    log.info("enriched %d/%d documents", len(docs), len(uncompiled))

    # --- Phase 2: Plan all docs in parallel (cheap) ---
    log.info("=== phase 2: planning %d documents ===", len(docs))
    plan_results = await asyncio.gather(
        *(plan_one(brain, client, sem, i, fm, body) for i, (_, fm, body) in enumerate(docs)),
        return_exceptions=True,
    )

    all_plans: list[list[PlannedArticle]] = []
    for i, r in enumerate(plan_results):
        if isinstance(r, Exception):
            log.error("planning failed for doc %d: %s", i, r)
            all_plans.append([])
        else:
            log.info("doc %d planned %d articles", i, len(r))
            all_plans.append(r)

    # --- Phase 3: Reconcile plans + validate categories (deterministic) ---
    log.info("=== phase 3: reconciling plans ===")
    reconciled = reconcile_plans(all_plans)

    if not reconciled:
        log.info("no articles to write")
        mark_compiled(brain, docs)
        return

    # --- Phase 4: Write all articles in parallel (expensive) ---
    log.info("=== phase 4: writing %d articles ===", len(reconciled))
    write_results = await asyncio.gather(
        *(write_one(brain, client, sem, article, reconciled, docs)
          for article in reconciled),
        return_exceptions=True,
    )

    written: list[PlannedArticle] = []
    for r in write_results:
        if isinstance(r, Exception):
            log.error("write failed: %s", r)
        elif r is not None:
            written.append(r)

    log.info("wrote %d/%d articles", len(written), len(reconciled))

    # --- Phase 5: Update index (cheap) ---
    log.info("=== phase 5: updating index ===")
    await update_index(brain, client, written)

    # --- Phase 6: Backlinks + mark compiled ---
    log.info("=== phase 6: backlinks + finalize ===")
    insert_backlinks(brain)
    mark_compiled(brain, docs)
    append_changelog(brain, docs, written)

    log.info("compilation complete -- %d docs, %d articles", len(docs), len(written))
