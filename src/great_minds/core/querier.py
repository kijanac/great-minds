"""Query interface for the knowledge base.

Uses Gemma 4 31B via OpenRouter with function calling to navigate the wiki.
Emits structured telemetry via wide events — every query logs which articles
and sources were pulled into context, with timing.
"""

import enum
import json
import uuid
from collections.abc import AsyncGenerator
from dataclasses import asdict, dataclass, field
from typing import Literal
from uuid import UUID

from openai import AsyncOpenAI
from pydantic import BaseModel

from .vaults.config import load_vault_config
from .vaults.prompts import load_prompt
from .search import SearchIndexRepository, SearchService
from .markdown import extract_wiki_link_targets
from .documents.service import SourceDocumentService, WikiArticleService
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
class StreamTrace:
    articles_read: list[str] = field(default_factory=list)
    sources_read: list[str] = field(default_factory=list)
    searches: list[str] = field(default_factory=list)
    llm_rounds: int = 0
    tool_calls_total: int = 0


@dataclass
class ModelRound:
    content: str = ""
    finish_reason: str | None = None
    tool_calls: dict[int, dict] = field(default_factory=dict)


class MalformedToolArgs(ValueError):
    pass


@dataclass
class SourceConsulted:
    """A document the query engine read while answering."""

    kind: str
    path: str
    title: str | None = None


