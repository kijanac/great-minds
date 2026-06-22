"""Query interface for the knowledge base.

Runs the configured QUERY_MODEL via OpenRouter with function calling to
navigate the wiki and raw sources. Emits structured telemetry via wide
events — every query logs which articles and sources were pulled into
context, with timing.
"""

import enum
import json
import re
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

from openai import AsyncOpenAI
from pydantic import BaseModel

from .vaults.config import load_vault_config
from .vaults.prompts import load_prompt
from .footnotes import FootnoteSource, format_source_link, resolve_footnotes
from .search import Chunk, SearchService
from .documents.schemas import WikiArticleOverview, WikiSort
from .documents.service import SourceDocumentService, WikiArticleService
from .llm import QUERY_MODEL
from .pagination import PageParams
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
    LINKS = "links"


class _ToolMiss(Exception):
    """A read/navigation tool found nothing at the requested path.

    The ``message`` is still fed back to the model so it can recover (e.g.
    correct a guessed path), but no ``source`` event is emitted — a miss put
    nothing into the agent's context, so it should leave no card behind.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


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


# A footnote definition line the agent writes, e.g. `[^3]: raw/docs/x.md#15`.
_FOOTNOTE_DEF_RE = re.compile(r"^\[\^(\d+)\]:[ \t]*(.+?)[ \t]*$", re.MULTILINE)
# The source spec inside it: a .md path with an optional chunk index.
_DEF_SPEC_RE = re.compile(r"(\S+\.md)(?:#\^?p?(\d+))?")


_BASE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": (
                "Use to read a document you already have the `path` for. A "
                "small document is returned in full; a LARGE document returns "
                "only a section OUTLINE, not its text. If you have a query and "
                "the document is large, do NOT use this to read it — use "
                "search_in_document(path, query) to jump to the relevant "
                "passages. Read an outlined section with "
                "expand_context(path, start, end)."
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
                "Use to fetch a specific `start`-`end` chunk range you ALREADY "
                "obtained from a search hit or a read_document outline. Do NOT "
                "use it to explore a document — guessing a range (e.g. chunks "
                "1-10) wastes turns; run search_in_document(path, query) first "
                "and expand only the chunks it returns."
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
                "Use when you have a wiki article `path` and want its "
                "neighbors in the citation graph — outgoing and incoming links "
                "— to follow related articles without reading their bodies. "
                "Returns linked titles + paths only. Do NOT use it to find "
                "passages or do topical search (use search_content / "
                "search_in_document). Pass a wiki article path, e.g. "
                "wiki/imperialism.md."
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
                "Use FIRST only when you don't yet know which document holds "
                "the answer — hybrid search across the WHOLE knowledge base "
                "(all raw sources + all wiki articles), matching title, precis, "
                "author, and body text. Returns ranked excerpts each with a "
                "`path` and `chunk_index`. Once you have a specific path, do "
                "NOT search here again — use search_in_document to search "
                "inside it, or read_document to read it."
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
    {
        "type": "function",
        "function": {
            "name": "list_articles",
            "description": (
                "Use to BROWSE the wiki article index — the synthesized "
                "encyclopedia — by title and path, most-linked first "
                "(sort=central). Reach for it FIRST to orient on a concept, "
                "person, work, or '-ism', or to find a known article's real "
                "path before reading it. Returns titles + paths only, no body "
                "text. `contains` is a literal title/precis substring filter — "
                "for topical or fuzzy discovery use search_content instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "contains": {
                        "type": "string",
                        "description": (
                            "Literal substring to match in an article's "
                            "title/precis (not semantic — use search_content "
                            "for meaning-based discovery)"
                        ),
                    },
                    "sort": {
                        "type": "string",
                        "enum": ["central", "recent", "alpha"],
                        "description": (
                            "central = most-linked first (best for "
                            "orientation), recent = newest first, alpha = A–Z. "
                            "Default central."
                        ),
                    },
                    "page": {
                        "type": "integer",
                        "description": "1-based page number (default 1)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_in_document",
            "description": (
                "Use when you HAVE a document `path` and want the passages of "
                "THAT document relevant to a query — hybrid search scoped to "
                "one document. ALWAYS prefer this over read_document + "
                "expand_context for any document large enough to return an "
                "outline: it finds the relevant chunks instead of making you "
                "guess a range. Returns matching chunks with indexes for "
                "expand_context(path, start, end)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "Document path to search within, e.g. "
                            "raw/texts/lenin/works/1916/imperialism/03.md"
                        ),
                    },
                    "query": {
                        "type": "string",
                        "description": "Search term or phrase",
                    },
                },
                "required": ["path", "query"],
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
                "Use when the question names a STRUCTURED attribute of raw "
                "sources — a tag, author, genre, or date/date-range (e.g. "
                "'sources by X', 'everything tagged Y', 'written after Z'). "
                "Filters by metadata, not text content. Do NOT use it for "
                "topical/conceptual questions (use search_content), and do NOT "
                "use it for wiki articles (use list_articles). "
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
        meta: dict = {"path": path}
        if name == "expand_context":
            # Carry the requested range so the UI can show exactly which
            # paragraphs entered context (read_document has no range → full doc).
            meta["start"] = int(args["start"])
            meta["end"] = int(args["end"])
        return doc_type, meta
    if name == "search_content":
        return SourceType.SEARCH, {"query": args["query"]}
    if name == "search_in_document":
        # A search scoped to one document — surface it as a search card whose
        # label names both the query and the document it ran against.
        return SourceType.SEARCH, {"query": f"{args['query']} · in {args['path']}"}
    if name == "query_documents":
        return SourceType.QUERY, {"filters": {k: v for k, v in args.items() if v}}
    if name == "list_articles":
        # Browsing the article index — a structured query, shown as a filter
        # card (page number is plumbing, not worth surfacing).
        filters = {k: args[k] for k in ("contains", "sort") if args.get(k)}
        return SourceType.QUERY, {"filters": filters}
    if name == "linked_articles":
        return SourceType.LINKS, {"path": args["path"]}
    return None


# ---------------------------------------------------------------------------
# Retrieval discipline + stateless helpers
# ---------------------------------------------------------------------------


_READ_WHOLE_LIMIT = 20_000  # docs at or under this many chars are returned whole
_MAX_RANGE_CHUNKS = 40  # cap one expand_context read so it can't dump a document
_ARTICLES_PER_PAGE = 25  # wiki articles returned per list_articles page


_RETRIEVAL_CORE = """\
You answer questions over a knowledge base by researching its documents \
with tools, then writing a cited answer. Work in four stages — each stage \
tells you which tool to reach for. Don't jump straight to whole-base search.

