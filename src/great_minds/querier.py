"""Query interface for the knowledge base.

Uses Gemma 4 31B via OpenRouter with function calling to navigate the wiki.
Emits structured telemetry via wide events — every query logs which articles
and sources were pulled into context, with timing.
"""


import json
import uuid
from collections.abc import AsyncGenerator

from openai import AsyncOpenAI, OpenAI

from .llm import EXTRACT_MODEL, FALLBACK_MODELS, get_async_client, get_sync_client
from .storage import Storage
from .telemetry import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    log_event,
)

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


def read_wiki_article(storage: Storage, slug: str) -> str:
    path = f"wiki/{slug}.md"
    content = storage.read(path, default=None)
    if content is None:
        log_event("tool.article_not_found", slug=slug)
        return f"Article not found: {path}"
    log_event("tool.article_read", slug=slug, chars=len(content))
    return f"# {path}\n\n{content}"


def read_raw_source(storage: Storage, path_str: str) -> str:
    content = storage.read(path_str, default=None)
    if content is None:
        log_event("tool.source_not_found", path=path_str)
        return f"Source not found: {path_str}"
    truncated = len(content) > 20_000
    if truncated:
        content = content[:20_000] + "\n\n[...truncated — ask for a specific section if needed...]"
    log_event("tool.source_read", path=path_str, chars=len(content), truncated=truncated)
    return f"# Source: {path_str}\n\n{content}"


def search_wiki(storage: Storage, query: str) -> str:
    query_lower = query.lower()
    results = []

    for path in storage.glob("wiki/*.md"):
        filename = path.rsplit("/", 1)[-1]
        if filename.startswith("_"):
            continue
        content = storage.read(path)
        if query_lower in content.lower():
            lines = content.split("\n")
            matches = []
            for i, line in enumerate(lines):
                if query_lower in line.lower():
                    start = max(0, i - 1)
                    end = min(len(lines), i + 2)
                    snippet = "\n".join(lines[start:end])
                    matches.append(snippet)
                    if len(matches) >= 2:
                        break

            results.append(f"### {filename}\n" + "\n---\n".join(matches))

    log_event("tool.search_executed", query=query, results_count=len(results))

    if not results:
        return f"No results found for: {query}"

    return f"Found {len(results)} articles matching '{query}':\n\n" + "\n\n".join(results)


def _dispatch_tool(storage: Storage, name: str, args: dict) -> str:
    if name == "read_wiki_article":
        return read_wiki_article(storage, args["slug"])
    elif name == "read_raw_source":
        return read_raw_source(storage, args["path"])
    elif name == "search_wiki":
        return search_wiki(storage, args["query"])
    else:
        return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# Client / prompt / chat
# ---------------------------------------------------------------------------


def build_system_prompt(storage: Storage) -> str:
    index = storage.read("wiki/_index.md", default=None)
    if index is None:
        entries = []
        for path in storage.glob("wiki/*.md"):
            filename = path.rsplit("/", 1)[-1]
            if not filename.startswith("_"):
                stem = filename.removesuffix(".md")
                entries.append(f"  - {stem}")
        index = "\n".join(entries) if entries else "(no articles yet)"

    return SYSTEM_PROMPT.format(index=index)


def chat(storage: Storage, client: OpenAI, model: str, messages: list[dict]) -> str:
    """Run a chat turn, handling tool calls in a loop until the model responds with text."""
    articles_read: list[str] = []
    sources_read: list[str] = []
    searches: list[str] = []
    llm_rounds = 0
    tool_calls_total = 0

    while True:
        llm_rounds += 1
        response = client.chat.completions.create(
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

            result = _dispatch_tool(storage, name, args)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })


def chat_with_fallback(storage: Storage, client: OpenAI, model: str, messages: list[dict]) -> str:
    """Try the primary model, fall back to alternatives on rate limit."""
    for m in _models_with_fallback(model):
        try:
            return chat(storage, client, m, messages)
        except Exception as e:
            if _is_rate_limited(e):
                log_event("query.rate_limited", model=m)
                print(f"  (rate limited on {m}, trying next...)")
                continue
            raise

    raise RuntimeError("all models rate limited — try again in a minute")


