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
from .search import Chunk, SearchService
from .documents.schemas import WikiArticleOverview
from .documents.service import SourceDocumentService, WikiArticleService
from .llm import QUERY_MODEL
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


_BASE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": (
                "Read a document by path. A small document is returned in "
                "full; a large document returns its section outline (headings "
                "with chunk ranges) instead, so you can then read a section "
                "with expand_context(path, start, end). Works for wiki "
                "articles (wiki/capitalism.md) and raw sources "
                "(raw/texts/lenin/works/1893/market/02.md)."
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
                "Read a range of a document's paragraphs without loading the "
                "whole file — use it to read around a search hit or to read a "
                "section from a document outline. Pass a `path` and a "
                "`start`/`end` chunk range."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "Document path from a search result or outline, "
                            "e.g. raw/texts/lenin/works/1916/imperialism/03.md"
                        ),
                    },
                    "start": {
                        "type": "integer",
                        "description": "First chunk index to read (inclusive)",
                    },
                    "end": {
                        "type": "integer",
                        "description": "Last chunk index to read (inclusive)",
                    },
                },
                "required": ["path", "start", "end"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "linked_articles",
            "description": (
                "List the wiki articles a given article links to (outgoing) "
                "and that link to it (incoming) — follow connections between "
                "articles without reading their full text. Pass a wiki "
                "article path, e.g. wiki/imperialism.md."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "Wiki article path, e.g. wiki/imperialism.md "
                            "(from a search hit or another article's links)"
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
# Retrieval discipline + stateless helpers
# ---------------------------------------------------------------------------


_READ_WHOLE_LIMIT = 20_000  # docs at or under this many chars are returned whole
_MAX_RANGE_CHUNKS = 40  # cap one expand_context read so it can't dump a document


_RETRIEVAL_CORE = """\
You have access to tools that let you search and read documents in the \
knowledge base. Use them to answer questions based on the actual texts.

Approach:
1. Use `search_content` for text-shaped discovery — finds matching \
passages across both rendered wiki articles and raw sources, including \
each file's title/precis/author. Each hit carries a `path` and \
`chunk_index`.
2. Use `expand_context(path, start, end)` to read a range of paragraphs \
— around a search hit, or a section listed in a document outline.
3. Use `query_documents` when filtering raw sources by structured \
attributes (tag, author, date, genre). Wiki articles aren't returned by \
this tool — they have no structured-filter dimensions.
4. Use `read_document(path)` to read a whole document; for a large \
document this returns a section outline instead, which you then read \
section-by-section with `expand_context`. Paths look like \
`wiki/<slug>.md` for rendered articles or `raw/<content_type>/...` for \
sources.
5. Use `linked_articles(path)` to see which wiki articles an article \
cites and is cited by — follow connections between articles without \
reading their full text.
6. To verify a claim or get more depth, follow source citations in a \
wiki article to read raw primary texts.

Rules:
- Always ground answers in the actual texts via tools — do not rely on \
your general knowledge.
- If the knowledge base doesn't cover something, say so rather than \
making it up.

Knowledge base:
{identity}"""


def _render_chunk_window(path: str, label: str, chunks: list[Chunk]) -> str:
    """Render a contiguous run of indexed chunks as readable text."""
    sections: list[str] = []
    for c in chunks:
        heading = f"{c.heading}\n" if c.heading else ""
        sections.append(f"[chunk {c.chunk_index}]\n{heading}{c.body}")
    header = (
        f"# {path} [{label}] (chunks {chunks[0].chunk_index}–{chunks[-1].chunk_index})"
    )
    return f"{header}\n\n" + "\n\n".join(sections)


def _format_links(links: list[WikiArticleOverview]) -> str:
    """Render a list of article links as markdown bullets, or 'none'."""
    return "\n".join(f"- [{a.title}]({a.file_path})" for a in links) or "none"


def _parse_tool_args(tool_call: dict) -> dict:
    try:
        return json.loads(tool_call["arguments"])
    except json.JSONDecodeError as exc:
        name = tool_call["name"]
        raise MalformedToolArgs(f"Malformed tool args for {name}") from exc


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


# ---------------------------------------------------------------------------
# Query engine
# ---------------------------------------------------------------------------


class QueryEngine:
    """Answers questions over one vault by navigating it with tools.

    Constructed per request with its collaborators — file ``storage``, the
    DB-backed document/wiki/search services, and the LLM ``client`` — plus
    the vault's id and display label. Decoupled from the Vault ORM, so the
    CLI can drive it with a synthetic ``vault_id`` and local storage and no
    DB row. ``run`` is the only entry point; everything else is internal.
    """

    def __init__(
        self,
        *,
        storage: Storage,
        label: str,
        vault_id: UUID,
        source: SourceDocumentService,
        wiki: WikiArticleService,
        search: SearchService,
        client: AsyncOpenAI,
    ) -> None:
        self.storage = storage
        self.label = label
        self.vault_id = vault_id
        self.source = source
        self.wiki = wiki
        self.search = search
        self.client = client

    async def run(
        self,
        question: str,
        *,
        user_id: UUID | None = None,
        model: str | None = None,
        origin_path: str | None = None,
        history: list[HistoryMessage] | None = None,
        mode: QueryMode = QueryMode.QUERY,
        extra_instructions: str | None = None,
    ) -> AsyncGenerator[dict, None]:
        """Stream SSE events for a question, with model fallback on rate limit."""
        primary = model or QUERY_MODEL
        system_prompt = await self._build_system_prompt(
            mode=mode, extra_instructions=extra_instructions
        )
        tools = await self._load_tools()
        base_messages: list[dict] = [{"role": "system", "content": system_prompt}]
        if origin_path:
            base_messages.extend(await self._build_origin_messages(origin_path))
        if history:
            base_messages.extend(m.model_dump() for m in history)
        base_messages.append({"role": "user", "content": question})

        query_id = f"q-{uuid.uuid4().hex[:8]}"
        correlation_id.set(query_id)
        init_wide_event("query.stream", question=question, vault_id=str(self.vault_id))

        try:
            for m in models_with_fallback(primary):
                messages = list(base_messages)
                try:
                    async for event in self._stream_chat(m, messages, tools=tools):
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
            await self._finalize_wide_event(user_id=user_id)

    # -- tools --------------------------------------------------------------

    async def _read_document(self, path: str) -> str:
        """Read a whole document, or its outline if it is large.

        A small document is returned in full. A large document returns its
        heading outline (sections with chunk ranges) instead of a truncated
        dump; the agent then reads a section with expand_context(path,
        start, end).
        """
        content = await self.storage.read(path, strict=False)
        if content is None:
            log_event("tool.document_not_found", path=path)
            return f"Document not found: {path}"

        if len(content) <= _READ_WHOLE_LIMIT:
            log_event(
                "tool.document_read",
                path=path,
                vault=self.label,
                mode="full",
                chars=len(content),
            )
            return f"# {path} [{self.label}]\n\n{content}"

        outline = await self.search.document_outline([self.vault_id], path)
        log_event(
            "tool.document_read",
            path=path,
            vault=self.label,
            mode="outline",
            chars=len(content),
            sections=len(outline),
        )
        lines = [
            f"- chunks {s.start}-{s.end}: {s.heading or '(no heading)'}"
            for s in outline
        ]
        return (
            f"# {path} [{self.label}]\n\n"
            "Large document — read a section with expand_context(path, start, end):"
            "\n\n" + "\n".join(lines)
        )

    async def _search_content(self, query: str) -> str:
        """Hybrid BM25 + vector search over the unified content index.

        Indexes both raw sources and rendered wiki articles, including each
        file's frontmatter title/precis/author as a synthetic chunk so
        curator-supplied summary fields are hit alongside body paragraphs.
        """
        results = await self.search.search([self.vault_id], query)

        log_event("tool.search_executed", query=query, results_count=len(results))

        if not results:
            return f"No results found for: {query}"

        parts = []
        for r in results:
            heading = f" — {r.heading}" if r.heading else ""
            parts.append(f"### {r.path} [chunk {r.chunk_index}]{heading}\n{r.snippet}")

        return (
            f"Found {len(results)} results for '{query}'. Each result shows a "
            f"document `path` and `chunk_index` — pass those to "
            f"expand_context(path, start, end) to read the surrounding "
            f"paragraphs, or read_document(path) for the whole document.\n\n"
            + "\n\n".join(parts)
        )

    async def _expand_context(self, path: str, start: int, end: int) -> str:
        """Read a range of a document's paragraphs (chunks ``start``..``end``).

        Ranges come from a search hit's chunk_index or a document outline.
        Bodies are served straight from search_index — no storage
        round-trip — and the span is capped so one read can't pull in a
        whole document.
        """
        if end < start:
            start, end = end, start
        end = min(end, start + _MAX_RANGE_CHUNKS - 1)
        chunks = await self.search.fetch_chunk_range([self.vault_id], path, start, end)
        if not chunks:
            log_event("tool.expand_context_empty", path=path, start=start, end=end)
            return (
                f"No indexed paragraphs at {path} for chunks {start}-{end}. Check "
                f"the path and range against a search hit or document outline."
            )
        log_event(
            "tool.expand_context",
            path=path,
            start=start,
            end=end,
            returned=len(chunks),
        )
        return _render_chunk_window(path, self.label, chunks)

    async def _linked_articles(self, path: str) -> str:
        """List the articles a wiki article links to and is linked from.

        Reads the prose-derived backlink graph (both directions); no
        topic-level intent. Navigation only — emits no "source consulted"
        event, since nothing is read here.
        """
        if not path.startswith("wiki/"):
            return (
                f"{path} is not a wiki article — the link graph only covers "
                f"wiki articles. Use search_content to find related material."
            )
        linked = await self.wiki.linked_articles(self.vault_id, path)
        if linked is None:
            log_event("tool.linked_articles_not_found", path=path)
            return f"Article not found: {path}"
        log_event(
            "tool.linked_articles",
            path=path,
            outgoing=len(linked.outgoing),
            incoming=len(linked.incoming),
        )
        return (
            f"# Links for {path} [{self.label}]\n\n"
            f"Outgoing (this article cites):\n{_format_links(linked.outgoing)}\n\n"
            f"Incoming (articles that cite this):\n{_format_links(linked.incoming)}"
        )

    async def _query_documents(self, args: dict) -> str:
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

        results = await self.source.query_documents([self.vault_id], **filters)
        log_event(
            "tool.query_executed", filters=str(filters), results_count=len(results)
        )

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

    async def _dispatch_tool(self, name: str, args: dict) -> str:
        if name == "read_document":
            return await self._read_document(args["path"])
        elif name == "expand_context":
            return await self._expand_context(
                args["path"], int(args["start"]), int(args["end"])
            )
        elif name == "linked_articles":
            return await self._linked_articles(args["path"])
        elif name == "search_content":
            return await self._search_content(args["query"])
        elif name == "query_documents":
            return await self._query_documents(args)
        else:
            return f"Unknown tool: {name}"

    # -- prompt + tool setup ------------------------------------------------

    async def _build_identity(self) -> str:
        config = await load_vault_config(self.storage)
        wiki_count = await self.wiki.count(self.vault_id)
        raw_count = await self.source.count(self.vault_id)

        focus = config.thematic_hint.strip() or "(no editorial focus set)"
        return (
            f"### {self.label}\n"
            f"Focus: {focus}\n"
            f"Coverage: {wiki_count} wiki article"
            f"{'s' if wiki_count != 1 else ''}, "
            f"{raw_count} raw source"
            f"{'s' if raw_count != 1 else ''}."
        )

    async def _build_system_prompt(
        self, *, mode: QueryMode, extra_instructions: str | None
    ) -> str:
        identity = await self._build_identity() or "(empty vault)"

        # Layer 1: retrieval discipline (not overridable)
        prompt = _RETRIEVAL_CORE.format(identity=identity)

        # Layer 2: per-vault default persona
        prompt += "\n\n" + await load_prompt(self.storage, "query")

        if mode == QueryMode.BTW:
            prompt += "\n\n" + await load_prompt(self.storage, "query_btw")

        # Layer 3: per-request consumer instructions
        if extra_instructions:
            prompt += "\n\n" + extra_instructions

        return prompt

    async def _load_tools(self) -> list[dict]:
        tags = await self.source.get_distinct_tags([self.vault_id])
        return build_tools(tags)

    # -- streaming loop -----------------------------------------------------

    async def _stream_chat(
        self, model: str, messages: list[dict], *, tools: list[dict] | None = None
    ) -> AsyncGenerator[dict, None]:
        active_tools = tools or _BASE_TOOLS
        trace = StreamTrace()

        while True:
            trace.llm_rounds += 1
            state = ModelRound()

            async for event in _stream_model_round(
                self.client, model, messages, active_tools, state
            ):
                yield event

            if state.finish_reason == "tool_calls" and state.tool_calls:
                messages.append(_assistant_tool_message(state))
                try:
                    async for event in self._run_tool_calls(
                        messages, trace, state.tool_calls
                    ):
                        yield event
                except MalformedToolArgs as exc:
                    yield {"event": "error", "data": {"message": str(exc)}}
                    return
                continue

            if state.content:
                messages.append({"role": "assistant", "content": state.content})

            yield await self._emit_done(model, trace)
            return

    async def _run_tool_calls(
        self,
        messages: list[dict],
        trace: StreamTrace,
        tool_calls: dict[int, dict],
    ) -> AsyncGenerator[dict, None]:
        for tc in tool_calls.values():
            trace.tool_calls_total += 1
            args = _parse_tool_args(tc)
            name = tc["name"]

            source_event = await self._source_event(trace, name, args)
            if source_event is not None:
                yield source_event

            result = await self._dispatch_tool(name, args)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                }
            )

    async def _source_event(
        self, trace: StreamTrace, name: str, args: dict
    ) -> dict | None:
        classified = _classify_tool_call(name, args)
        if not classified:
            return None

        source_type, meta = classified
        event_data: dict = {"type": source_type, **meta}
        if source_type in (SourceType.ARTICLE, SourceType.RAW):
            path = meta["path"]
            if source_type is SourceType.ARTICLE:
                event_data["title"] = await self.wiki.get_title_by_path(
                    self.vault_id, path
                )
                trace.articles_read.append(path)
            else:
                event_data["title"] = await self.source.get_title_by_path(
                    self.vault_id, path
                )
                trace.sources_read.append(path)
        elif source_type is SourceType.SEARCH:
            trace.searches.append(meta["query"])

        return {"event": "source", "data": event_data}

    async def _build_origin_messages(self, origin_path: str) -> list[dict]:
        """Build synthetic tool-call messages that pre-load the origin document."""
        content = await self._read_document(origin_path)
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

    async def _emit_done(self, model: str, trace: StreamTrace) -> dict:
        enrich(
            model=model,
            articles_read=trace.articles_read,
            sources_read=trace.sources_read,
            searches=trace.searches,
            llm_rounds=trace.llm_rounds,
            tool_calls=trace.tool_calls_total,
        )
        sources = await self._sources_consulted(trace.articles_read, trace.sources_read)
        return {
            "event": "done",
            "data": {"sources_consulted": [asdict(s) for s in sources]},
        }

    async def _sources_consulted(
        self, articles_read: list[str], sources_read: list[str]
    ) -> list[SourceConsulted]:
        seen: set[str] = set()
        out: list[SourceConsulted] = []
        for path in articles_read:
            if path not in seen:
                seen.add(path)
                title = await self.wiki.get_title_by_path(self.vault_id, path)
                out.append(SourceConsulted(kind="wiki", path=path, title=title))
        for path in sources_read:
            if path not in seen:
                seen.add(path)
                title = await self.source.get_title_by_path(self.vault_id, path)
                out.append(SourceConsulted(kind="raw", path=path, title=title))
        return out

    async def _finalize_wide_event(self, *, user_id: UUID | None) -> None:
        await record_wide_event_cost(
            self.source.repo.session, user_id=user_id, vault_id=self.vault_id
        )
        await self.source.repo.session.commit()
        emit_wide_event()
