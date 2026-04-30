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
from typing import Literal
from uuid import UUID

from openai import AsyncOpenAI
from pydantic import BaseModel

from .brain import load_prompt
from .brain_config import load_brain_config
from .paths import wiki_slug
from .search import search as hybrid_search
from .markdown import extract_wiki_link_targets
from .documents.repository import DocumentRepository
from .documents.schemas import DocKind
from .llm import FALLBACK_MODELS, QUERY_MODEL, get_async_client
from .llm_costs import record_wide_event_cost
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


@dataclass
class ChatResult:
    """Answer text plus provenance metadata."""

    answer: str
    sources_consulted: list[SourceConsulted]


async def _build_sources_consulted(
    brain: "QuerySource",
    doc_repo: DocumentRepository,
    articles_read: list[str],
    sources_read: list[str],
) -> list[SourceConsulted]:
    seen: set[str] = set()
    out: list[SourceConsulted] = []
    for path in articles_read:
        if path not in seen:
            seen.add(path)
            title = await doc_repo.get_title_by_path(brain.brain_id, path)
            out.append(SourceConsulted(kind=DocKind.WIKI, path=path, title=title))
    for path in sources_read:
        if path not in seen:
            seen.add(path)
            title = await doc_repo.get_title_by_path(brain.brain_id, path)
            out.append(SourceConsulted(kind=DocKind.RAW, path=path, title=title))
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


async def read_document(brain: QuerySource, path: str) -> str:
    content = await brain.storage.read(path, strict=False)
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
        brain=brain.label,
        chars=len(content),
        truncated=truncated,
    )
    forward_links = extract_wiki_link_targets(content)
    links_section = (
        "\n\n---\nForward links: " + ", ".join(forward_links) if forward_links else ""
    )
    return f"# {path} [{brain.label}]\n\n{content}{links_section}"


async def read_document_enriched(
    brain: QuerySource, path: str, doc_repo: DocumentRepository
) -> str:
    """Read a document.

    Backlinks will be attached here once the retrieval surface consumes
    verify's document-keyed backlinks table. Until then this is a straight
    pass-through to read_document.
    """
    return await read_document(brain, path)


async def search_wiki(
    brain: QuerySource, query: str, doc_repo: DocumentRepository
) -> str:
    """Hybrid BM25 + vector search via the search index."""
    results = await hybrid_search(doc_repo.session, [brain.brain_id], query)

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
    brain: QuerySource, args: dict, doc_repo: DocumentRepository
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

    results = await doc_repo.query_documents([brain.brain_id], **filters)
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
    brain: QuerySource, args: dict, doc_repo: DocumentRepository
) -> str:
    """Structured query over the wiki article registry.

    Pulls title + precis straight from the documents table — the DB is
    the authoritative registry, populated by ingest and enriched by
    extract. Avoids globbing storage and re-parsing frontmatter on every
    tool call.
    """
    slug_filter = args.get("slug")
    query_str = (args.get("query") or "").strip().lower()
    limit = args.get("limit") or 20

    docs = await doc_repo.list_by_kind(brain.brain_id, DocKind.WIKI)
    rows: list[tuple[str, str, str]] = []
    for doc in docs:
        slug = wiki_slug(doc.file_path)
        if slug.startswith("_"):
            continue
        if slug_filter and slug != slug_filter:
            continue
        title = doc.metadata.title
        description = doc.metadata.precis or ""
        if (
            query_str
            and query_str not in title.lower()
            and query_str not in description.lower()
        ):
            continue
        rows.append((slug, title, description))
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
        for slug, title, description in rows
    ]
    return f"Found {len(rows)} wiki articles:\n\n" + "\n\n".join(parts)


async def _dispatch_tool(
    brain: QuerySource, name: str, args: dict, doc_repo: DocumentRepository
) -> str:
    if name == "read_document":
        return await read_document_enriched(brain, args["path"], doc_repo)
    elif name == "search_wiki":
        return await search_wiki(brain, args["query"], doc_repo)
    elif name == "query_documents":
        return await query_documents(brain, args, doc_repo)
    elif name == "query_wiki_articles":
        return await query_wiki_articles(brain, args, doc_repo)
    else:
        return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# Client / prompt / chat
# ---------------------------------------------------------------------------


async def _build_identity_for_source(
    source: QuerySource, doc_repo: DocumentRepository
) -> str:
    """Render a per-brain identity block for the system prompt.

    Identity gives the agent shape awareness (brain name, editorial
    focus, corpus size) without listing every article. Article-level
    discovery happens via tools: search_wiki, query_wiki_articles,
    query_documents.
    """
    config = await load_brain_config(source.storage)
    wiki_count = await doc_repo.count_by_kind(source.brain_id, DocKind.WIKI)
    raw_count = await doc_repo.count_by_kind(source.brain_id, DocKind.RAW)

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
    brain: "QuerySource",
    doc_repo: DocumentRepository,
    *,
    mode: QueryMode = QueryMode.QUERY,
    extra_instructions: str | None = None,
) -> str:
    identity = await _build_identity_for_source(brain, doc_repo) or "(empty brain)"

    # Layer 1: retrieval discipline (not overridable)
    prompt = _RETRIEVAL_CORE.format(identity=identity)

    # Layer 2: per-brain default persona
    prompt += "\n\n" + await load_prompt(brain.storage, "query")

    if mode == QueryMode.BTW:
        prompt += "\n\n" + await load_prompt(brain.storage, "query_btw")

    # Layer 3: per-request consumer instructions
    if extra_instructions:
        prompt += "\n\n" + extra_instructions

    return prompt


