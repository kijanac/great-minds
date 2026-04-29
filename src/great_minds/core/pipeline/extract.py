"""Phase 1 — extract.

One LLM call per document. Produces a SourceCard (title, doc_metadata,
precis, ideas with anchors) and corresponding idea embeddings. Per-doc
cache keyed on sha256(doc_content + prompt_hash + kinds_config +
extract_model) short-circuits the LLM + embedding work for incremental
compiles.

Per-source-type metadata fields (tradition, interlocutors, outlet, etc.)
are pulled from the brain's config.yaml metadata.<source_type> section
via ingester.load_field_specs and formatted into the prompt's
{extra_fields} slot. Universal fields (genre, tags) are hardcoded.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from uuid import UUID

from pydantic import ValidationError
from uuid6 import uuid7

from great_minds.core.brain import load_prompt
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.schemas import DocKind, Document
from great_minds.core.llm.client import json_llm_call
from great_minds.core.markdown import (
    normalized_bodies,
    paragraph_for_quote,
    paragraphs,
    parse_frontmatter,
)
from great_minds.core.ideas.repository import IdeaEmbeddingRepository
from great_minds.core.ideas.schemas import (
    Anchor,
    DocMetadata,
    Idea,
    IdeaEmbedding,
    SourceCard,
)
from great_minds.core.ideas.service import IdeaService
from great_minds.core.ingester import load_field_specs
from great_minds.core.llm import EXTRACT_MODEL
from great_minds.core.llm.providers import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
)
from great_minds.core.pipeline.context import PipelineContext
from great_minds.core.search import _truncate_and_normalize
from great_minds.core.settings import get_settings
from great_minds.core.telemetry import enrich, log_event

log = logging.getLogger(__name__)

PHASE = "extract"
EMBEDDING_BATCH_SIZE = 50


async def run(ctx: PipelineContext) -> None:
    """Extract every raw document registered in the DB for this brain.

    The documents table is the authoritative registry — ingest writes
    the file and the DB row together, so iterating the registry catches
    every document. If a DB row points at a file that's missing from
    storage, _extract_one records file_not_found via
    storage.read(strict=False).
    """
    settings = get_settings()
    prompt_template = await load_prompt(ctx.storage, "extract")
    prompt_hash = hashlib.sha256(prompt_template.encode()).hexdigest()
    kinds_key = "|".join(sorted(ctx.config.kinds))

    docs = await _load_documents(ctx.session, ctx.brain_id)

    sem = asyncio.Semaphore(settings.compile_enrich_concurrency)
    tasks = [
        _extract_one(
            ctx=ctx,
            sem=sem,
            raw_path=doc.file_path,
            document_id=doc.id,
            source_type=doc.metadata.source_type,
            body_hash=doc.body_hash,
            prompt_template=prompt_template,
            prompt_hash=prompt_hash,
            kinds_key=kinds_key,
        )
        for doc in docs
    ]

    outcomes = await asyncio.gather(*tasks, return_exceptions=False)

    # Per-doc trackers for the embedding loop. Populated only inside
    # the success branch below where source_card is narrowed to non-None.
    cards: list[SourceCard] = []
    cached_embeddings: list[IdeaEmbedding] = []
    embedding_inputs: list[tuple[UUID, UUID, Idea]] = []
    fresh_source_cards: dict[UUID, SourceCard] = {}
    fresh_cache_keys: dict[UUID, str] = {}
    pending_per_doc: dict[UUID, int] = {}
    embeddings_by_doc: dict[UUID, list[IdeaEmbedding]] = {}
    docs_extracted = 0
    cache_hits = 0
    cache_misses = 0
    docs_failed = 0
    ideas_emitted = 0

    for outcome in outcomes:
        if outcome.error is not None:
            docs_failed += 1
            log_event(
                "extract.doc_failed",
                level=logging.WARNING,
                brain_id=str(ctx.brain_id),
                path=outcome.raw_path,
                error=outcome.error,
            )
            continue
        source_card = outcome.source_card
        if source_card is None:
            # Unreachable in practice: success path always sets source_card.
            continue
        docs_extracted += 1
        cards.append(source_card)
        ideas_emitted += len(source_card.ideas)
        if outcome.cache_hit:
            cache_hits += 1
            cached_embeddings.extend(outcome.embeddings)
        else:
            cache_misses += 1
            fresh_source_cards[outcome.document_id] = source_card
            fresh_cache_keys[outcome.document_id] = outcome.cache_key
            pending_per_doc[outcome.document_id] = len(source_card.ideas)
            embeddings_by_doc[outcome.document_id] = []
            for idea in source_card.ideas:
                embedding_inputs.append((ctx.brain_id, outcome.document_id, idea))

    # Write each fresh doc's cache entry as soon as all its ideas are
    # embedded. A mid-phase crash preserves LLM + embedding work for
    # every doc that completed before the crash; only docs whose
    # embeddings spanned the failing batch lose work and re-LLM next
    # attempt. DB writes that follow are idempotent upserts, so caching
    # ahead of commit can't produce a state the DB won't agree with on
    # the next run.
    fresh_embeddings: list[IdeaEmbedding] = []

    # Cache empty-idea docs immediately (no embeddings to wait on).
    for doc_id, remaining in list(pending_per_doc.items()):
        if remaining == 0:
            _write_cache(
                ctx,
                cache_key=fresh_cache_keys[doc_id],
                source_card=fresh_source_cards[doc_id],
                embeddings=[],
            )
            del pending_per_doc[doc_id]

    async for batch in _embed_in_batches(ctx.client, embedding_inputs):
        fresh_embeddings.extend(batch)
        completed: list[UUID] = []
        for emb in batch:
            embeddings_by_doc[emb.document_id].append(emb)
            pending_per_doc[emb.document_id] -= 1
            if pending_per_doc[emb.document_id] == 0:
                completed.append(emb.document_id)
        for doc_id in completed:
            _write_cache(
                ctx,
                cache_key=fresh_cache_keys[doc_id],
                source_card=fresh_source_cards[doc_id],
                embeddings=embeddings_by_doc[doc_id],
            )
            del pending_per_doc[doc_id]

    idea_repo = IdeaEmbeddingRepository(ctx.session)
    idea_service = IdeaService(
        brain_id=ctx.brain_id,
        embedding_repo=idea_repo,
        sidecar_root=ctx.sidecar_root,
    )
    for doc_id in fresh_source_cards:
        await idea_repo.delete_for_document(doc_id)
    await idea_service.record_extractions(
        cards, cached_embeddings + fresh_embeddings
    )
    await DocumentRepository(ctx.session).update_metadata_from_cards(
        ctx.brain_id, cards
    )
    await ctx.session.commit()

    enrich(
        docs_extracted=docs_extracted,
        cache_hits=cache_hits,
        cache_misses=cache_misses,
        docs_failed=docs_failed,
        ideas_emitted=ideas_emitted,
    )
    log_event(
        "pipeline.extract_completed",
        brain_id=str(ctx.brain_id),
        docs_extracted=docs_extracted,
        cache_hits=cache_hits,
        cache_misses=cache_misses,
        docs_failed=docs_failed,
        ideas_emitted=ideas_emitted,
    )


# ---------------------------------------------------------------------------
# Per-doc extraction
# ---------------------------------------------------------------------------


@dataclass
class _ExtractOutcome:
    raw_path: str
    document_id: UUID
    source_card: SourceCard | None = None
    embeddings: list[IdeaEmbedding] = field(default_factory=list)
    cache_key: str = ""
    cache_hit: bool = False
    error: str | None = None


async def _extract_one(
    *,
    ctx: PipelineContext,
    sem: asyncio.Semaphore,
    raw_path: str,
    document_id: UUID,
    source_type: str,
    body_hash: str,
    prompt_template: str,
    prompt_hash: str,
    kinds_key: str,
) -> _ExtractOutcome:
    outcome = _ExtractOutcome(raw_path=raw_path, document_id=document_id)
    try:
        cache_key = _cache_key(
            body_hash=body_hash,
            prompt_hash=prompt_hash,
            kinds_key=kinds_key,
            source_type=source_type,
        )
        outcome.cache_key = cache_key

        cached = ctx.cache.get(PHASE, cache_key)
        if cached is not None:
            outcome.source_card = SourceCard.model_validate(cached["source_card"])
            outcome.embeddings = [
                IdeaEmbedding.model_validate(e) for e in cached["embeddings"]
            ]
            outcome.cache_hit = True
            return outcome

        # Cache miss: only now do we need the body to feed the LLM.
        content = await ctx.storage.read(raw_path, strict=False)
        if content is None:
            outcome.error = "file_not_found"
            return outcome
        _, body = parse_frontmatter(content)

        async with sem:
            prompt = _render_prompt(
                prompt_template=prompt_template,
                kinds=ctx.config.kinds,
                source_type=source_type,
                doc_content=body,
                config_raw=ctx.config.raw,
            )
            data = await json_llm_call(
                ctx.client,
                model=EXTRACT_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
            )
        outcome.source_card = _validate_extract_output(
            data=data,
            document_id=document_id,
            allowed_kinds=ctx.config.kinds,
        )
        _localize_anchors(outcome.source_card, body)
    except json.JSONDecodeError as e:
        outcome.error = f"json_parse_exhausted:{e}"
    except ValidationError as e:
        outcome.error = f"schema_invalid:{str(e)[:200]}"
    except Exception as e:
        outcome.error = f"llm_call:{repr(e)[:200]}"
        log_event(
            "extract.doc_failed",
            level=logging.WARNING,
            brain_id=str(ctx.brain_id),
            path=raw_path,
            error=outcome.error,
        )
    return outcome


def _cache_key(
    *, body_hash: str, prompt_hash: str, kinds_key: str, source_type: str
) -> str:
    key_input = (
        f"{body_hash}::prompt={prompt_hash}::kinds={kinds_key}"
        f"::source_type={source_type}::model={EXTRACT_MODEL}"
    )
    return hashlib.sha256(key_input.encode()).hexdigest()


def _render_prompt(
    *,
    prompt_template: str,
    kinds: tuple[str, ...],
    source_type: str,
    doc_content: str,
    config_raw: dict,
) -> str:
    extra_fields = _build_extra_fields(config_raw, source_type)
    return (
        prompt_template.replace("{kinds}", ", ".join(kinds))
        .replace("{source_type}", source_type)
        .replace("{extra_fields}", extra_fields)
        .replace("{doc_content}", doc_content)
    )


def _build_extra_fields(config_raw: dict, source_type: str) -> str:
    """Format per-source-type enriched fields into prompt lines.

    Pulls from config.metadata.<source_type>, keeps fields with
    source=="enriched", writes lines matching the sibling genre/tags
    entries' format. Returns empty string if the brain has no
    per-source-type enriched fields.
    """
    try:
        specs = load_field_specs(config_raw, source_type)
    except ValueError:
        return ""
    enriched = [s for s in specs if s.source == "enriched"]
    if not enriched:
        return ""
    lines = []
    for spec in enriched:
        kind_hint = "array of strings" if spec.type == "list" else "string or null"
        desc = spec.description.strip() if spec.description else f"{spec.name} value"
        lines.append(f"    - `{spec.name}` ({kind_hint}): {desc}")
    return "\n".join(lines)


def _localize_anchors(source_card: SourceCard, body: str) -> None:
    """Fill anchor.chunk_index via substring match against body paragraphs.

    Mutates in place. Unmatchable quotes (LLM normalized whitespace,
    punctuation drift, etc.) leave chunk_index=None — render will still
    emit the footnote, just without a deep-link fragment.
    """
    paras = paragraphs(body)
    if not paras:
        return
    bodies = normalized_bodies(paras)
    for idea in source_card.ideas:
        for anchor in idea.anchors:
            anchor.chunk_index = paragraph_for_quote(anchor.quote, bodies)


def _validate_extract_output(
    *,
    data: dict,
    document_id: UUID,
    allowed_kinds: tuple[str, ...],
) -> SourceCard:
    """Validate raw LLM output into a SourceCard.

    Mints uuid7 for each idea. Coerces unknown kinds to "other" rather
    than failing — the LLM may drift and a single odd kind shouldn't
    tank the whole doc.
    """
    allowed = set(allowed_kinds)
    ideas_raw = data.get("ideas") or []
    ideas: list[Idea] = []
    for raw_idea in ideas_raw:
        kind = raw_idea.get("kind") or "other"
        if kind not in allowed and kind != "other":
            kind = "other"
        anchors = [
            Anchor(
                anchor_id=str(a.get("anchor_id") or f"a{i + 1}"),
                claim=a.get("claim") or "",
                quote=a.get("quote") or "",
            )
            for i, a in enumerate(raw_idea.get("anchors") or [])
        ]
        ideas.append(
            Idea(
                idea_id=uuid7(),
                document_id=document_id,
                kind=kind,
                label=raw_idea.get("label") or "",
                description=raw_idea.get("description") or "",
                anchors=anchors,
            )
        )

    doc_metadata = DocMetadata.model_validate(data.get("doc_metadata") or {})

    return SourceCard(
        document_id=document_id,
        title=data.get("title") or "",
        doc_metadata=doc_metadata,
        precis=data.get("precis") or "",
        ideas=ideas,
    )


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------


async def _embed_in_batches(
    client, inputs: list[tuple[UUID, UUID, Idea]]
) -> AsyncIterator[list[IdeaEmbedding]]:
    """Yield IdeaEmbedding lists one batch at a time.

    Per-batch yielding lets the caller checkpoint cache writes as docs
    finish embedding, instead of waiting for the whole list to complete.
    """
    for start in range(0, len(inputs), EMBEDDING_BATCH_SIZE):
        batch_inputs = inputs[start : start + EMBEDDING_BATCH_SIZE]
        texts = [
            f"{idea.label}. {idea.description}".strip()
            for _, _, idea in batch_inputs
        ]
        response = await client.embeddings.create(
            model=EMBEDDING_MODEL, input=texts
        )
        out: list[IdeaEmbedding] = []
        for (brain_id, document_id, idea), item in zip(
            batch_inputs, response.data
        ):
            vec = _truncate_and_normalize(item.embedding, EMBEDDING_DIMENSIONS)
            out.append(
                IdeaEmbedding(
                    idea_id=idea.idea_id,
                    brain_id=brain_id,
                    document_id=document_id,
                    kind=idea.kind,
                    label=idea.label,
                    description=idea.description,
                    embedding=vec,
                )
            )
        yield out


# ---------------------------------------------------------------------------
# DB persistence helpers
# ---------------------------------------------------------------------------


async def _load_documents(session, brain_id: UUID) -> list[Document]:
    """Load all raw documents for a brain in deterministic path order."""
    return await DocumentRepository(session).list_by_kind(brain_id, DocKind.RAW)


def _write_cache(
    ctx: PipelineContext,
    *,
    cache_key: str,
    source_card: SourceCard,
    embeddings: list[IdeaEmbedding],
) -> None:
    ctx.cache.put(
        PHASE,
        cache_key,
        {
            "source_card": source_card.model_dump(mode="json"),
            "embeddings": [e.model_dump(mode="json") for e in embeddings],
        },
    )
