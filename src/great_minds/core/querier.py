"""Query interface for the knowledge base.

Uses Gemma 4 31B via OpenRouter with function calling to navigate the wiki.
Emits structured telemetry via wide events — every query logs which articles
and sources were pulled into context, with timing.
"""

import enum
import json
import uuid
from collections.abc import AsyncGenerator
from dataclasses import asdict, dataclass
from typing import Literal
from uuid import UUID

from openai import AsyncOpenAI
from pydantic import BaseModel

from .vaults.config import load_vault_config
from .vaults.prompts import load_prompt
from .search import search as hybrid_search
from .markdown import extract_wiki_link_targets
from .documents.schemas import DocKind
from .documents.service import DocumentService
from .llm import QUERY_MODEL, get_async_client
from .llm.client import api_stream, is_retryable, models_with_fallback
from .llm_costs import record_wide_event_cost
from .storage import Storage
from .telemetry import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    log_event,
)


class QueryMode(enum.StrEnum):
    QUERY = "query"
    BTW = "btw"


class HistoryMessage(BaseModel):
    """A prior turn in the conversation, fed back to the model as real history."""

    role: Literal["user", "assistant"]
    content: str


class SourceType(enum.StrEnum):
    ARTICLE = "article"
    RAW = "raw"
    SEARCH = "search"
    QUERY = "query"


@dataclass
class SourceConsulted:
    """A document the query engine read while answering."""

    kind: DocKind
    path: str
    title: str | None = None


async def _build_sources_consulted(
    vault: "QuerySource",
    doc_service: DocumentService,
    articles_read: list[str],
    sources_read: list[str],
) -> list[SourceConsulted]:
    seen: set[str] = set()
    out: list[SourceConsulted] = []
    for path in articles_read:
        if path not in seen:
            seen.add(path)
            title = await doc_service.get_title_by_path(vault.vault_id, path)
            out.append(SourceConsulted(kind=DocKind.WIKI, path=path, title=title))
    for path in sources_read:
        if path not in seen:
            seen.add(path)
            title = await doc_service.get_title_by_path(vault.vault_id, path)
            out.append(SourceConsulted(kind=DocKind.RAW, path=path, title=title))
    return out


@dataclass
class QuerySource:
    """A labeled storage that the query engine can search across."""

    storage: Storage
    label: str
    vault_id: UUID


_BASE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": (
                "Read a document from the knowledge base by path. "
                "Works for wiki articles (e.g. wiki/capitalism.md) "
                "and raw sources (e.g. raw/texts/lenin/works/1893/market/02.md)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "Document path, e.g. wiki/capitalism.md or "
                            "raw/texts/lenin/works/1893/market/02.md"
                        ),
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_wiki",
            "description": (
                "Search across wiki articles for a term or phrase. "
                "Returns matching excerpts with article paths. Use when "
                "you're not sure which article covers a topic."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search term or phrase",
                    },
                },
                "required": ["query"],
            },
        },
    },
]


def _build_query_tool(tags: list[str]) -> dict:
    """Build the query_documents tool definition with available vocabulary."""
    tags_desc = f"Available tags: {', '.join(tags)}" if tags else "No tags yet"
    return {
        "type": "function",
        "function": {
            "name": "query_documents",
            "description": (
                "Search documents by structured metadata filters. "
                "Use when you need to find documents by tag, author, date, genre, "
                "or type — not by content similarity. "
                f"{tags_desc}."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Filter by tags (all must match)",
                    },
                    "author": {
                        "type": "string",
                        "description": "Filter by author name (partial match)",
                    },
                    "doc_kind": {
                        "type": "string",
                        "description": "Document kind: raw or wiki",
                    },
                    "genre": {
                        "type": "string",
                        "description": "Filter by genre (e.g. theoretical, polemical)",
                    },
                    "date_gte": {
                        "type": "string",
                        "description": "Published on or after this date/year",
                    },
                    "date_lte": {
                        "type": "string",
                        "description": "Published on or before this date/year",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 20)",
                    },
                },
            },
        },
    }


