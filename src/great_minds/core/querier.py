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
from dataclasses import dataclass
from uuid import UUID

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from .brains._search_indexer import search as hybrid_search
from .llm import FALLBACK_MODELS, QUERY_MODEL, get_async_client
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


@dataclass
class QuerySource:
    """A labeled storage that the query engine can search across."""
    storage: Storage
    label: str
    brain_id: UUID | None = None

SYSTEM_PROMPT = """\
You are a research assistant for a knowledge base. \
You help users explore and understand the corpus of texts and wiki articles.

You have access to tools that let you read wiki articles and raw source documents. \
Use them to ground your answers in the actual texts.

Approach:
1. When asked a question, first consider which wiki articles are relevant \
based on the index below.
2. Read the relevant articles using the read_wiki_article tool.
3. If you need more detail or want to verify a claim, follow the source \
citations in the wiki article to read the raw primary texts.
4. Synthesize your answer, always citing which wiki articles and/or raw \
sources you're drawing from.

Rules:
- Always ground claims in the actual texts — don't rely on your general knowledge. Use the tools.
- When summarizing a position, note whose position it is and which text it comes from.
- When positions are in tension or contradiction, say so explicitly.
- If the knowledge base doesn't cover something, say so rather than making it up.

Current wiki index:
{index}
"""

