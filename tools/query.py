"""Interactive query interface for the knowledge base.

Uses Gemma 4 31B via OpenRouter with function calling to navigate the wiki.
Emits structured telemetry via wide events — every query logs which articles
and sources were pulled into context, with timing.

Usage:
    OPENROUTER_API_KEY=your-key uv run python tools/query.py
    OPENROUTER_API_KEY=your-key uv run python tools/query.py "What is Lenin's theory of imperialism?"
    OPENROUTER_API_KEY=your-key uv run python tools/query.py --json-logs "question here"
"""

import json
import os
import sys
import uuid
from pathlib import Path

from openai import OpenAI

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from logging_config import (
    correlation_id,
    emit_wide_event,
    enrich,
    init_wide_event,
    log_event,
    setup_logging,
)

WIKI_DIR = Path("wiki")
RAW_DIR = Path("raw/texts")
INDEX_PATH = WIKI_DIR / "_index.md"

DEFAULT_MODEL = "google/gemma-4-31b-it"
FALLBACK_MODELS = [
    "deepseek/deepseek-v3.2",
    "google/gemma-4-31b-it:free",
]
OPENROUTER_BASE = "https://openrouter.ai/api/v1"

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
                "Use the category and slug from the wiki index."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Article category (e.g. economics, thinkers, sociology)",
                    },
                    "slug": {
                        "type": "string",
                        "description": "Article slug (filename without .md)",
                    },
                },
                "required": ["category", "slug"],
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


def read_wiki_article(category: str, slug: str) -> str:
    path = WIKI_DIR / category / f"{slug}.md"
    if not path.exists():
        log_event("tool.article_not_found", category=category, slug=slug)
        return f"Article not found: {category}/{slug}.md"
    content = path.read_text(encoding="utf-8")
    log_event("tool.article_read", category=category, slug=slug, chars=len(content))
    return f"# {category}/{slug}.md\n\n{content}"


def read_raw_source(path_str: str) -> str:
    path = Path(path_str)
    if not path.exists():
        log_event("tool.source_not_found", path=path_str)
        return f"Source not found: {path}"
    content = path.read_text(encoding="utf-8")
    truncated = len(content) > 20_000
    if truncated:
        content = content[:20_000] + "\n\n[...truncated — ask for a specific section if needed...]"
    log_event("tool.source_read", path=path_str, chars=len(content), truncated=truncated)
    return f"# Source: {path}\n\n{content}"


def search_wiki(query: str) -> str:
    query_lower = query.lower()
    results = []

    for category_dir in sorted(WIKI_DIR.iterdir()):
        if not category_dir.is_dir():
            continue
        for article_path in sorted(category_dir.glob("*.md")):
            content = article_path.read_text(encoding="utf-8")
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

                rel_path = article_path.relative_to(WIKI_DIR)
                results.append(f"### {rel_path}\n" + "\n---\n".join(matches))

    log_event("tool.search_executed", query=query, results_count=len(results))

    if not results:
        return f"No results found for: {query}"

    return f"Found {len(results)} articles matching '{query}':\n\n" + "\n\n".join(results)


def handle_tool_call(tool_call) -> str:
    name = tool_call.function.name
    args = json.loads(tool_call.function.arguments)

    if name == "read_wiki_article":
        result = read_wiki_article(args["category"], args["slug"])
        # Track in wide event
        ctx_articles = []
        enrich()  # no-op if no wide event, just ensures we can call it
        return result
    elif name == "read_raw_source":
        return read_raw_source(args["path"])
    elif name == "search_wiki":
        return search_wiki(args["query"])
    else:
        return f"Unknown tool: {name}"


def get_client() -> OpenAI:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Set OPENROUTER_API_KEY environment variable. "
            "Get one at https://openrouter.ai/keys"
        )
    return OpenAI(base_url=OPENROUTER_BASE, api_key=api_key)


def build_system_prompt() -> str:
    if INDEX_PATH.exists():
        index = INDEX_PATH.read_text(encoding="utf-8")
    else:
        entries = []
        for category_dir in sorted(WIKI_DIR.iterdir()):
            if not category_dir.is_dir():
                continue
            for article_path in sorted(category_dir.glob("*.md")):
                entries.append(f"  - {category_dir.name}/{article_path.stem}")
        index = "\n".join(entries) if entries else "(no articles yet)"

    return SYSTEM_PROMPT.format(index=index)


def chat(client: OpenAI, model: str, messages: list[dict]) -> str:
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
            extra_body={
                "provider": {
                    "allow_fallbacks": True,
                    "sort": "throughput",
                },
            },
        )

        choice = response.choices[0]
        message = choice.message

        if not message.tool_calls:
            messages.append({"role": "assistant", "content": message.content})
            # Finalize wide event with accumulated data
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

        # Process tool calls
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

            # Track what gets pulled into context
            if name == "read_wiki_article":
                articles_read.append(f"wiki/{args['category']}/{args['slug']}.md")
            elif name == "read_raw_source":
                sources_read.append(args["path"])
            elif name == "search_wiki":
                searches.append(args["query"])

            result = handle_tool_call(tc)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })


def chat_with_fallback(client: OpenAI, model: str, messages: list[dict]) -> str:
    """Try the primary model, fall back to alternatives on rate limit."""
    models_to_try = [model] + [m for m in FALLBACK_MODELS if m != model]

    for m in models_to_try:
        try:
            return chat(client, m, messages)
        except Exception as e:
            if "429" in str(e) or "rate" in str(e).lower():
                log_event("query.rate_limited", model=m)
                print(f"  (rate limited on {m}, trying next...)")
                continue
            raise

    raise RuntimeError("all models rate limited — try again in a minute")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Query the knowledge base")
    parser.add_argument("question", nargs="*", help="Question to ask (omit for interactive mode)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Model to use (default: {DEFAULT_MODEL})")
    parser.add_argument("--json-logs", action="store_true", help="Output structured JSON logs to stderr")
    args = parser.parse_args()

    setup_logging(service="great-minds", json_output=args.json_logs)

    client = get_client()
    model = args.model
    system_prompt = build_system_prompt()
    messages = [{"role": "system", "content": system_prompt}]

    # Single question mode
    if args.question:
        question = " ".join(args.question)
        query_id = f"q-{uuid.uuid4().hex[:8]}"
        correlation_id.set(query_id)
        init_wide_event("query", question=question)

        messages.append({"role": "user", "content": question})
        print(f"\n> {question}\n")
        answer = chat_with_fallback(client, model, messages)
        print(answer)
        return

    # Interactive mode
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
        answer = chat_with_fallback(client, model, messages)
        print(f"\n{answer}\n")


if __name__ == "__main__":
    main()
