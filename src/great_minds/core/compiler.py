"""Compiler: process raw texts into the wiki knowledge base.

Library module called by Brain.compile(). Receives a Storage instance
for I/O and a load_prompt callable for prompt resolution.

Pipeline architecture:
  Phase 1: Enrich all docs in parallel (cheap extraction)
  Phase 2: Plan all docs in parallel (cheap planning)
  Phase 3: Reconcile plans via LLM (semantic clustering of slugs)
  Phase 4: Write all articles in parallel (DeepSeek -- expensive reasoning)
  Phase 5: Update _index.md (cheap summarization)
  Phase 6: Backlinks + changelog (deterministic, storage-only)
  Phase 7: Rebuild search index (DB)
  Phase 8: Sync documents table (DB)
  Phase 9: Mark raw docs compiled (storage flag — last, so retries see
           uncompiled state if any earlier phase crashes mid-run)

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
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from uuid import UUID

from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.brain import load_config, wiki_path, wiki_slug
from great_minds.core.search import rebuild_index
from great_minds.core.brain_utils import (
    api_call,
    extract_content,
    parse_frontmatter,
    serialize_frontmatter,
    strip_json_fencing,
)
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.service import DocumentService
from great_minds.core.ingester import FieldSpec, load_field_specs
from great_minds.core.llm import EXTRACT_MODEL, REASON_MODEL, get_async_client
from great_minds.core.settings import get_settings
from great_minds.core.storage import Storage
from great_minds.core.telemetry import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    log_event,
    timed_op,
)

log = logging.getLogger(__name__)

MAX_SOURCE_CHARS = 30_000
MIN_SOURCE_EXCERPT_CHARS = (
    4_000  # floor per-source when budget split across many sources
)


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


def _content_type_from_path(path: str) -> str:
    """Infer content type from the storage path.

    Example: "raw/texts/lenin/ch1.md" -> "texts"
    """
    parts = path.split("/")
    if len(parts) >= 2 and parts[0] == "raw":
        return parts[1]
    return "texts"


def _build_extra_fields_prompt(enriched_specs: list[FieldSpec]) -> str:
    """Build the {extra_fields} section for the enrich prompt."""
    if not enriched_specs:
        return ""
    lines = []
    for spec in enriched_specs:
        type_hint = "list of " if spec.type == "list" else ""
        lines.append(f'- "{spec.name}": {type_hint}{spec.description}')
    return "\n".join(lines)


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
    config: dict,
) -> EnrichedDoc:
    content = storage.read(filepath)
    if content is None:
        raise FileNotFoundError(filepath)
    fm, body = parse_frontmatter(content)
    title = fm.get("title", _stem_from_path(filepath))

    content_type = _content_type_from_path(filepath)
    specs = load_field_specs(config, content_type)
    enriched_specs = [s for s in specs if s.source == "enriched"]
    extra_fields = _build_extra_fields_prompt(enriched_specs)

    async with sem:
        prompt = load_prompt("enrich").format(
            author=fm.get("author", "unknown"),
            extra_fields=extra_fields,
        )
        response = await api_call(
            client,
            model=EXTRACT_MODEL,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": truncate_body(body)},
            ],
            temperature=0.2,
            extra_body={"reasoning": {"enabled": False}},
            response_format={"type": "json_object"},
        )

    text = extract_content(response)
    if text:
        raw = strip_json_fencing(text)
        try:
            data = json.loads(raw)
            # Universal enriched fields
            fm["genre"] = data.get("genre", "")
            fm["tags"] = data.get("tags", [])
            # Config-driven enriched fields
            for spec in enriched_specs:
                default = [] if spec.type == "list" else ""
                fm[spec.name] = data.get(spec.name, default)
            log_event(
                "doc_enriched",
                doc_path=filepath,
                title=title,
                genre=fm["genre"],
                tag_count=len(fm["tags"]),
            )
        except json.JSONDecodeError:
            log_event(
                "enrichment_parse_failed",
                level=logging.WARNING,
                doc_path=filepath,
                title=title,
                raw_preview=raw[:200],
            )
    else:
        log_event(
            "enrichment_empty",
            level=logging.WARNING,
            doc_path=filepath,
            title=title,
        )

    return filepath, fm, body


# ---------------------------------------------------------------------------
# Phase 2: Plan (parallel, cheap)
# ---------------------------------------------------------------------------


def read_index(storage: Storage) -> str:
    content = storage.read("wiki/_index.md", strict=False)
    if content is None:
        content = "(no articles yet)"
    return content


def _wiki_index_slugs(storage: Storage) -> list[str]:
    """List all existing wiki article slugs (excludes _index, _changelog)."""
    return [
        wiki_slug(path.rsplit("/", 1)[-1])
        for path in storage.glob("wiki/*.md")
        if not path.rsplit("/", 1)[-1].startswith("_")
    ]


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
            extra_body={"reasoning": {"enabled": False}},
            response_format={"type": "json_object"},
        )

    text = extract_content(response)
    if not text:
        log_event("plan_empty", level=logging.WARNING, doc_idx=doc_idx)
        return []

    raw = strip_json_fencing(text)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log_event(
            "plan_parse_failed",
            level=logging.WARNING,
            doc_idx=doc_idx,
            raw_preview=raw[:200],
        )
        return []

    articles: list[PlannedArticle] = []
    for raw_article in data.get("articles", []):
        raw_article["source_idx"] = doc_idx
        try:
            articles.append(PlannedArticle.model_validate(raw_article))
        except ValidationError as e:
            log_event(
                "plan_invalid_article",
                level=logging.WARNING,
                doc_idx=doc_idx,
                raw_article=raw_article,
                error=str(e),
            )
    return articles


# ---------------------------------------------------------------------------
# Phase 3: Reconcile (deterministic, no LLM)
# ---------------------------------------------------------------------------


async def reconcile_plans(
    all_plans: list[list[PlannedArticle]],
    load_prompt: Callable[[str], str],
    client: AsyncOpenAI,
    wiki_index_slugs: list[str],
) -> list[PlannedArticle]:
    """Cluster raw plans into canonical articles via one LLM call.

    Each source doc's planner produced its own slug proposals. This step
    merges semantically equivalent plans — `finance-capital` +
    `imperialism-21st-century` → one article, even though exact-match
    reconciliation wouldn't catch that.

    Raises on malformed JSON; absurd retries handle transient failures.
    """
    flat: list[PlannedArticle] = [a for plan in all_plans for a in plan]
    if not flat:
        return []

    plans_json = json.dumps(
        [
            {
                "slug": a.slug,
                "action": a.action.value,
                "tags": a.tags,
                "key_points": a.key_points,
                "connections": a.connections,
                "source_idx": a.source_idx,
            }
            for a in flat
        ],
        ensure_ascii=False,
    )
    prompt = load_prompt("reconcile").format(
        plans=plans_json,
        existing_slugs=", ".join(wiki_index_slugs) if wiki_index_slugs else "(none)",
    )

    response = await api_call(
        client,
        model=EXTRACT_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
        extra_body={"reasoning": {"enabled": False}},
        response_format={"type": "json_object"},
    )

    text = extract_content(response)
    if not text:
        raise RuntimeError("reconcile_plans: empty LLM response")

    data = json.loads(strip_json_fencing(text))
    articles: list[PlannedArticle] = []
    for raw in data.get("articles", []):
        # source_indices already populated by the LLM; set source_idx to
        # the first one for backward-compat with write_one's fallback.
        raw.setdefault(
            "source_idx", raw["source_indices"][0] if raw.get("source_indices") else 0
        )
        articles.append(PlannedArticle.model_validate(raw))

    log_event(
        "plans_reconciled",
        unique_articles=len(articles),
        raw_plan_count=len(flat),
        duplicates_merged=len(flat) - len(articles),
    )

    return articles


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
    """Write a single wiki article from all contributing source documents."""
    source_indices = article.source_indices or [article.source_idx]
    primary_idx = source_indices[0]
    _, primary_fm, _primary_body = docs[primary_idx]

    source_paths = [docs[idx][0] for idx in source_indices]
    source_paths_str = "\n".join(f"  - {p}" for p in source_paths)

    # Distribute the body-excerpt budget across contributing sources so the
    # article can cite across docs, not just the primary. Each source gets
    # (total_budget / N) chars; labeled with its path for the LLM to footnote.
    per_source_chars = max(
        MIN_SOURCE_EXCERPT_CHARS, MAX_SOURCE_CHARS // len(source_indices)
    )
    excerpt_blocks: list[str] = []
    for idx in source_indices:
        path, _fm, body = docs[idx]
        excerpt_blocks.append(
            f"### {path}\n{truncate_body(body, max_chars=per_source_chars)}"
        )
    source_excerpts = "\n\n".join(excerpt_blocks)

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
        title=primary_fm.get("title", ""),
        author=primary_fm.get("author", ""),
        date=primary_fm.get("date", ""),
        genre=primary_fm.get("genre", ""),
        concepts=", ".join(primary_fm.get("concepts", [])),
        source_paths=source_paths_str,
        key_points=key_points,
        connections=connections,
        wiki_index=wiki_index,
        batch_articles=batch_articles,
        source_excerpts=source_excerpts,
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
        log_event(
            "article_write_empty",
            level=logging.ERROR,
            slug=article.slug,
            action=action.value,
        )
        return None

    storage.write(article_path, content)
    log_event(
        "article_written",
        slug=article.slug,
        action=action.value,
        source_count=len(article.source_indices),
    )
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
        extra_body={"reasoning": {"enabled": False}},
    )

    new_index = extract_content(response)
    if not new_index:
        log_event("index_update_empty", level=logging.WARNING)
        return

    if new_index.startswith("# Wiki Index"):
        storage.write("wiki/_index.md", new_index + "\n")
        log_event("index_updated", article_count=len(written_articles))
    else:
        log_event(
            "index_update_malformed",
            level=logging.WARNING,
            preview=new_index[:200],
        )


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

    log_event("backlink_pass_completed")


def mark_compiled(storage: Storage, docs: list[EnrichedDoc]):
    for filepath, fm, body in docs:
        fm["compiled"] = True
        storage.write(filepath, serialize_frontmatter(fm, body))
    log_event("docs_marked_compiled", doc_count=len(docs))


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
    post_write_hook: Callable[[Storage], Awaitable[None]] | None = None,
) -> CompilationResult:
    client = get_async_client()
    settings = get_settings()
    enrich_sem = asyncio.Semaphore(settings.compile_enrich_concurrency)
    plan_sem = asyncio.Semaphore(settings.compile_plan_concurrency)
    write_sem = asyncio.Semaphore(settings.compile_write_concurrency)
    config = load_config(storage)

    uncompiled = find_uncompiled(storage)
    log_event("compile_found_uncompiled", doc_count=len(uncompiled))

    if limit:
        uncompiled = uncompiled[:limit]
        log_event("compile_limit_applied", limit=limit)

    if not uncompiled:
        log_event("compile_nothing_to_do")
        return CompilationResult()

    if correlation_id.get() == "-":
        correlation_id.set(f"c-{uuid.uuid4().hex[:8]}")
    init_wide_event(
        "brain_compiled",
        brain_id=str(brain_id) if brain_id else None,
        doc_count=len(uncompiled),
    )

    # --- Phase 1: Enrich all docs in parallel (cheap) ---
    log_event("phase_started", phase="enrich", doc_count=len(uncompiled))
    async with timed_op("enrich"):
        enrichment_results = await asyncio.gather(
            *(
                enrich_one(storage, load_prompt, client, enrich_sem, fp, config)
                for fp in uncompiled
            ),
            return_exceptions=True,
        )

    docs: list[EnrichedDoc] = []
    enrich_failures = 0
    for r in enrichment_results:
        if isinstance(r, Exception):
            log_event(
                "enrichment_task_failed",
                level=logging.ERROR,
                error=str(r),
                error_class=type(r).__name__,
            )
            enrich_failures += 1
        else:
            docs.append(r)

    enrich(docs_enriched=len(docs), enrich_failures=enrich_failures)
    log_event(
        "phase_completed",
        phase="enrich",
        docs_enriched=len(docs),
        failures=enrich_failures,
    )

    # --- Phase 2: Plan all docs in parallel (cheap) ---
    log_event("phase_started", phase="plan", doc_count=len(docs))
    wiki_index = read_index(storage)
    async with timed_op("plan"):
        plan_results = await asyncio.gather(
            *(
                plan_one(
                    storage, load_prompt, client, plan_sem, i, fm, body, wiki_index
                )
                for i, (_, fm, body) in enumerate(docs)
            ),
            return_exceptions=True,
        )

    all_plans: list[list[PlannedArticle]] = []
    plan_failures = 0
    for i, r in enumerate(plan_results):
        if isinstance(r, Exception):
            log_event(
                "planning_task_failed",
                level=logging.ERROR,
                doc_idx=i,
                error=str(r),
                error_class=type(r).__name__,
            )
            all_plans.append([])
            plan_failures += 1
        else:
            log_event("doc_planned", doc_idx=i, article_count=len(r))
            all_plans.append(r)

    # --- Phase 3: Reconcile plans (LLM-driven semantic clustering) ---
    log_event("phase_started", phase="reconcile")
    async with timed_op("reconcile"):
        reconciled = await reconcile_plans(
            all_plans,
            load_prompt,
            client,
            wiki_index_slugs=_wiki_index_slugs(storage),
        )
    enrich(articles_planned=len(reconciled), plan_failures=plan_failures)

    if not reconciled:
        log_event("compile_no_articles_planned", doc_count=len(docs))
        mark_compiled(storage, docs)
        emit_wide_event()
        return CompilationResult(docs_compiled=len(docs))

    # --- Phase 4: Write all articles in parallel (expensive) ---
    log_event("phase_started", phase="write", article_count=len(reconciled))
    wiki_index = read_index(storage)
    async with timed_op("write"):
        write_results = await asyncio.gather(
            *(
                write_one(
                    storage,
                    load_prompt,
                    client,
                    write_sem,
                    article,
                    reconciled,
                    docs,
                    wiki_index,
                )
                for article in reconciled
            ),
            return_exceptions=True,
        )

    written: list[PlannedArticle] = []
    write_failures = 0
    for r in write_results:
        if isinstance(r, Exception):
            log_event(
                "article_write_task_failed",
                level=logging.ERROR,
                error=str(r),
                error_class=type(r).__name__,
            )
            write_failures += 1
        elif r is not None:
            written.append(r)

    enrich(articles_written=len(written), write_failures=write_failures)
    log_event(
        "phase_completed",
        phase="write",
        articles_written=len(written),
        failures=write_failures,
    )

    # --- Phase 5: Update index (cheap) ---
    log_event("phase_started", phase="index_update")
    async with timed_op("index_update"):
        await update_index(storage, load_prompt, client, written)

    # --- Phase 6: Backlinks + changelog ---
    log_event("phase_started", phase="finalize")
    async with timed_op("backlinks"):
        insert_backlinks(storage)
        append_changelog(storage, docs, written)

    # --- Post-write hook (e.g. lint fixes) — before index rebuild ---
    if post_write_hook is not None:
        async with timed_op("post_write_hook"):
            await post_write_hook(storage)

    # --- Phase 7: Rebuild search index ---
    chunks_indexed = 0
    if db_session is not None and brain_id is not None:
        log_event("phase_started", phase="search_index")
        async with timed_op("search_index"):
            chunks_indexed = await rebuild_index(db_session, brain_id, storage)
        enrich(chunks_indexed=chunks_indexed)

    # --- Phase 8: Sync documents table (enriched raw docs + wiki articles) ---
    if db_session is not None and brain_id is not None:
        log_event("phase_started", phase="sync_docs")
        async with timed_op("sync_docs"):
            doc_service = DocumentService(DocumentRepository(db_session))

            for filepath, _fm, _body in docs:
                content = storage.read(filepath, strict=False)
                if content is None:
                    continue
                await doc_service.index_raw_doc(brain_id, filepath, content)

            for article in written:
                content = storage.read(wiki_path(article.slug), strict=False)
                if content is None:
                    continue
                await doc_service.index_wiki_article(
                    brain_id,
                    article.slug,
                    content,
                    tags=article.tags,
                    concepts=article.connections,
                )

        log_event(
            "docs_synced",
            raw_docs=len(docs),
            wiki_articles=len(written),
        )

    # --- Phase 9: Mark compiled (storage flag — only after everything durable) ---
    mark_compiled(storage, docs)

    log_event(
        "compile_completed",
        docs=len(docs),
        articles=len(written),
        chunks_indexed=chunks_indexed,
    )

    emit_wide_event()

    return CompilationResult(
        docs_compiled=len(docs),
        articles_written=[{"slug": a.slug, "action": a.action} for a in written],
        chunks_indexed=chunks_indexed,
    )