_QUERY_WIKI_ARTICLES_TOOL: dict = {
    "type": "function",
    "function": {
        "name": "query_wiki_articles",
        "description": (
            "Find wiki articles by title/description or slug. Returns article "
            "paths you can pass to read_document to fetch content."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Text match against title and description "
                        "(case-insensitive, partial match)"
                    ),
                },
                "slug": {
                    "type": "string",
                    "description": "Exact slug match",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (default 20)",
                },
            },
        },
    },
}


def build_tools(tags: list[str]) -> list[dict]:
    """Build the full tool list with vocabulary injected into query_documents."""
    return _BASE_TOOLS + [_build_query_tool(tags), _QUERY_WIKI_ARTICLES_TOOL]


# OpenRouter routing preferences for the agent's chat calls. Tells the
# provider it's OK to route across upstreams and to prefer throughput.
# Cost-include + stream usage flags are set by ``api_call`` /
# ``api_stream`` themselves — this dict only carries the routing intent.
_ROUTING_PREFERENCE = {
    "provider": {
        "allow_fallbacks": True,
        "sort": "throughput",
    },
}


def _classify_tool_call(name: str, args: dict) -> tuple[SourceType, dict] | None:
    """Return (source_type, metadata) for telemetry and SSE source events."""
    if name == "read_document":
        path = args["path"]
        doc_type = SourceType.ARTICLE if path.startswith("wiki/") else SourceType.RAW
        return doc_type, {"path": path}
    if name == "search_wiki":
        return SourceType.SEARCH, {"query": args["query"]}
    if name == "query_documents":
        return SourceType.QUERY, {"filters": {k: v for k, v in args.items() if v}}
    if name == "query_wiki_articles":
        return SourceType.QUERY, {"filters": {k: v for k, v in args.items() if v}}
    return None


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


async def read_document(vault: QuerySource, path: str) -> str:
    content = await vault.storage.read(path, strict=False)
    if content is None:
        log_event("tool.document_not_found", path=path)
        return f"Document not found: {path}"
    truncated = len(content) > 20_000
    if truncated:
        content = (
            content[:20_000]
            + "\n\n[...truncated — ask for a specific section if needed...]"
        )
    log_event(
        "tool.document_read",
        path=path,
        vault=vault.label,
        chars=len(content),
        truncated=truncated,
    )
    forward_links = extract_wiki_link_targets(content)
    links_section = (
        "\n\n---\nForward links: " + ", ".join(forward_links) if forward_links else ""
    )
    return f"# {path} [{vault.label}]\n\n{content}{links_section}"


async def read_document_enriched(
    vault: QuerySource, path: str, doc_service: DocumentService
) -> str:
    """Read a document.

    Backlinks will be attached here once the retrieval surface consumes
    verify's document-keyed backlinks table. Until then this is a straight
    pass-through to read_document.
    """
    return await read_document(vault, path)


async def search_wiki(
    vault: QuerySource, query: str, doc_service: DocumentService
) -> str:
    """Hybrid BM25 + vector search via the search index."""
    results = await hybrid_search(doc_service.repo.session, [vault.vault_id], query)

    log_event("tool.search_executed", query=query, results_count=len(results))

    if not results:
        return f"No results found for: {query}"

    parts = []
    for r in results:
        filename = r.path.rsplit("/", 1)[-1]
        heading = f" > {r.heading}" if r.heading else ""
        parts.append(f"### {filename}{heading}\n{r.snippet}")

    return f"Found {len(results)} results for '{query}':\n\n" + "\n\n".join(parts)