BTW_ADDENDUM = """\

This is a BTW (by the way) — a quick side question the user is asking while \
reading. Answer concisely in 2-3 short paragraphs. Cite the most relevant \
sources. Be direct.
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_wiki_article",
            "description": (
                "Read a wiki article from the knowledge base. "
                "Use the slug from the wiki index."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {
                        "type": "string",
                        "description": "Article slug (filename without .md)",
                    },
                },
                "required": ["slug"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_raw_source",
            "description": (
                "Read a raw primary source document. Use paths from the "
                "Sources or footnotes section of wiki articles."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "Path to the raw source file, e.g. "
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
                "Search across all wiki articles for a term or phrase. "
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

PROVIDER_EXTRA_BODY = {
    "provider": {
        "allow_fallbacks": True,
        "sort": "throughput",
    },
}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _is_rate_limited(exc: Exception) -> bool:
    msg = str(exc)
    return "429" in msg or "rate" in msg.lower()


def _models_with_fallback(primary: str) -> list[str]:
    return [primary] + [m for m in FALLBACK_MODELS if m != primary]


def _classify_tool_call(name: str, args: dict) -> tuple[str, dict]:
    """Return (source_type, metadata) for telemetry and SSE source events."""
    if name == "read_wiki_article":
        return "article", {"slug": args["slug"]}
    elif name == "read_raw_source":
        return "raw", {"path": args["path"]}
    elif name == "search_wiki":
        return "search", {"query": args["query"]}
    return "unknown", {}


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def read_wiki_article(brains: list[QuerySource], slug: str) -> str:
    path = f"wiki/{slug}.md"
    for src in brains:
        content = src.storage.read(path, strict=False)
        if content is not None:
            log_event("tool.article_read", slug=slug, brain=src.label, chars=len(content))
            return f"# {path} [{src.label}]\n\n{content}"
    log_event("tool.article_not_found", slug=slug)
    return f"Article not found: {path}"


def read_raw_source(brains: list[QuerySource], path_str: str) -> str:
    for src in brains:
        content = src.storage.read(path_str, strict=False)
        if content is not None:
            truncated = len(content) > 20_000
            if truncated:
                content = content[:20_000] + "\n\n[...truncated — ask for a specific section if needed...]"
            log_event("tool.source_read", path=path_str, brain=src.label, chars=len(content), truncated=truncated)
            return f"# Source: {path_str} [{src.label}]\n\n{content}"
    log_event("tool.source_not_found", path=path_str)
    return f"Source not found: {path_str}"


async def search_wiki(brains: list[QuerySource], query: str, session: AsyncSession) -> str:
    """Hybrid BM25 + vector search across all brains via the search index."""
    brain_ids = [src.brain_id for src in brains if src.brain_id is not None]
    if not brain_ids:
        log_event("tool.search_skipped", query=query, reason="no_brain_ids")
        return f"No results found for: {query} (search index not available)"

    results = await hybrid_search(session, brain_ids, query)

    log_event("tool.search_executed", query=query, results_count=len(results))

    if not results:
        return f"No results found for: {query}"

    parts = []
    for r in results:
        filename = r.path.rsplit("/", 1)[-1]
        heading = f" > {r.heading}" if r.heading else ""
        parts.append(f"### {filename}{heading}\n{r.snippet}")

    return f"Found {len(results)} results for '{query}':\n\n" + "\n\n".join(parts)


async def _dispatch_tool(brains: list[QuerySource], name: str, args: dict, session: AsyncSession) -> str:
    if name == "read_wiki_article":
        return read_wiki_article(brains, args["slug"])
    elif name == "read_raw_source":
        return read_raw_source(brains, args["path"])
    elif name == "search_wiki":
        return await search_wiki(brains, args["query"], session)
    else:
        return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# Client / prompt / chat
# ---------------------------------------------------------------------------


def _build_index_for_source(source: QuerySource) -> str:
    index = source.storage.read("wiki/_index.md", strict=False)
    if index is not None:
        return f"## [{source.label}]\n{index}"
    entries = []
    for path in source.storage.glob("wiki/*.md"):
        filename = path.rsplit("/", 1)[-1]
        if not filename.startswith("_"):
            stem = filename.removesuffix(".md")
            entries.append(f"  - {stem}")
    if entries:
        return f"## [{source.label}]\n" + "\n".join(entries)
    return ""


def build_system_prompt(brains: "list[QuerySource]", *, mode: QueryMode = QueryMode.QUERY) -> str:
    parts = [_build_index_for_source(b) for b in brains]
    index = "\n\n".join(p for p in parts if p) or "(no articles yet)"
    prompt = SYSTEM_PROMPT.format(index=index)
    if mode == QueryMode.BTW:
        prompt += BTW_ADDENDUM
    return prompt


async def chat(
    brains: list[QuerySource],
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    session: AsyncSession,
) -> str:
    """Run a chat turn, handling tool calls in a loop until the model responds with text."""
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
            tools=TOOLS,
            temperature=0.3,
            extra_body=PROVIDER_EXTRA_BODY,
        )

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
            return message.content

        messages.append({
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
        })

        for tc in message.tool_calls:
            tool_calls_total += 1
            name = tc.function.name
            args = json.loads(tc.function.arguments)

            source_type, _meta = _classify_tool_call(name, args)
            if source_type == "article":
                articles_read.append(f"wiki/{args['slug']}.md")
            elif source_type == "raw":
                sources_read.append(args["path"])
            elif source_type == "search":
                searches.append(args["query"])

            result = await _dispatch_tool(brains, name, args, session)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })


async def chat_with_fallback(
    brains: list[QuerySource],
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    session: AsyncSession,
) -> str:
    """Try the primary model, fall back to alternatives on rate limit."""
    for m in _models_with_fallback(model):
        try:
            return await chat(brains, client, m, messages, session)
        except Exception as e:
            if _is_rate_limited(e):
                log_event("query.rate_limited", model=m)
                continue
            raise

    raise RuntimeError("all models rate limited — try again in a minute")


# ---------------------------------------------------------------------------
# Async streaming chat (for SSE endpoint)
# ---------------------------------------------------------------------------


async def stream_chat(
    brains: list[QuerySource],
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    session: AsyncSession,
) -> AsyncGenerator[dict, None]:
    """Yield SSE event dicts as the model traverses the knowledge base.

    Events:
      {"event": "source",   "data": {"type": "article"|"raw"|"search", ...}}
      {"event": "token",    "data": {"text": "..."}}
      {"event": "done",     "data": {}}
      {"event": "error",    "data": {"message": "..."}}
    """
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
            tools=TOOLS,
            temperature=0.3,
            stream=True,
            extra_body=PROVIDER_EXTRA_BODY,
        )

        tool_calls_acc: dict[int, dict] = {}
        content_acc = ""
        finish_reason = None

        async for chunk in stream:
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
                            tool_calls_acc[idx]["arguments"] += tc_delta.function.arguments

            if delta.content:
                content_acc += delta.content
                yield {"event": "token", "data": {"text": delta.content}}

        if finish_reason == "tool_calls" and tool_calls_acc:
            messages.append({
                "role": "assistant",
                "content": content_acc or None,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": tc["arguments"]},
                    }
                    for tc in tool_calls_acc.values()
                ],
            })

            for tc in tool_calls_acc.values():
                tool_calls_total += 1
                try:
                    args = json.loads(tc["arguments"])
                except json.JSONDecodeError:
                    yield {"event": "error", "data": {"message": f"Malformed tool args for {tc['name']}"}}
                    return
                name = tc["name"]

                source_type, meta = _classify_tool_call(name, args)
                yield {"event": "source", "data": {"type": source_type, **meta}}

                if source_type == "article":
                    articles_read.append(f"wiki/{meta['slug']}.md")
                elif source_type == "raw":
                    sources_read.append(meta["path"])
                elif source_type == "search":
                    searches.append(meta["query"])

                result = await _dispatch_tool(brains, name, args, session)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                })

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
        yield {"event": "done", "data": {}}
        return


def _build_origin_messages(
    brains: list[QuerySource], origin_slug: str,
) -> list[dict]:
    """Build synthetic tool-call messages that pre-load an origin article."""
    content = read_wiki_article(brains, origin_slug)
    tool_call_id = f"origin-{uuid.uuid4().hex[:8]}"
    return [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": "read_wiki_article",
                    "arguments": json.dumps({"slug": origin_slug}),
                },
            }],
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


async def run_stream_query(
    brains: list[QuerySource],
    question: str,
    session: AsyncSession,
    *,
    model: str | None = None,
    origin_slug: str | None = None,
    session_context: str | None = None,
    mode: QueryMode = QueryMode.QUERY,
) -> AsyncGenerator[dict, None]:
    """Stream SSE events for a single question, with model fallback on rate limit."""
    primary = model or QUERY_MODEL
    client = get_async_client(max_retries=0)
    system_prompt = build_system_prompt(brains, mode=mode)
    base_messages: list[dict] = [
        {"role": "system", "content": system_prompt},
    ]
    if origin_slug:
        base_messages.extend(_build_origin_messages(brains, origin_slug))
    if session_context:
        base_messages.extend(_build_session_context_messages(session_context))
    base_messages.append({"role": "user", "content": question})

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query.stream", question=question, brain_count=len(brains))

    for m in _models_with_fallback(primary):
        messages = list(base_messages)
        try:
            async for event in stream_chat(brains, client, m, messages, session):
                yield event
            return
        except Exception as e:
            if _is_rate_limited(e):
                log_event("query.stream_rate_limited", model=m)
                continue
            yield {"event": "error", "data": {"message": str(e)}}
            return

    yield {"event": "error", "data": {"message": "all models rate limited — try again in a minute"}}


async def run_query(
    brains: list[QuerySource],
    question: str,
    session: AsyncSession,
    *,
    model: str | None = None,
    origin_slug: str | None = None,
    session_context: str | None = None,
    mode: QueryMode = QueryMode.QUERY,
) -> str:
    """Answer a single question against the knowledge base."""
    primary = model or QUERY_MODEL
    client = get_async_client()
    system_prompt = build_system_prompt(brains, mode=mode)
    messages: list[dict] = [{"role": "system", "content": system_prompt}]

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query", question=question, brain_count=len(brains))

    if origin_slug:
        messages.extend(_build_origin_messages(brains, origin_slug))
    if session_context:
        messages.extend(_build_session_context_messages(session_context))
    messages.append({"role": "user", "content": question})
    return await chat_with_fallback(brains, client, primary, messages, session)


async def run_interactive(
    brains: list[QuerySource],
    session: AsyncSession,
    *,
    model: str | None = None,
) -> None:
    """Run an interactive REPL session against the knowledge base."""
    model = model or QUERY_MODEL
    client = get_async_client()
    system_prompt = build_system_prompt(brains)
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
        answer = await chat_with_fallback(brains, client, model, messages, session)
        print(f"\n{answer}\n")