# ---------------------------------------------------------------------------
# Async streaming chat (for SSE endpoint)
# ---------------------------------------------------------------------------


async def stream_chat(
    storage: Storage,
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
) -> AsyncGenerator[dict, None]:
    """Yield SSE event dicts as the model traverses the knowledge base.

    Tool-call rounds: content is buffered and yielded as a single "thinking"
    event, followed by "source" events for each tool call. This keeps the
    model's intermediate reasoning separate from the final answer.

    Final round: content is yielded as "token" events in small chunks for
    progressive rendering.

    Events:
      {"event": "thinking", "data": {"text": "..."}}
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

        # Tool-call round: buffer content as "thinking", yield sources
        if finish_reason == "tool_calls" and tool_calls_acc:
            if content_acc.strip():
                yield {"event": "thinking", "data": {"text": content_acc}}

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

                result = _dispatch_tool(storage, name, args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                })

            continue

        # Final answer round: yield content in chunks for progressive rendering
        if content_acc:
            messages.append({"role": "assistant", "content": content_acc})
            chunk_size = 20
            for i in range(0, len(content_acc), chunk_size):
                yield {"event": "token", "data": {"text": content_acc[i:i + chunk_size]}}

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



async def run_stream_query(
    storage: Storage,
    question: str,
    *,
    model: str | None = None,
) -> AsyncGenerator[dict, None]:
    """Stream SSE events for a single question, with model fallback on rate limit."""
    primary = model or EXTRACT_MODEL
    client = get_async_client(max_retries=0)
    system_prompt = build_system_prompt(storage)
    base_messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": question},
    ]

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query.stream", question=question)

    for m in _models_with_fallback(primary):
        messages = list(base_messages)
        try:
            async for event in stream_chat(storage, client, m, messages):
                yield event
            return
        except Exception as e:
            if _is_rate_limited(e):
                log_event("query.stream_rate_limited", model=m)
                continue
            yield {"event": "error", "data": {"message": str(e)}}
            return

    yield {"event": "error", "data": {"message": "all models rate limited — try again in a minute"}}


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def run_query(storage: Storage, question: str, *, model: str | None = None) -> str:
    """Answer a single question against the knowledge base.

    Sets up the OpenRouter client, builds the system prompt, runs chat with
    fallback models, and returns the answer string. Caller is responsible
    for calling setup_logging() before this.
    """
    model = model or EXTRACT_MODEL
    client = get_sync_client()
    system_prompt = build_system_prompt(storage)
    messages: list[dict] = [{"role": "system", "content": system_prompt}]

    query_id = f"q-{uuid.uuid4().hex[:8]}"
    correlation_id.set(query_id)
    init_wide_event("query", question=question)

    messages.append({"role": "user", "content": question})
    return chat_with_fallback(storage, client, model, messages)


def run_interactive(storage: Storage, *, model: str | None = None) -> None:
    """Run an interactive REPL session against the knowledge base.

    Caller is responsible for calling setup_logging() before this.
    """
    model = model or EXTRACT_MODEL
    client = get_sync_client()
    system_prompt = build_system_prompt(storage)
    messages: list[dict] = [{"role": "system", "content": system_prompt}]

    print(f"Knowledge Base — Query Interface (model: {model})")
    print("Type your question, or 'quit' to exit.\n")

    while True:
        try:
            question = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not question or question.lower() in ("quit", "exit", "q"):
            break

        query_id = f"q-{uuid.uuid4().hex[:8]}"
        correlation_id.set(query_id)
        init_wide_event("query", question=question)

        messages.append({"role": "user", "content": question})
        answer = chat_with_fallback(storage, client, model, messages)
        print(f"\n{answer}\n")
