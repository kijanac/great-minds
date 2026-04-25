"""Query interface for the knowledge base.

Uses Gemma 4 31B via OpenRouter with function calling to navigate the wiki.
Emits structured telemetry via wide events — every query logs which articles
and sources were pulled into context, with timing.
"""

import asyncio
import enum
import json
import uuid
from collections.abc import AsyncGenerator
from dataclasses import asdict, dataclass
from uuid import UUID

from openai import AsyncOpenAI

from .brain import load_prompt
from .paths import wiki_slug
from .search import search as hybrid_search
from .markdown import extract_wiki_link_targets
from .documents.repository import DocumentRepository
from .documents.schemas import DocKind
from .llm import FALLBACK_MODELS, QUERY_MODEL, get_async_client
from .storage import Storage
from .telemetry import (
    accumulate_cost,
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    log_event,
)


class QueryMode(enum.StrEnum):
    QUERY = "query"
    BTW = "btw"


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


@dataclass
class ChatResult:
    """Answer text plus provenance metadata."""

    answer: str
    sources_consulted: list[SourceConsulted]


def _build_sources_consulted(
    articles_read: list[str],
    sources_read: list[str],
) -> list[SourceConsulted]:
    seen: set[str] = set()
    out: list[SourceConsulted] = []
    for path in articles_read:
        if path not in seen:
            seen.add(path)
            out.append(SourceConsulted(kind=DocKind.WIKI, path=path))
    for path in sources_read:
        if path not in seen:
            seen.add(path)
            out.append(SourceConsulted(kind=DocKind.RAW, path=path))
    return out


@dataclass
class QuerySource:
    """A labeled storage that the query engine can search across."""

    storage: Storage
    label: str
    brain_id: UUID


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


PROVIDER_EXTRA_BODY = {
    "provider": {
        "allow_fallbacks": True,
        "sort": "throughput",
    },
    # OpenRouter extension: include response.usage.cost (USD) for
    # per-call spend tracking in the query wide event.
    "usage": {"include": True},
}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


class _StreamStalled(Exception):
    """Raised when no chunks arrive within the timeout window."""


def _is_retryable(exc: Exception) -> bool:
    if isinstance(exc, _StreamStalled):
        return True
    msg = str(exc)
    return "429" in msg or "rate" in msg.lower()


def _models_with_fallback(primary: str) -> list[str]:
    return [primary] + [m for m in FALLBACK_MODELS if m != primary]