async def query_documents(
    vault: QuerySource, args: dict, doc_service: DocumentService
) -> str:
    """Structured metadata query via the documents table."""
    filters = {
        k: v
        for k, v in {
            "tags": args.get("tags"),
            "author": args.get("author"),
            "genre": args.get("genre"),
            "date_gte": args.get("date_gte"),
            "date_lte": args.get("date_lte"),
            "doc_kind": args.get("doc_kind"),
            "limit": args.get("limit", 20),
        }.items()
        if v is not None
    }

    results = await doc_service.query_documents([vault.vault_id], **filters)
    log_event("tool.query_executed", filters=str(filters), results_count=len(results))

    if not results:
        return f"No documents match the filters: {json.dumps(filters)}"

    parts = []
    for doc in results:
        metadata = doc.metadata
        tags_str = f"  tags: {', '.join(metadata.tags)}" if metadata.tags else ""
        meta = f"  [{doc.doc_kind}] {doc.file_path}"
        if metadata.author:
            meta += f" by {metadata.author}"
        if metadata.published_date:
            meta += f" ({metadata.published_date})"
        lines = [f"### {metadata.title or doc.file_path}", meta]
        if metadata.genre:
            lines.append(f"  genre: {metadata.genre}")
        if tags_str:
            lines.append(tags_str)
        parts.append("\n".join(lines))

    return f"Found {len(results)} documents:\n\n" + "\n\n".join(parts)


async def query_wiki_articles(
    vault: QuerySource, args: dict, doc_service: DocumentService
) -> str:
    """Structured query over the wiki article registry.

    Filtering happens SQL-side via ``DocumentService.search_wiki_articles``
    (case-insensitive substring match on title/precis, exact slug match,
    underscore-prefixed slugs excluded).
    """
    slug_filter = args.get("slug")
    query_str = (args.get("query") or "").strip()
    limit = args.get("limit") or 20

    rows = await doc_service.search_wiki_articles(
        vault.vault_id,
        slug=slug_filter,
        query=query_str or None,
        limit=limit,
    )

    log_event(
        "tool.query_wiki_articles_executed",
        filters=str(args),
        results_count=len(rows),
    )

    if not rows:
        return f"No wiki articles match: {json.dumps(args)}"

    parts = [
        f"### {row.title}\n  path: {row.file_path}\n  {row.precis or ''}"
        for row in rows
    ]
    return f"Found {len(rows)} wiki articles:\n\n" + "\n\n".join(parts)


async def _dispatch_tool(
    vault: QuerySource, name: str, args: dict, doc_service: DocumentService
) -> str:
    if name == "read_document":
        return await read_document_enriched(vault, args["path"], doc_service)
    elif name == "search_wiki":
        return await search_wiki(vault, args["query"], doc_service)
    elif name == "query_documents":
        return await query_documents(vault, args, doc_service)
    elif name == "query_wiki_articles":
        return await query_wiki_articles(vault, args, doc_service)
    else:
        return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# Client / prompt / chat
# ---------------------------------------------------------------------------


async def _build_identity_for_source(
    source: QuerySource, doc_service: DocumentService
) -> str:
    """Render a per-vault identity block for the system prompt.

    Identity gives the agent shape awareness (vault name, editorial
    focus, corpus size) without listing every article. Article-level
    discovery happens via tools: search_wiki, query_wiki_articles,
    query_documents.
    """
    config = await load_vault_config(source.storage)
    wiki_count = await doc_service.count_by_kind(source.vault_id, DocKind.WIKI)
    raw_count = await doc_service.count_by_kind(source.vault_id, DocKind.RAW)

    focus = config.thematic_hint.strip() or "(no editorial focus set)"
    return (
        f"### {source.label}\n"
        f"Focus: {focus}\n"
        f"Coverage: {wiki_count} wiki article"
        f"{'s' if wiki_count != 1 else ''}, "
        f"{raw_count} raw source"
        f"{'s' if raw_count != 1 else ''}."
    )


_RETRIEVAL_CORE = """\
You have access to tools that let you search and read documents in the \
knowledge base. Use them to answer questions based on the actual texts.

Approach:
1. Use `search_wiki` or `query_wiki_articles` to find articles relevant to \
the question.
2. Read the relevant articles via `read_document` (e.g. wiki/slug.md).
3. To verify a claim or get more depth, follow source citations in the wiki \
article to read raw primary texts (e.g. raw/texts/...).
4. Use `query_documents` when filtering by tag, author, date, or kind.

Rules:
- Always ground answers in the actual texts via tools — do not rely on your \
general knowledge.
- If the knowledge base doesn't cover something, say so rather than making \
it up.

Knowledge base:
{identity}"""