async def chat(
    brain: QuerySource,
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
            return ChatResult(
                answer=message.content,
                sources_consulted=await _build_sources_consulted(
                    brain, doc_repo, articles_read, sources_read
                ),
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

            result = await _dispatch_tool(brain, name, args, doc_repo)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                }
            )


async def chat_with_fallback(
    brain: QuerySource,
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
            return await chat(brain, client, m, messages, doc_repo, tools=tools)
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
    brain: QuerySource,
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
                    event_data: dict = {"type": source_type, **meta}
                    if source_type in (SourceType.ARTICLE, SourceType.RAW):
                        event_data["title"] = await doc_repo.get_title_by_path(
                            brain.brain_id, meta["path"]
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

                result = await _dispatch_tool(brain, name, args, doc_repo)
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
            brain, doc_repo, articles_read, sources_read
        )
        yield {
            "event": "done",
            "data": {
                "sources_consulted": [asdict(s) for s in sources],
            },
        }
        return


async def _build_origin_messages(
    brain: QuerySource,
    origin_path: str,
) -> list[dict]:
    """Build synthetic tool-call messages that pre-load the origin document."""
    content = await read_document(brain, origin_path)
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


async def _load_tools(
    brain: QuerySource, doc_repo: DocumentRepository
) -> list[dict]:
    """Load tag vocabulary from DB and build the full tool list."""
    tags = await doc_repo.get_distinct_tags([brain.brain_id])
    return build_tools(tags)


async def run_stream_query(
    brain: QuerySource,
    question: str,
    doc_repo: DocumentRepository,
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
        brain, doc_repo, mode=mode, extra_instructions=extra_instructions
    )
    tools = await _load_tools(brain, doc_repo)
    base_messages: list[dict] = [
        {"role": "system", "content": system_prompt},
    ]
    if origin_path:
        base_messages.extend(await _build_origin_messages(brain, origin_path))
    if history:
        base_messages.extend(m.model_dump() for m in history)
    base_messages.append({"role": "user", "content": question})

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query.stream", question=question, brain_id=str(brain.brain_id))

    try:
        for m in _models_with_fallback(primary):
            messages = list(base_messages)
            try:
                async for event in stream_chat(
                    brain, client, m, messages, doc_repo, tools=tools
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
    finally:
        await _finalize_wide_event(doc_repo, user_id=user_id, brain_id=brain.brain_id)


async def run_query(
    brain: QuerySource,
    question: str,
    doc_repo: DocumentRepository,
    *,
    user_id: UUID | None = None,
    model: str | None = None,
    origin_path: str | None = None,
    history: list[HistoryMessage] | None = None,
    mode: QueryMode = QueryMode.QUERY,
    extra_instructions: str | None = None,
) -> ChatResult:
    """Answer a single question against the knowledge base."""
    primary = model or QUERY_MODEL
    client = get_async_client()
    system_prompt = await build_system_prompt(
        brain, doc_repo, mode=mode, extra_instructions=extra_instructions
    )
    tools = await _load_tools(brain, doc_repo)
    messages: list[dict] = [{"role": "system", "content": system_prompt}]

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query", question=question, brain_id=str(brain.brain_id))

    try:
        if origin_path:
            messages.extend(await _build_origin_messages(brain, origin_path))
        if history:
            messages.extend(m.model_dump() for m in history)
        messages.append({"role": "user", "content": question})
        return await chat_with_fallback(
            brain, client, primary, messages, doc_repo, tools=tools
        )
    finally:
        await _finalize_wide_event(doc_repo, user_id=user_id, brain_id=brain.brain_id)


async def run_interactive(
    brain: QuerySource,
    doc_repo: DocumentRepository,
    *,
    model: str | None = None,
) -> None:
    """Run an interactive REPL session against the knowledge base."""
    model = model or QUERY_MODEL
    client = get_async_client()
    system_prompt = await build_system_prompt(brain, doc_repo)
    tools = await _load_tools(brain, doc_repo)
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
        try:
            result = await chat_with_fallback(
                brain, client, model, messages, doc_repo, tools=tools
            )
        finally:
            await _finalize_wide_event(doc_repo, user_id=None, brain_id=brain.brain_id)
        print(f"\n{result.answer}\n")


async def _finalize_wide_event(
    doc_repo: DocumentRepository,
    *,
    user_id: UUID | None,
    brain_id: UUID | None,
) -> None:
    """Persist accumulated cost as one cost row, then emit the wide event.

    Pulls the same in-memory accumulator the log entry will read, so the
    persisted row and the structured-log event carry identical numbers.
    """
    await record_wide_event_cost(
        doc_repo.session, user_id=user_id, brain_id=brain_id
    )
    await doc_repo.session.commit()
    emit_wide_event()