def _accumulate_cost_from_response(response) -> None:
    """Pull response.usage.cost (OpenRouter extension) into the wide event."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return
    cost = getattr(usage, "cost", None)
    if cost is not None:
        accumulate_cost(float(cost))


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


async def read_document(
    brains: list[QuerySource], path: str, *, brain_id: UUID | None = None
) -> str:
    sources = brains
    if brain_id is not None:
        sources = [s for s in brains if s.brain_id == brain_id] or brains
    for src in sources:
        content = await src.storage.read(path, strict=False)
        if content is not None:
            truncated = len(content) > 20_000
            if truncated:
                content = (
                    content[:20_000]
                    + "\n\n[...truncated — ask for a specific section if needed...]"
                )
            log_event(
                "tool.document_read",
                path=path,
                brain=src.label,
                chars=len(content),
                truncated=truncated,
            )
            # Extract forward links for navigation context
            forward_links = extract_wiki_link_targets(content)
            links_section = ""
            if forward_links:
                links_section = "\n\n---\nForward links: " + ", ".join(forward_links)
            return f"# {path} [{src.label}]\n\n{content}{links_section}"
    log_event("tool.document_not_found", path=path)
    return f"Document not found: {path}"


async def read_document_enriched(
    brains: list[QuerySource], path: str, doc_repo: DocumentRepository
) -> str:
    """Read a document.

    Backlinks will be attached here once phase 5 verify populates the
    topic-id-keyed backlinks table from rendered prose. Until then this
    is a straight pass-through to read_document.
    """
    return await read_document(brains, path)


async def search_wiki(
    brains: list[QuerySource], query: str, doc_repo: DocumentRepository
) -> str:
    """Hybrid BM25 + vector search across all brains via the search index."""
    brain_ids = [src.brain_id for src in brains]
    if not brain_ids:
        log_event("tool.search_skipped", query=query, reason="no_brain_ids")
        return f"No results found for: {query} (search index not available)"

    results = await hybrid_search(doc_repo.session, brain_ids, query)

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
    brains: list[QuerySource], args: dict, doc_repo: DocumentRepository
) -> str:
    """Structured metadata query across all brains via the documents table."""
    brain_ids = [src.brain_id for src in brains]
    if not brain_ids:
        return "No documents available (no indexed brains)"
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

    results = await doc_repo.query_documents(brain_ids, **filters)
    log_event("tool.query_executed", filters=str(filters), results_count=len(results))

    if not results:
        return f"No documents match the filters: {json.dumps(filters)}"

    parts = []
    for doc in results:
        tags_str = f"  tags: {', '.join(doc.tags)}" if doc.tags else ""
        meta = f"  [{doc.doc_kind}] {doc.file_path}"
        if doc.author:
            meta += f" by {doc.author}"
        if doc.published_date:
            meta += f" ({doc.published_date})"
        lines = [f"### {doc.title or doc.file_path}", meta]
        if doc.genre:
            lines.append(f"  genre: {doc.genre}")
        if tags_str:
            lines.append(tags_str)
        parts.append("\n".join(lines))

    return f"Found {len(results)} documents:\n\n" + "\n\n".join(parts)


async def query_wiki_articles(
    brains: list[QuerySource], args: dict, doc_repo: DocumentRepository
) -> str:
    """Structured query over the wiki article registry.

    Pulls title + precis straight from the documents table — the DB is
    the authoritative registry, populated by ingest and enriched by
    extract. Avoids globbing storage and re-parsing frontmatter on every
    tool call.
    """
    if not brains:
        return "No wiki articles available (no brains)"

    slug_filter = args.get("slug")
    query_str = (args.get("query") or "").strip().lower()
    limit = args.get("limit") or 20

    rows: list[tuple[str, str, str, str]] = []
    for src in brains:
        docs = await doc_repo.list_by_kind(src.brain_id, DocKind.WIKI)
        for doc in docs:
            slug = wiki_slug(doc.file_path)
            if slug.startswith("_"):
                continue
            if slug_filter and slug != slug_filter:
                continue
            title = doc.title
            description = doc.precis or ""
            if query_str and query_str not in title.lower() and query_str not in description.lower():
                continue
            rows.append((src.label, slug, title, description))
            if len(rows) >= limit:
                break
        if len(rows) >= limit:
            break

    log_event(
        "tool.query_wiki_articles_executed",
        filters=str(args),
        results_count=len(rows),
    )

    if not rows:
        return f"No wiki articles match: {json.dumps(args)}"

    parts = [
        f"### {title}\n  path: wiki/{slug}.md\n  {description}"
        for _, slug, title, description in rows
    ]
    return f"Found {len(rows)} wiki articles:\n\n" + "\n\n".join(parts)


async def _dispatch_tool(
    brains: list[QuerySource], name: str, args: dict, doc_repo: DocumentRepository
) -> str:
    if name == "read_document":
        return await read_document_enriched(brains, args["path"], doc_repo)
    elif name == "search_wiki":
        return await search_wiki(brains, args["query"], doc_repo)
    elif name == "query_documents":
        return await query_documents(brains, args, doc_repo)
    elif name == "query_wiki_articles":
        return await query_wiki_articles(brains, args, doc_repo)
    else:
        return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# Client / prompt / chat
# ---------------------------------------------------------------------------


async def _build_index_for_source(
    source: QuerySource, doc_repo: DocumentRepository
) -> str:
    """Render a per-brain section of the system-prompt wiki index.

    A curated ``wiki/_index.md`` wins when present (compile pipeline
    writes one). Otherwise we fall back to the documents table — the
    authoritative registry — rather than globbing storage.
    """
    index = await source.storage.read("wiki/_index.md", strict=False)
    if index is not None:
        return f"## [{source.label}]\n{index}"
    docs = await doc_repo.list_by_kind(source.brain_id, DocKind.WIKI)
    entries = [
        f"  - {wiki_slug(d.file_path)}"
        for d in docs
        if not wiki_slug(d.file_path).startswith("_")
    ]
    if entries:
        return f"## [{source.label}]\n" + "\n".join(entries)
    return ""


_RETRIEVAL_CORE = """\
You have access to tools that let you read documents and search the knowledge \
base. Use them to answer questions based on the actual texts in the knowledge base.

Approach:
1. When asked a question, first consider which wiki articles are relevant \
based on the index below.
2. Read the relevant documents using the read_document tool \
(e.g. wiki/slug.md).
3. If you need more detail or want to verify a claim, follow the source \
citations in the wiki article to read the raw primary texts \
(e.g. raw/texts/...).

Rules:
- Always ground your answers in the actual texts — do not rely on your \
general knowledge. Use the tools.
- If the knowledge base doesn't cover something, say so rather than making \
it up.