async def build_system_prompt(
    vault: "QuerySource",
    doc_service: DocumentService,
    *,
    mode: QueryMode = QueryMode.QUERY,
    extra_instructions: str | None = None,
) -> str:
    identity = await _build_identity_for_source(vault, doc_service) or "(empty vault)"

    # Layer 1: retrieval discipline (not overridable)
    prompt = _RETRIEVAL_CORE.format(identity=identity)

    # Layer 2: per-vault default persona
    prompt += "\n\n" + await load_prompt(vault.storage, "query")

    if mode == QueryMode.BTW:
        prompt += "\n\n" + await load_prompt(vault.storage, "query_btw")

    # Layer 3: per-request consumer instructions
    if extra_instructions:
        prompt += "\n\n" + extra_instructions

    return prompt


# ---------------------------------------------------------------------------
# Streaming chat — single conversation path, consumed via SSE by the API and
# directly by the CLI.
# ---------------------------------------------------------------------------


async def stream_chat(
    vault: QuerySource,
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    doc_service: DocumentService,
    *,
    tools: list[dict] | None = None,
) -> AsyncGenerator[dict, None]:
    """Yield SSE event dicts as the model traverses the knowledge base.

    Events:
      {"event": "source",   "data": {"type": "article"|"raw"|"search"|"query", ...}}
      {"event": "token",    "data": {"text": "..."}}
      {"event": "done",     "data": {"sources_consulted": [...]}}
      {"event": "error",    "data": {"message": "..."}}
    """
    active_tools = tools or _BASE_TOOLS
    articles_read: list[str] = []
    sources_read: list[str] = []
    searches: list[str] = []
    llm_rounds = 0
    tool_calls_total = 0

    while True:
        llm_rounds += 1
        tool_calls_acc: dict[int, dict] = {}
        content_acc = ""
        finish_reason = None

        async for chunk in api_stream(
            client,
            model=model,
            messages=messages,
            tools=active_tools,
            temperature=0.3,
            extra_body=_ROUTING_PREFERENCE,
        ):
            # Cost is accumulated by ``api_stream`` from the final usage
            # chunk; we only consume content/tool-call deltas here.
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta

            if choice.finish_reason:
                finish_reason = choice.finish_reason

            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx not in tool_calls_acc:
                        tool_calls_acc[idx] = {"id": "", "name": "", "arguments": ""}
                    if tc_delta.id:
                        tool_calls_acc[idx]["id"] = tc_delta.id
                    if tc_delta.function:
                        if tc_delta.function.name:
                            tool_calls_acc[idx]["name"] = tc_delta.function.name
                        if tc_delta.function.arguments:
                            tool_calls_acc[idx]["arguments"] += (
                                tc_delta.function.arguments
                            )

            if delta.content:
                content_acc += delta.content
                yield {"event": "token", "data": {"text": delta.content}}

        if finish_reason == "tool_calls" and tool_calls_acc:
            messages.append(
                {
                    "role": "assistant",
                    "content": content_acc or None,
                    "tool_calls": [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": tc["arguments"],
                            },
                        }
                        for tc in tool_calls_acc.values()
                    ],
                }
            )

            for tc in tool_calls_acc.values():
                tool_calls_total += 1
                try:
                    args = json.loads(tc["arguments"])
                except json.JSONDecodeError:
                    yield {
                        "event": "error",
                        "data": {"message": f"Malformed tool args for {tc['name']}"},
                    }
                    return
                name = tc["name"]

                classified = _classify_tool_call(name, args)
                if classified:
                    source_type, meta = classified
                    event_data: dict = {"type": source_type, **meta}
                    if source_type in (SourceType.ARTICLE, SourceType.RAW):
                        event_data["title"] = await doc_service.get_title_by_path(
                            vault.vault_id, meta["path"]
                        )
                    yield {"event": "source", "data": event_data}

                    if source_type is SourceType.SEARCH:
                        searches.append(meta["query"])
                    elif source_type in (SourceType.ARTICLE, SourceType.RAW):
                        (
                            articles_read
                            if source_type is SourceType.ARTICLE
                            else sources_read
                        ).append(meta["path"])

                result = await _dispatch_tool(vault, name, args, doc_service)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result,
                    }
                )

            continue

        if content_acc:
            messages.append({"role": "assistant", "content": content_acc})

        enrich(
            model=model,
            articles_read=articles_read,
            sources_read=sources_read,
            searches=searches,
            llm_rounds=llm_rounds,
            tool_calls=tool_calls_total,
        )
        sources = await _build_sources_consulted(
            vault, doc_service, articles_read, sources_read
        )
        yield {
            "event": "done",
            "data": {
                "sources_consulted": [asdict(s) for s in sources],
            },
        }
        return