async def _build_sources_consulted(
    vault: "QuerySource",
    source: SourceDocumentService,
    wiki: WikiArticleService,
    articles_read: list[str],
    sources_read: list[str],
) -> list[SourceConsulted]:
    seen: set[str] = set()
    out: list[SourceConsulted] = []
    for path in articles_read:
        if path not in seen:
            seen.add(path)
            title = await wiki.get_title_by_path(vault.vault_id, path)
            out.append(SourceConsulted(kind="wiki", path=path, title=title))
    for path in sources_read:
        if path not in seen:
            seen.add(path)
            title = await source.get_title_by_path(vault.vault_id, path)
            out.append(SourceConsulted(kind="raw", path=path, title=title))
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
            "name": "expand_context",
            "description": (
                "Read the paragraphs surrounding a specific chunk of a "
                "document — use it to see a search_content hit in its fuller "
                "context without loading the whole file. Pass the `path` and "
                "`chunk_index` from a search result. Returns the matched "
                "paragraph plus a few before and after."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "Document path from a search result, e.g. "
                            "raw/texts/lenin/works/1916/imperialism/03.md"
                        ),
                    },
                    "chunk_index": {
                        "type": "integer",
                        "description": "The chunk index from a search result",
                    },
                    "before": {
                        "type": "integer",
                        "description": "Paragraphs before to include (default 2)",
                    },
                    "after": {
                        "type": "integer",
                        "description": "Paragraphs after to include (default 2)",
                    },
                },
                "required": ["path", "chunk_index"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_content",
            "description": (
                "Hybrid text + semantic search across the entire knowledge "
                "base — both raw sources and rendered wiki articles. Indexes "
                "frontmatter title/precis/author alongside body paragraphs, "
                "so this is the right tool for any text-shaped discovery "
                "question. Returns ranked excerpts with paths you can pass "
                "to read_document."
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
                "Filter raw source documents by structured metadata "
                "(tag, author, genre, date). Use when you have a concrete "
                "attribute to narrow by — not for text discovery (use "
                "search_content for that). Wiki articles aren't returned "
                "by this tool; they have no structured-filter dimensions. "
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


def build_tools(tags: list[str]) -> list[dict]:
    """Build the full tool list with vocabulary injected into query_documents."""
    return _BASE_TOOLS + [_build_query_tool(tags)]


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
    if name in ("read_document", "expand_context"):
        path = args["path"]
        doc_type = SourceType.ARTICLE if path.startswith("wiki/") else SourceType.RAW
        return doc_type, {"path": path}
    if name == "search_content":
        return SourceType.SEARCH, {"query": args["query"]}
    if name == "query_documents":
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


async def search_content(
    vault: QuerySource, query: str, source: SourceDocumentService
) -> str:
    """Hybrid BM25 + vector search over the unified content index.

    Indexes both raw sources and rendered wiki articles, including each
    file's frontmatter title/precis/author as a synthetic chunk so
    curator-supplied summary fields are hit alongside body paragraphs.
    """
    svc = SearchService(SearchIndexRepository(source.repo.session))
    results = await svc.search([vault.vault_id], query)

    log_event("tool.search_executed", query=query, results_count=len(results))

    if not results:
        return f"No results found for: {query}"

    parts = []
    for r in results:
        heading = f" — {r.heading}" if r.heading else ""
        parts.append(f"### {r.path} [chunk {r.chunk_index}]{heading}\n{r.snippet}")

    return (
        f"Found {len(results)} results for '{query}'. Each result shows its "
        f"document `path` and `chunk_index` — pass those to expand_context to "
        f"read the surrounding paragraphs, or to read_document for the full "
        f"file.\n\n" + "\n\n".join(parts)
    )


_EXPAND_MAX_EACH = 6  # cap before/after so expand_context can't become a dump


async def expand_context(
    vault: QuerySource,
    path: str,
    chunk_index: int,
    source: SourceDocumentService,
    *,
    before: int = 2,
    after: int = 2,
) -> str:
    """Read the paragraphs around a search hit's chunk.

    Small-to-big retrieval: a search snippet is deliberately tight, so the
    agent widens around it here instead of reading the whole file. Bodies
    are served straight from search_index — no storage round-trip — and
    ``before``/``after`` are clamped so this can't degrade into a dump.
    """
    before = max(0, min(before, _EXPAND_MAX_EACH))
    after = max(0, min(after, _EXPAND_MAX_EACH))
    svc = SearchService(SearchIndexRepository(source.repo.session))
    chunks = await svc.fetch_context_window(
        [vault.vault_id], path, chunk_index, before=before, after=after
    )
    if not chunks:
        log_event("tool.expand_context_empty", path=path, chunk_index=chunk_index)
        return (
            f"No indexed paragraphs found at {path} around chunk {chunk_index}. "
            f"Check the path and chunk_index against a search_content result."
        )

    log_event(
        "tool.expand_context",
        path=path,
        chunk_index=chunk_index,
        returned=len(chunks),
    )
    sections: list[str] = []
    for c in chunks:
        marker = "  ← matched" if c.chunk_index == chunk_index else ""
        heading = f"{c.heading}\n" if c.heading else ""
        sections.append(f"[chunk {c.chunk_index}]{marker}\n{heading}{c.body}")
    header = (
        f"# {path} [{vault.label}] "
        f"(chunks {chunks[0].chunk_index}–{chunks[-1].chunk_index})"
    )
    return f"{header}\n\n" + "\n\n".join(sections)


async def query_documents(
    vault: QuerySource, args: dict, source: SourceDocumentService
) -> str:
    """Structured metadata query over source documents."""
    filters = {
        k: v
        for k, v in {
            "tags": args.get("tags"),
            "author": args.get("author"),
            "genre": args.get("genre"),
            "date_gte": args.get("date_gte"),
            "date_lte": args.get("date_lte"),
            "limit": args.get("limit", 20),
        }.items()
        if v is not None
    }

    results = await source.query_documents([vault.vault_id], **filters)
    log_event("tool.query_executed", filters=str(filters), results_count=len(results))

    if not results:
        return f"No documents match the filters: {json.dumps(filters)}"

    parts = []
    for doc in results:
        tags_str = f"  tags: {', '.join(doc.tags)}" if doc.tags else ""
        meta = f"  [raw] {doc.file_path}"
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


async def _dispatch_tool(
    vault: QuerySource,
    name: str,
    args: dict,
    source: SourceDocumentService,
) -> str:
    if name == "read_document":
        return await read_document(vault, args["path"])
    elif name == "expand_context":
        return await expand_context(
            vault,
            args["path"],
            int(args["chunk_index"]),
            source,
            before=int(args.get("before", 2)),
            after=int(args.get("after", 2)),
        )
    elif name == "search_content":
        return await search_content(vault, args["query"], source)
    elif name == "query_documents":
        return await query_documents(vault, args, source)
    else:
        return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# Client / prompt / chat
# ---------------------------------------------------------------------------


async def _build_identity_for_source(
    source: QuerySource,
    source_svc: SourceDocumentService,
    wiki_svc: WikiArticleService,
) -> str:
    config = await load_vault_config(source.storage)
    wiki_count = await wiki_svc.count(source.vault_id)
    raw_count = await source_svc.count(source.vault_id)

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
1. Use `search_content` for text-shaped discovery — finds matching \
passages across both rendered wiki articles and raw sources, including \
each file's title/precis/author. Each hit carries a `path` and \
`chunk_index`.
2. Use `expand_context(path, chunk_index)` to read the paragraphs around \
a search hit when the snippet is too narrow — more focused and cheaper \
than pulling in the whole document.
3. Use `query_documents` when filtering raw sources by structured \
attributes (tag, author, date, genre). Wiki articles aren't returned by \
this tool — they have no structured-filter dimensions.
4. Read whole documents via `read_document(path)` when you need the full \
text. Paths look like `wiki/<slug>.md` for rendered articles or \
`raw/<content_type>/...` for sources.
5. To verify a claim or get more depth, follow source citations in a \
wiki article to read raw primary texts.

Rules:
- Always ground answers in the actual texts via tools — do not rely on \
your general knowledge.
- If the knowledge base doesn't cover something, say so rather than \
making it up.

Knowledge base:
{identity}"""


async def build_system_prompt(
    vault: "QuerySource",
    source: SourceDocumentService,
    wiki: WikiArticleService,
    *,
    mode: QueryMode = QueryMode.QUERY,
    extra_instructions: str | None = None,
) -> str:
    identity = await _build_identity_for_source(vault, source, wiki) or "(empty vault)"

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


async def _stream_model_round(
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    tools: list[dict],
    state: ModelRound,
) -> AsyncGenerator[dict, None]:
    async for chunk in api_stream(
        client,
        model=model,
        messages=messages,
        tools=tools,
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
            state.finish_reason = choice.finish_reason

        _accumulate_tool_call_deltas(state.tool_calls, delta.tool_calls)

        if delta.content:
            state.content += delta.content
            yield {"event": "token", "data": {"text": delta.content}}


def _accumulate_tool_call_deltas(tool_calls: dict[int, dict], deltas) -> None:
    if not deltas:
        return
    for tc_delta in deltas:
        idx = tc_delta.index
        if idx not in tool_calls:
            tool_calls[idx] = {"id": "", "name": "", "arguments": ""}
        if tc_delta.id:
            tool_calls[idx]["id"] = tc_delta.id
        if not tc_delta.function:
            continue
        if tc_delta.function.name:
            tool_calls[idx]["name"] = tc_delta.function.name
        if tc_delta.function.arguments:
            tool_calls[idx]["arguments"] += tc_delta.function.arguments


def _assistant_tool_message(state: ModelRound) -> dict:
    return {
        "role": "assistant",
        "content": state.content or None,
        "tool_calls": [
            {
                "id": tc["id"],
                "type": "function",
                "function": {
                    "name": tc["name"],
                    "arguments": tc["arguments"],
                },
            }
            for tc in state.tool_calls.values()
        ],
    }


def _parse_tool_args(tool_call: dict) -> dict:
    try:
        return json.loads(tool_call["arguments"])
    except json.JSONDecodeError as exc:
        name = tool_call["name"]
        raise MalformedToolArgs(f"Malformed tool args for {name}") from exc


async def _source_event_for_tool_call(
    vault: QuerySource,
    source: SourceDocumentService,
    wiki: WikiArticleService,
    trace: StreamTrace,
    name: str,
    args: dict,
) -> dict | None:
    classified = _classify_tool_call(name, args)
    if not classified:
        return None

    source_type, meta = classified
    event_data: dict = {"type": source_type, **meta}
    if source_type in (SourceType.ARTICLE, SourceType.RAW):
        path = meta["path"]
        if source_type is SourceType.ARTICLE:
            event_data["title"] = await wiki.get_title_by_path(vault.vault_id, path)
            trace.articles_read.append(path)
        else:
            event_data["title"] = await source.get_title_by_path(vault.vault_id, path)
            trace.sources_read.append(path)
    elif source_type is SourceType.SEARCH:
        trace.searches.append(meta["query"])

    return {"event": "source", "data": event_data}


async def _run_tool_calls(
    vault: QuerySource,
    source: SourceDocumentService,
    wiki: WikiArticleService,
    messages: list[dict],
    trace: StreamTrace,
    tool_calls: dict[int, dict],
) -> AsyncGenerator[dict, None]:
    for tc in tool_calls.values():
        trace.tool_calls_total += 1
        args = _parse_tool_args(tc)
        name = tc["name"]

        source_event = await _source_event_for_tool_call(
            vault, source, wiki, trace, name, args
        )
        if source_event is not None:
            yield source_event

        result = await _dispatch_tool(vault, name, args, source)
        messages.append(
            {
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            }
        )


async def _emit_done(
    vault: QuerySource,
    source: SourceDocumentService,
    wiki: WikiArticleService,
    model: str,
    trace: StreamTrace,
) -> dict:
    enrich(
        model=model,
        articles_read=trace.articles_read,
        sources_read=trace.sources_read,
        searches=trace.searches,
        llm_rounds=trace.llm_rounds,
        tool_calls=trace.tool_calls_total,
    )
    sources = await _build_sources_consulted(
        vault, source, wiki, trace.articles_read, trace.sources_read
    )
    return {
        "event": "done",
        "data": {"sources_consulted": [asdict(s) for s in sources]},
    }


async def stream_chat(
    vault: QuerySource,
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    source: SourceDocumentService,
    wiki: WikiArticleService,
    *,
    tools: list[dict] | None = None,
) -> AsyncGenerator[dict, None]:
    active_tools = tools or _BASE_TOOLS
    trace = StreamTrace()

    while True:
        trace.llm_rounds += 1
        state = ModelRound()

        async for event in _stream_model_round(
            client, model, messages, active_tools, state
        ):
            yield event

        if state.finish_reason == "tool_calls" and state.tool_calls:
            messages.append(_assistant_tool_message(state))
            try:
                async for event in _run_tool_calls(
                    vault, source, wiki, messages, trace, state.tool_calls
                ):
                    yield event
            except MalformedToolArgs as exc:
                yield {"event": "error", "data": {"message": str(exc)}}
                return
            continue

        if state.content:
            messages.append({"role": "assistant", "content": state.content})

        yield await _emit_done(vault, source, wiki, model, trace)
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


async def _load_tools(vault: QuerySource, source: SourceDocumentService) -> list[dict]:
    tags = await source.get_distinct_tags([vault.vault_id])
    return build_tools(tags)


async def run_query(
    vault: QuerySource,
    question: str,
    source: SourceDocumentService,
    wiki: WikiArticleService,
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
        vault, source, wiki, mode=mode, extra_instructions=extra_instructions
    )
    tools = await _load_tools(vault, source)
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
                    vault, client, m, messages, source, wiki, tools=tools
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
        await _finalize_wide_event(source, user_id=user_id, vault_id=vault.vault_id)


async def _finalize_wide_event(
    source: SourceDocumentService,
    *,
    user_id: UUID | None,
    vault_id: UUID | None,
) -> None:
    await record_wide_event_cost(
        source.repo.session, user_id=user_id, vault_id=vault_id
    )
    await source.repo.session.commit()
    emit_wide_event()