STAGE 1 — ORIENT. Get the lay of the land before hunting for passages.
- list_articles(contains, sort=central|recent|alpha): browse the rendered \
wiki articles — a synthesized encyclopedia, most-linked first. For any \
question about a concept, person, work, or term, START here to find the \
canonical article and its real path instead of guessing one.
- query_documents(tags, author, genre, date): when the question names a \
structured attribute of raw sources (an author, tag, genre, or date \
range), filter by it. Do NOT approximate a metadata filter with \
search_content.
If orientation finds nothing on the subject, the base likely doesn't cover \
it — see GROUNDING.

STAGE 2 — LOCATE. Find the passages that answer the question.
- search_content(query): hybrid search across the WHOLE base (raw + wiki). \
Your default only when you do not yet know which document to look in.
- search_in_document(path, query): hybrid search scoped to ONE document. \
The moment you know which document matters (from Stage 1, a citation, or a \
search hit), use this to jump to the relevant passages. ALWAYS prefer it \
over reading a long document from the top.
- linked_articles(path): a wiki article's outgoing/incoming citation links \
— follow the base's own connections to related articles and sources.

STAGE 3 — READ. Pull the exact text you will cite. Use only paths returned \
by earlier stages — never a path typed from memory.
- read_document(path): read a document. A large document returns a heading \
OUTLINE, not its text. If read_document returns an outline, your NEXT call \
MUST be search_in_document(path, query) to locate the relevant section — do \
NOT expand_context from the start of the document.
- expand_context(path, start, end): expand_context NEVER comes first. It \
reads a chunk range you have ALREADY located via a search hit or a specific \
outline section. If you are about to call it without a prior locating call, \
stop and call search_in_document first.

STAGE 4 — VERIFY & ANSWER. Re-read the strongest passages, then write. Open \
with the answer itself — no preamble about your process. Cite each claim with a \
`[^N]` marker, and list every marker at the end as `[^N]: <path>#<chunk>` (the \
document path and chunk number from a tool). If sources are thin or conflict, \
say so.