Current wiki index:
{index}"""


async def build_system_prompt(
    brains: "list[QuerySource]",
    doc_repo: DocumentRepository,
    *,
    mode: QueryMode = QueryMode.QUERY,
    extra_instructions: str | None = None,
) -> str:
    parts = [await _build_index_for_source(b, doc_repo) for b in brains]
    index = "\n\n".join(p for p in parts if p) or "(no articles yet)"

    # Layer 1: retrieval discipline (not overridable)
    prompt = _RETRIEVAL_CORE.format(index=index)

    # Layer 2: per-brain default persona
    storage = brains[0].storage
    prompt += "\n\n" + await load_prompt(storage, "query")

    if mode == QueryMode.BTW:
        prompt += "\n\n" + await load_prompt(storage, "query_btw")

    # Layer 3: per-request consumer instructions
    if extra_instructions:
        prompt += "\n\n" + extra_instructions

    return prompt


async def chat(
    brains: list[QuerySource],
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    doc_repo: DocumentRepository,
    *,
    tools: list[dict] | None = None,
) -> ChatResult:
    """Run a chat turn, handling tool calls in a loop until the model responds with text."""
    active_tools = tools or _BASE_TOOLS
    articles_read: list[str] = []
    sources_read: list[str] = []
    searches: list[str] = []
    llm_rounds = 0
    tool_calls_total = 0

    while True:
        llm_rounds += 1
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            tools=active_tools,
            temperature=0.3,
            extra_body=PROVIDER_EXTRA_BODY,
        )
        _accumulate_cost_from_response(response)

        choice = response.choices[0]
        message = choice.message

        if not message.tool_calls:
            messages.append({"role": "assistant", "content": message.content})
            enrich(
                model=model,
                articles_read=articles_read,
                sources_read=sources_read,
                searches=searches,
                llm_rounds=llm_rounds,
                tool_calls=tool_calls_total,
            )
            emit_wide_event()
            return ChatResult(
                answer=message.content,
                sources_consulted=_build_sources_consulted(articles_read, sources_read),
            )

        messages.append(
            {
                "role": "assistant",
                "content": message.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in message.tool_calls
                ],
            }
        )

        for tc in message.tool_calls:
            tool_calls_total += 1
            name = tc.function.name
            args = json.loads(tc.function.arguments)

            classified = _classify_tool_call(name, args)
            if classified:
                source_type, meta = classified
                if source_type is SourceType.SEARCH:
                    searches.append(meta["query"])
                elif source_type in (SourceType.ARTICLE, SourceType.RAW):
                    (
                        articles_read
                        if source_type is SourceType.ARTICLE
                        else sources_read
                    ).append(meta["path"])

            result = await _dispatch_tool(brains, name, args, doc_repo)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                }
            )


async def chat_with_fallback(
    brains: list[QuerySource],
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    doc_repo: DocumentRepository,
    *,
    tools: list[dict] | None = None,
) -> ChatResult:
    """Try the primary model, fall back to alternatives on rate limit."""
    for m in _models_with_fallback(model):
        try:
            return await chat(brains, client, m, messages, doc_repo, tools=tools)
        except Exception as e:
            if _is_retryable(e):
                log_event("query.retryable_error", model=m, error=str(e))
                continue
            raise

    raise RuntimeError("all models failed — try again in a minute")


# ---------------------------------------------------------------------------
# Async streaming chat (for SSE endpoint)
# ---------------------------------------------------------------------------


CHUNK_TIMEOUT = 30  # seconds to wait for the next streaming chunk


async def _iter_with_timeout(async_iter, timeout: float):
    """Wrap an async iterator with a per-item timeout.

    Raises _StreamStalled if no item arrives within `timeout` seconds.
    """
    ait = aiter(async_iter)
    while True:
        try:
            yield await asyncio.wait_for(anext(ait), timeout)
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError:
            raise _StreamStalled(f"no chunks received for {timeout}s") from None


async def stream_chat(
    brains: list[QuerySource],
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    doc_repo: DocumentRepository,
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
        stream = await client.chat.completions.create(
            model=model,
            messages=messages,
            tools=active_tools,
            temperature=0.3,
            stream=True,
            stream_options={"include_usage": True},
            extra_body=PROVIDER_EXTRA_BODY,
        )

        tool_calls_acc: dict[int, dict] = {}
        content_acc = ""
        finish_reason = None

        async for chunk in _iter_with_timeout(stream, CHUNK_TIMEOUT):
            # Final usage chunk (from stream_options.include_usage).
            # Comes after all content chunks; choices is usually empty.
            if getattr(chunk, "usage", None) is not None:
                _accumulate_cost_from_response(chunk)
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
                    yield {"event": "source", "data": {"type": source_type, **meta}}

                    if source_type is SourceType.SEARCH:
                        searches.append(meta["query"])
                    elif source_type in (SourceType.ARTICLE, SourceType.RAW):
                        (
                            articles_read
                            if source_type is SourceType.ARTICLE
                            else sources_read
                        ).append(meta["path"])

                result = await _dispatch_tool(brains, name, args, doc_repo)
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
        emit_wide_event()
        sources = _build_sources_consulted(articles_read, sources_read)
        yield {
            "event": "done",
            "data": {
                "sources_consulted": [asdict(s) for s in sources],
            },
        }
        return


def _build_origin_messages(
    brains: list[QuerySource],
    origin_path: str,
) -> list[dict]:
    """Build synthetic tool-call messages that pre-load the origin document."""
    content = read_document(brains, origin_path)
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


def _build_session_context_messages(session_md: str) -> list[dict]:
    """Build messages that inject the session transcript as conversation context."""
    return [
        {
            "role": "user",
            "content": (
                "Here is the conversation so far in this research session. "
                "The user is asking a side question about a specific passage.\n\n"
                f"--- SESSION TRANSCRIPT ---\n{session_md}\n--- END TRANSCRIPT ---"
            ),
        },
        {
            "role": "assistant",
            "content": (
                "I've reviewed the session transcript and understand the "
                "conversation context. I'm ready for the follow-up question."
            ),
        },
    ]


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


async def _load_tools(
    brains: list[QuerySource], doc_repo: DocumentRepository
) -> list[dict]:
    """Load tag vocabulary from DB and build the full tool list."""
    brain_ids = [src.brain_id for src in brains]
    if not brain_ids:
        return _BASE_TOOLS
    tags = await doc_repo.get_distinct_tags(brain_ids)
    return build_tools(tags)


async def run_stream_query(
    brains: list[QuerySource],
    question: str,
    doc_repo: DocumentRepository,
    *,
    model: str | None = None,
    origin_path: str | None = None,
    session_context: str | None = None,
    mode: QueryMode = QueryMode.QUERY,
    extra_instructions: str | None = None,
) -> AsyncGenerator[dict, None]:
    """Stream SSE events for a single question, with model fallback on rate limit."""
    primary = model or QUERY_MODEL
    client = get_async_client(max_retries=0)
    system_prompt = await build_system_prompt(
        brains, doc_repo, mode=mode, extra_instructions=extra_instructions
    )
    tools = await _load_tools(brains, doc_repo)
    base_messages: list[dict] = [
        {"role": "system", "content": system_prompt},
    ]
    if origin_path:
        base_messages.extend(_build_origin_messages(brains, origin_path))
    if session_context:
        base_messages.extend(_build_session_context_messages(session_context))
    base_messages.append({"role": "user", "content": question})

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query.stream", question=question, brain_count=len(brains))

    for m in _models_with_fallback(primary):
        messages = list(base_messages)
        try:
            async for event in stream_chat(
                brains, client, m, messages, doc_repo, tools=tools
            ):
                yield event
            return
        except Exception as e:
            if _is_retryable(e):
                log_event("query.stream_retryable", model=m, error=str(e))
                continue
            yield {"event": "error", "data": {"message": str(e)}}
            return

    yield {
        "event": "error",
        "data": {"message": "all models failed — try again in a minute"},
    }


async def run_query(
    brains: list[QuerySource],
    question: str,
    doc_repo: DocumentRepository,
    *,
    model: str | None = None,
    origin_path: str | None = None,
    session_context: str | None = None,
    mode: QueryMode = QueryMode.QUERY,
    extra_instructions: str | None = None,
) -> ChatResult:
    """Answer a single question against the knowledge base."""
    primary = model or QUERY_MODEL
    client = get_async_client()
    system_prompt = await build_system_prompt(
        brains, doc_repo, mode=mode, extra_instructions=extra_instructions
    )
    tools = await _load_tools(brains, doc_repo)
    messages: list[dict] = [{"role": "system", "content": system_prompt}]

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query", question=question, brain_count=len(brains))

    if origin_path:
        messages.extend(_build_origin_messages(brains, origin_path))
    if session_context:
        messages.extend(_build_session_context_messages(session_context))
    messages.append({"role": "user", "content": question})
    return await chat_with_fallback(
        brains, client, primary, messages, doc_repo, tools=tools
    )


async def run_interactive(
    brains: list[QuerySource],
    doc_repo: DocumentRepository,
    *,
    model: str | None = None,
) -> None:
    """Run an interactive REPL session against the knowledge base."""
    model = model or QUERY_MODEL
    client = get_async_client()
    system_prompt = await build_system_prompt(brains, doc_repo)
    tools = await _load_tools(brains, doc_repo)
    messages: list[dict] = [{"role": "system", "content": system_prompt}]

    print(f"Knowledge Base — Query Interface (model: {model})")
    print("Type your question, or 'quit' to exit.\n")

    while True:
        try:
            question = (await asyncio.to_thread(input, "> ")).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not question or question.lower() in ("quit", "exit", "q"):
            break

        query_id = f"q-{uuid.uuid4().hex[:8]}"
        correlation_id.set(query_id)
        init_wide_event("query", question=question)

        messages.append({"role": "user", "content": question})
        result = await chat_with_fallback(
            brains, client, model, messages, doc_repo, tools=tools
        )
        print(f"\n{result.answer}\n")