async def _build_origin_messages(
    vault: QuerySource,
    origin_path: str,
) -> list[dict]:
    """Build synthetic tool-call messages that pre-load the origin document."""
    content = await read_document(vault, origin_path)
    tool_call_id = f"origin-{uuid.uuid4().hex[:8]}"
    return [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": "read_document",
                        "arguments": json.dumps({"path": origin_path}),
                    },
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content,
        },
    ]


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


async def _load_tools(vault: QuerySource, doc_service: DocumentService) -> list[dict]:
    """Load tag vocabulary from DB and build the full tool list."""
    tags = await doc_service.get_distinct_tags([vault.vault_id])
    return build_tools(tags)


async def run_query(
    vault: QuerySource,
    question: str,
    doc_service: DocumentService,
    *,
    user_id: UUID | None = None,
    model: str | None = None,
    origin_path: str | None = None,
    history: list[HistoryMessage] | None = None,
    mode: QueryMode = QueryMode.QUERY,
    extra_instructions: str | None = None,
) -> AsyncGenerator[dict, None]:
    """Stream SSE events for a single question, with model fallback on rate limit."""
    primary = model or QUERY_MODEL
    client = get_async_client(max_retries=0)
    system_prompt = await build_system_prompt(
        vault, doc_service, mode=mode, extra_instructions=extra_instructions
    )
    tools = await _load_tools(vault, doc_service)
    base_messages: list[dict] = [
        {"role": "system", "content": system_prompt},
    ]
    if origin_path:
        base_messages.extend(await _build_origin_messages(vault, origin_path))
    if history:
        base_messages.extend(m.model_dump() for m in history)
    base_messages.append({"role": "user", "content": question})

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query.stream", question=question, vault_id=str(vault.vault_id))

    try:
        for m in models_with_fallback(primary):
            messages = list(base_messages)
            try:
                async for event in stream_chat(
                    vault, client, m, messages, doc_service, tools=tools
                ):
                    yield event
                return
            except Exception as e:
                if is_retryable(e):
                    log_event("query.stream_retryable", model=m, error=str(e))
                    continue
                yield {"event": "error", "data": {"message": str(e)}}
                return

        yield {
            "event": "error",
            "data": {"message": "all models failed — try again in a minute"},
        }
    finally:
        await _finalize_wide_event(
            doc_service, user_id=user_id, vault_id=vault.vault_id
        )


async def _finalize_wide_event(
    doc_service: DocumentService,
    *,
    user_id: UUID | None,
    vault_id: UUID | None,
) -> None:
    """Persist accumulated cost as one cost row, then emit the wide event.

    Pulls the same in-memory accumulator the log entry will read, so the
    persisted row and the structured-log event carry identical numbers.
    """
    await record_wide_event_cost(
        doc_service.repo.session, user_id=user_id, vault_id=vault_id
    )
    await doc_service.repo.session.commit()
    emit_wide_event()