GROUNDING (non-negotiable):
- Ground every substantive claim in the retrieved texts and cite them; do \
not rely on your general knowledge.
- If the base does not cover the subject, say so plainly. Any outside \
context must be labeled explicitly as outside the knowledge base and kept \
minimal.

AVOID THESE HABITS:
- Reading a long document from the top (outline, then the first chunks) \
instead of search_in_document(path, query).
- Guessing or typing a document path — only use paths a tool returned.
- Defaulting to whole-base search_content when you already know the target \
document — search_in_document is faster and more precise.
- Answering an uncovered subject from general knowledge without disclosing it.
- Stopping at the first hit — orient and follow links before concluding the \
base is silent.

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
            raise _ToolMiss(f"Document not found: {path}")

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
            f"This document is large ({len(content):,} chars) — do NOT read it "
            f"from the top. To find the passages relevant to your question, call "
            f"search_in_document(path, query). Use expand_context(path, start, end) "
            f"only on a range a search hit or a specific section below points to."
            f"\n\nSection outline (a map, not the text):\n\n" + "\n".join(lines)
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

    async def _search_in_document(self, path: str, query: str) -> str:
        """Hybrid search scoped to a single document.

        Lets the agent jump to the passages of a long source or article most
        relevant to a query, rather than walking its whole outline. Returns
        matching chunk indexes to widen with expand_context.
        """
        results = await self.search.search([self.vault_id], query, path=path)

        log_event(
            "tool.search_in_document",
            path=path,
            query=query,
            results_count=len(results),
        )

        if not results:
            return (
                f"No passages in {path} match '{query}'. Check the path (from "
                f"list_articles or a search_content hit), or use search_content "
                f"to search the whole knowledge base."
            )

        parts = []
        for r in results:
            heading = f" — {r.heading}" if r.heading else ""
            parts.append(f"[chunk {r.chunk_index}]{heading}\n{r.snippet}")

        return (
            f"Found {len(results)} matching passages in {path}. Read more "
            f"around any with expand_context(path, start, end).\n\n"
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
            raise _ToolMiss(
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
            raise _ToolMiss(
                f"{path} is not a wiki article — the link graph only covers "
                f"wiki articles. Use search_content to find related material."
            )
        linked = await self.wiki.linked_articles(self.vault_id, path)
        if linked is None:
            log_event("tool.linked_articles_not_found", path=path)
            raise _ToolMiss(f"Article not found: {path}")
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

    async def _list_articles(self, args: dict) -> str:
        """Browse rendered wiki articles (titles + paths + precis), paginated.

        The synthesis-layer counterpart to search/query_documents: a literal
        title/precis filter plus an ordering, so the agent can pick an article
        and read it by its real path instead of guessing one.
        """
        contains = args.get("contains") or None
        sort = WikiSort(args.get("sort") or WikiSort.CENTRAL)
        page = max(1, int(args.get("page", 1)))
        pagination = PageParams(
            limit=_ARTICLES_PER_PAGE, offset=(page - 1) * _ARTICLES_PER_PAGE
        )
        result = await self.wiki.browse_articles(
            self.vault_id, contains=contains, sort=sort, pagination=pagination
        )
        log_event(
            "tool.list_articles",
            contains=contains,
            sort=str(sort),
            page=page,
            returned=len(result.items),
            total=result.pagination.total,
        )
        if not result.items:
            if contains:
                return (
                    f"No article titles or precis contain '{contains}'. Try "
                    "search_content for topical matches — it searches article "
                    "bodies and raw sources too."
                )
            return "No wiki articles have been compiled yet."

        lines = [f"- {a.title} — {a.file_path}\n  {a.precis}" for a in result.items]
        hi = pagination.offset + len(result.items)
        scope = f" matching '{contains}'" if contains else ""
        header = f"Articles {pagination.offset + 1}–{hi} of {result.pagination.total}{scope} (by {sort}):"
        more = (
            f"\n\nMore available — call list_articles(page={page + 1}) to continue."
            if hi < result.pagination.total
            else ""
        )
        return f"{header}\n\n" + "\n".join(lines) + more

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
        elif name == "search_in_document":
            return await self._search_in_document(args["path"], args["query"])
        elif name == "query_documents":
            return await self._query_documents(args)
        elif name == "list_articles":
            return await self._list_articles(args)
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

            yield await self._emit_done(model, trace, state.content or "")
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

            try:
                result = await self._dispatch_tool(name, args)
            except _ToolMiss as miss:
                # The read found nothing — feed the message back so the model
                # can recover, but emit no source card: nothing entered context.
                messages.append(
                    {"role": "tool", "tool_call_id": tc["id"], "content": miss.message}
                )
                continue

            # Emit the card only after a successful read, so the trace reflects
            # what actually entered the agent's context.
            source_event = await self._source_event(trace, name, args)
            if source_event is not None:
                yield source_event

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
            event_data["title"] = await self._source_title(path)
            if source_type is SourceType.ARTICLE:
                trace.articles_read.append(path)
            else:
                trace.sources_read.append(path)
        elif source_type is SourceType.SEARCH:
            trace.searches.append(meta["query"])
        elif source_type is SourceType.LINKS:
            # Navigation, not a read: surface a card with the article's title
            # but don't count it as a consulted source.
            event_data["title"] = await self.wiki.get_title_by_path(
                self.vault_id, meta["path"]
            )

        return {"event": "source", "data": event_data}

    async def _build_origin_messages(self, origin_path: str) -> list[dict]:
        """Build synthetic tool-call messages that pre-load the origin document."""
        try:
            content = await self._read_document(origin_path)
        except _ToolMiss as miss:
            content = miss.message
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

    async def _emit_done(self, model: str, trace: StreamTrace, answer: str) -> dict:
        enrich(
            model=model,
            articles_read=trace.articles_read,
            sources_read=trace.sources_read,
            searches=trace.searches,
            llm_rounds=trace.llm_rounds,
            tool_calls=trace.tool_calls_total,
        )
        return {"event": "done", "data": {"answer": await self._resolve_footnotes(answer)}}

    async def _resolve_footnotes(self, answer: str) -> str:
        """Enrich the agent's ``[^N]: path#chunk`` definitions into real footnotes.

        The agent writes ``[^N]`` markers in the prose and one definition line per
        marker giving the source path + chunk index. We parse those, strip them,
        and rebuild the section via the shared resolver — fixing the anchor to
        ``#^pN``, adding the document title, and attaching the cited chunk as the
        quote. The agent's own numbering carries the claim→chunk mapping, so
        there's no separate registry to keep in sync.
        """
        sources: dict[int, FootnoteSource] = {}
        titles: dict[str, str | None] = {}
        for m in _FOOTNOTE_DEF_RE.finditer(answer):
            spec = _DEF_SPEC_RE.search(m.group(2))
            if spec is None:
                continue
            path = spec.group(1)
            chunk_index = int(spec.group(2)) if spec.group(2) else None
            if path not in titles:
                titles[path] = await self._source_title(path)
            sources[int(m.group(1))] = FootnoteSource(
                link=format_source_link(titles[path] or path, path, chunk_index),
                quote=await self._chunk_quote(path, chunk_index),
            )
        if not sources:
            return answer
        # Drop the agent's raw definitions (and any trailing rule/heading it
        # added); the resolver re-emits clean ones.
        stripped = _FOOTNOTE_DEF_RE.sub("", answer)
        for _ in range(3):
            stripped = re.sub(r"\s*-{3,}\s*$", "", stripped)
            stripped = re.sub(
                r"\s*(?:#{1,6}\s*)?\**\s*(?:Footnotes?|Sources?)\s*\**\s*$",
                "",
                stripped,
                flags=re.IGNORECASE,
            )
        return resolve_footnotes(stripped.rstrip(), sources)

    async def _chunk_quote(self, path: str, chunk_index: int | None) -> str:
        """The cited chunk's text, collapsed to one line and capped — the full
        passage lives behind the deep-link."""
        if chunk_index is None:
            return ""
        chunks = await self.search.fetch_chunk_range(
            [self.vault_id], path, chunk_index, chunk_index
        )
        if not chunks:
            return ""
        body = " ".join(chunks[0].body.split())
        return f"{body[:240]}…" if len(body) > 240 else body

    async def _source_title(self, path: str) -> str | None:
        if path.startswith("wiki/"):
            return await self.wiki.get_title_by_path(self.vault_id, path)
        return await self.source.get_title_by_path(self.vault_id, path)

    async def _finalize_wide_event(self, *, user_id: UUID | None) -> None:
        await record_wide_event_cost(
            self.source.repo.session, user_id=user_id, vault_id=self.vault_id
        )
        await self.source.repo.session.commit()
        emit_wide_event()
