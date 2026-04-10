"""Compiler: process raw texts into the wiki knowledge base.

Library module called by Brain.compile(). Receives a Storage instance
for I/O and a load_prompt callable for prompt resolution.

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

import asyncio
import json
import logging
import re
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from uuid import UUID

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain import wiki_path, wiki_slug
from great_minds.core.search import rebuild_index
from great_minds.core.brain_utils import (
    api_call,
    extract_content,
    parse_frontmatter,
    serialize_frontmatter,
    strip_json_fencing,
)
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DOC_KIND_WIKI, DocumentCreate
from great_minds.core.llm import EXTRACT_MODEL, REASON_MODEL, get_async_client
from great_minds.core.storage import Storage

log = logging.getLogger(__name__)

MAX_SOURCE_CHARS = 30_000
MAX_CONCURRENT = 5


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def truncate_body(body: str, max_chars: int = MAX_SOURCE_CHARS) -> str:
    if len(body) <= max_chars:
        return body
    return body[:max_chars] + "\n\n[...truncated...]"


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


class ArticleAction(StrEnum):
    CREATE = "create"
    UPDATE = "update"


class PlannedArticle(BaseModel):
    """Validated shape for a planned wiki article from the LLM planning phase."""

    slug: str
    action: ArticleAction
    tags: list[str] = []
    key_points: list[str] = []
    connections: list[str] = []
    source_idx: int = 0
    source_indices: list[int] = []


# ---------------------------------------------------------------------------
# Phase 1: Enrich (parallel, cheap)
# ---------------------------------------------------------------------------


async def enrich_one(
    storage: Storage,
    load_prompt: Callable[[str], str],
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    filepath: str,
) -> EnrichedDoc:
    content = storage.read(filepath)
    if content is None:
        raise FileNotFoundError(filepath)
    fm, body = parse_frontmatter(content)
    title = fm.get("title", _stem_from_path(filepath))

    async with sem:
        prompt = load_prompt("enrich").format(author=fm["author"])
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
            fm.update(
                {
                    "genre": data.get("genre", ""),
                    "tradition": data.get("tradition", ""),
                    "interlocutors": data.get("interlocutors", []),
                    "concepts": data.get("concepts", []),
                    "tags": data.get("tags", []),
                }
            )
            log.info(
                "enriched %s -- genre=%s, concepts=%d",
                title,
                fm["genre"],
                len(fm["concepts"]),
            )
        except json.JSONDecodeError:
            log.warning("failed to parse enrichment for %s: %s", title, raw[:200])
    else:
        log.warning("empty enrichment response for %s", title)

    return filepath, fm, body


# ---------------------------------------------------------------------------
# Phase 2: Plan (parallel, cheap)
# ---------------------------------------------------------------------------


def read_index(storage: Storage) -> str:
    content = storage.read("wiki/_index.md", strict=False)
    if content is None:
        content = "(no articles yet)"
    return content


async def plan_one(
    storage: Storage,
    load_prompt: Callable[[str], str],
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    doc_idx: int,
    fm: dict,
    body: str,
    wiki_index: str,
) -> list[PlannedArticle]:
    """Plan wiki articles for one document. Returns articles tagged with source doc index."""
    prompt = load_prompt("plan").format(
        title=fm.get("title", ""),
        author=fm.get("author", ""),
        date=fm.get("date", ""),
        period=fm.get("period", ""),
        genre=fm.get("genre", ""),
        interlocutors=", ".join(fm.get("interlocutors", [])) or "none",
        concepts=", ".join(fm.get("concepts", [])) or "none",
        wiki_index=wiki_index,
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

    articles: list[PlannedArticle] = []
    for raw_article in data.get("articles", []):
        raw_article["source_idx"] = doc_idx
        try:
            articles.append(PlannedArticle.model_validate(raw_article))
        except ValidationError as e:
            log.warning(
                "invalid article plan in doc %d: %s — %s", doc_idx, raw_article, e
            )
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
        groups[normalize_slug(article.slug)].append(article)

    reconciled: list[PlannedArticle] = []
    merge_count = 0

    for _norm, group in groups.items():
        primary = group[0].model_copy()

        if len(group) > 1:
            merge_count += 1
            slugs_seen = {a.slug for a in group}
            if len(slugs_seen) > 1:
                log.info("  merged slugs: %s -> %s", slugs_seen, primary.slug)

            # Merge key_points from all contributors
            all_points: list[str] = []
            all_connections: set[str] = set()
            source_indices: set[int] = set()
            for a in group:
                all_points.extend(a.key_points)
                all_connections.update(a.connections)
                source_indices.add(a.source_idx)

            # Deduplicate key_points (crude: keep unique strings)
            seen_points: set[str] = set()
            deduped_points: list[str] = []
            for p in all_points:
                normalized = p.strip().lower()
                if normalized not in seen_points:
                    seen_points.add(normalized)
                    deduped_points.append(p)

            primary.key_points = deduped_points
            primary.connections = list(all_connections)
            primary.source_indices = sorted(source_indices)
        else:
            primary.source_indices = [primary.source_idx]

        reconciled.append(primary)

    if merge_count:
        log.info("reconciled %d duplicate article plans", merge_count)
    log.info(
        "reconciled plan: %d unique articles from %d raw plans",
        len(reconciled),
        len(flat),
    )

    return reconciled


# ---------------------------------------------------------------------------
# Phase 4: Write (parallel, expensive)
# ---------------------------------------------------------------------------


async def write_one(
    storage: Storage,
    load_prompt: Callable[[str], str],
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    article: PlannedArticle,
    all_articles: list[PlannedArticle],
    docs: list[EnrichedDoc],
    wiki_index: str,
) -> PlannedArticle | None:
    """Write a single wiki article using the primary source document."""
    primary_idx = (
        article.source_indices[0] if article.source_indices else article.source_idx
    )
    _, fm, body = docs[primary_idx]

    source_paths = [docs[idx][0] for idx in article.source_indices]
    source_paths_str = "\n".join(f"  - {p}" for p in source_paths)

    article_path = wiki_path(article.slug)
    action = article.action

    existing_content_section = ""
    if action == ArticleAction.UPDATE:
        existing = storage.read(article_path, strict=False)
        if existing is not None:
            existing_content_section = f"Existing article content:\n\n{existing}"
        else:
            action = ArticleAction.CREATE

    action_instructions = (
        load_prompt("create_article")
        if action == ArticleAction.CREATE
        else load_prompt("update_article")
    )
    key_points = "\n".join(f"- {p}" for p in article.key_points)
    connections = ", ".join(article.connections) or "none"
    tags = ", ".join(article.tags)

    batch_lines = []
    for a in all_articles:
        pts = "; ".join(a.key_points[:2])
        batch_lines.append(f"  wiki/{a.slug}.md -- {pts}")
    batch_articles = "\n".join(batch_lines) if batch_lines else "  (none)"

    prompt = load_prompt("write_article").format(
        slug=article.slug,
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
        wiki_index=wiki_index,
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
        log.error("empty response writing %s", article.slug)
        return None

    storage.write(article_path, content)
    log.info("wrote wiki/%s.md", article.slug)
    return article


# ---------------------------------------------------------------------------
# Phase 5: Index update (cheap)
# ---------------------------------------------------------------------------


async def update_index(
    storage: Storage,
    load_prompt: Callable[[str], str],
    client: AsyncOpenAI,
    written_articles: list[PlannedArticle],
):
    current_index = read_index(storage)

    summaries = []
    for a in written_articles:
        article_path = wiki_path(a.slug)
        content = storage.read(article_path, strict=False)
        if content is not None:
            summaries.append(f"### {article_path}\n{content[:500]}")

    if not summaries:
        return

    changed_list = "\n".join(
        f"- {a.action} {wiki_path(a.slug)}" for a in written_articles
    )

    prompt = load_prompt("index_update").format(
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
        storage.write("wiki/_index.md", new_index + "\n")
        log.info("updated _index.md with %d articles", len(written_articles))
    else:
        log.warning("index update returned unexpected format, skipping")


# ---------------------------------------------------------------------------
# Phase 6: Backlinks + mark compiled (deterministic)
# ---------------------------------------------------------------------------


def insert_backlinks(storage: Storage):
    # Single pass: read all wiki articles, build slug map and content cache
    slug_map: dict[str, str] = {}
    articles: dict[str, str] = {}  # path -> content
    for path in storage.glob("wiki/*.md"):
        if path.startswith("wiki/_"):
            continue
        content = storage.read(path)
        if content is None:
            continue
        stem = wiki_slug(path)
        heading_match = re.search(r"^#\s+(.+)", content, re.MULTILINE)
        slug_map[stem] = heading_match.group(1).strip() if heading_match else stem
        articles[path] = content

    for path, content in articles.items():
        own_slug = wiki_slug(path)
        modified = False

        for slug, display in slug_map.items():
            if slug == own_slug:
                continue

            link_target = wiki_path(slug)
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
            storage.write(path, content)

    log.info("backlink pass complete")


def mark_compiled(storage: Storage, docs: list[EnrichedDoc]):
    for filepath, fm, body in docs:
        fm["compiled"] = True
        storage.write(filepath, serialize_frontmatter(fm, body))
    log.info("marked %d documents as compiled", len(docs))


def append_changelog(
    storage: Storage, docs: list[EnrichedDoc], articles: list[PlannedArticle]
):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    titles = [d[1].get("title", _stem_from_path(d[0])) for d in docs]

    entry = f"\n## {timestamp}\n\nCompiled {len(docs)} documents:\n"
    for t in titles:
        entry += f"- {t}\n"
    entry += f"\nArticles written: {len(articles)}\n"
    for a in articles:
        entry += f"- {a.action} wiki/{a.slug}.md\n"

    changelog_path = "wiki/_changelog.md"
    existing = storage.read(changelog_path, strict=False)
    if existing is None:
        existing = "# Compilation Changelog\n"

    storage.write(changelog_path, existing + entry)


def find_uncompiled(storage: Storage) -> list[str]:
    results = []
    for path in storage.glob("raw/texts/**/*.md"):
        content = storage.read(path)
        if content is None:
            continue
        fm, _ = parse_frontmatter(content)
        if fm and fm.get("compiled") is False:
            results.append(path)
    return results


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


@dataclass
class CompilationResult:
    """Structured output from a compilation run."""

    docs_compiled: int = 0
    articles_written: list[dict] = field(default_factory=list)
    # Each entry: {"slug": str, "action": "create"|"update"}
    chunks_indexed: int = 0


async def run(
    storage: Storage,
    load_prompt: Callable[[str], str],
    *,
    limit: int | None = None,
    db_session: "AsyncSession | None" = None,
    brain_id: "UUID | None" = None,
) -> CompilationResult:
    client = get_async_client()
    sem = asyncio.Semaphore(MAX_CONCURRENT)

    uncompiled = find_uncompiled(storage)
    log.info("found %d uncompiled documents", len(uncompiled))

    if limit:
        uncompiled = uncompiled[:limit]
        log.info("limiting to %d documents", limit)

    if not uncompiled:
        log.info("nothing to compile")
        return CompilationResult()

    # --- Phase 1: Enrich all docs in parallel (cheap) ---
    log.info("=== phase 1: enriching %d documents ===", len(uncompiled))
    enrichment_results = await asyncio.gather(
        *(enrich_one(storage, load_prompt, client, sem, fp) for fp in uncompiled),
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
    wiki_index = read_index(storage)
    plan_results = await asyncio.gather(
        *(
            plan_one(storage, load_prompt, client, sem, i, fm, body, wiki_index)
            for i, (_, fm, body) in enumerate(docs)
        ),
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
        mark_compiled(storage, docs)
        return CompilationResult(docs_compiled=len(docs))

    # --- Phase 4: Write all articles in parallel (expensive) ---
    log.info("=== phase 4: writing %d articles ===", len(reconciled))
    wiki_index = read_index(storage)
    write_results = await asyncio.gather(
        *(
            write_one(
                storage, load_prompt, client, sem, article, reconciled, docs, wiki_index
            )
            for article in reconciled
        ),
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
    await update_index(storage, load_prompt, client, written)

    # --- Phase 6: Backlinks + mark compiled ---
    log.info("=== phase 6: backlinks + finalize ===")
    insert_backlinks(storage)
    mark_compiled(storage, docs)
    append_changelog(storage, docs, written)

    # --- Phase 7: Rebuild search index ---
    chunks_indexed = 0
    if db_session is not None and brain_id is not None:
        log.info("=== phase 7: rebuilding search index ===")
        chunks_indexed = await rebuild_index(db_session, brain_id, storage)

    # --- Phase 8: Sync documents table (enriched raw docs + wiki articles) ---
    if db_session is not None and brain_id is not None:
        log.info("=== phase 8: syncing documents table ===")
        doc_repo = DocumentRepository(db_session)

        for filepath, fm, body in docs:
            content = serialize_frontmatter(fm, body)
            doc = DocumentCreate.model_validate(
                {**fm, "file_path": filepath, "content": content, "compiled": True}
            )
            await doc_repo.upsert(brain_id, doc)

        for article in written:
            article_path = wiki_path(article.slug)
            content = storage.read(article_path, strict=False)
            if content is None:
                continue
            doc = DocumentCreate(
                file_path=article_path,
                content=content,
                doc_kind=DOC_KIND_WIKI,
                title=article.slug.replace("-", " ").title(),
                compiled=True,
                tags=article.tags,
                concepts=article.connections,
            )
            await doc_repo.upsert(brain_id, doc)
            await doc_repo.rebuild_backlinks_for_article(
                brain_id, article.slug, content
            )

        await db_session.commit()
        log.info(
            "synced %d raw docs + %d wiki articles to documents table",
            len(docs),
            len(written),
        )

    log.info(
        "compilation complete -- %d docs, %d articles, %d chunks indexed",
        len(docs),
        len(written),
        chunks_indexed,
    )

    return CompilationResult(
        docs_compiled=len(docs),
        articles_written=[{"slug": a.slug, "action": a.action} for a in written],
        chunks_indexed=chunks_indexed,
    )
