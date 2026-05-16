"""Phase 1 — extract.

One LLM call per document. Produces a SourceCard (title, precis,
author, published_date, genre, tags, derived_extras, ideas) plus
embeddings for each idea. Per-doc cache keyed on
sha256(doc_body + rendered_prompt_hash + extract_model) short-circuits
the LLM + embedding work on incremental compiles.

The rendered_prompt_hash folds in both the prompt template and the
vault's enriched-field config; either changing invalidates the cache.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from uuid import UUID, uuid7

from openai import AsyncOpenAI
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from great_minds.core.compile_cache import CompileCacheRepository
from great_minds.core.documents import SourceDocument, SourceDocumentService
from great_minds.core.documents.builder import build_frontmatter
from great_minds.core.hashing import content_hash, prompt_hash
from great_minds.core.ideas.schemas import Anchor, Idea, IdeaCreate, SourceCard
from great_minds.core.ideas.service import IdeaService
from great_minds.core.llm import EXTRACT_MODEL, truncate_and_normalize
from great_minds.core.llm.client import json_llm_call
from great_minds.core.llm.providers import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL
from great_minds.core.markdown import (
    normalized_bodies,
    paragraph_for_quote,
    paragraphs,
    parse_frontmatter,
)
from great_minds.core.pipeline_runs import (
    PipelineProgressRunner,
    PipelineProgressStep,
    build_progress_steps,
)
from great_minds.core.storage import Storage
from great_minds.core.telemetry import enrich, log_event
from great_minds.core.vaults.config import EnrichedFieldSpec, VaultConfig
from great_minds.core.vaults.prompts import load_prompt

log = logging.getLogger(__name__)

PHASE = "extract"
EMBEDDING_BATCH_SIZE = 50

EXTRACT_STEP_LABELS = {
    "load_documents": "Preparing document list",
    "extract_cards": "Extracting source cards",
    "embed_ideas": "Embedding ideas",
    "save_index": "Saving extraction index",
}


class ExtractPhase:
    """Phase 1 runner with explicit service-style dependencies."""

    def __init__(
        self,
        *,
        storage: Storage,
        client: AsyncOpenAI,
        session: AsyncSession,
        source_docs: SourceDocumentService,
        ideas: IdeaService,
        compile_cache: CompileCacheRepository,
        progress: PipelineProgressRunner,
        config: VaultConfig,
        concurrency: int = 8,
    ) -> None:
        self.storage = storage
        self.client = client
        self.session = session
        self.source_docs = source_docs
        self.ideas = ideas
        self.compile_cache = compile_cache
        self.progress = progress
        self.config = config
        self.concurrency = concurrency

    def progress_steps(
        self,
        active: str,
        *,
        completed: set[str] | None = None,
        counts: dict[str, tuple[int, int]] | None = None,
    ) -> list[PipelineProgressStep]:
        return build_progress_steps(
            EXTRACT_STEP_LABELS, active, completed=completed, counts=counts
        )

    async def run(self, *, vault_id: UUID, pipeline_run_id: UUID) -> None:
        """Drive Phase 1 — extract — over every doc in the docs registry.

        The documents table is the authoritative registry — ingest writes
        the file and the DB row together, so iterating the registry catches
        every document. If a DB row points at a file that's missing from
        storage, _extract_one records file_not_found via
        storage.read(strict=False).
        """
        prompt_template = await load_prompt(self.storage, "extract")
        rendered_template = _render_template_for_hash(prompt_template, self.config)
        ph = prompt_hash(rendered_template)

        docs = await self.source_docs.list_all(vault_id)
        total_docs = len(docs)
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="extract",
            status="progress",
            steps=self.progress_steps(
                "extract_cards",
                completed={"load_documents"},
                counts={"extract_cards": (0, total_docs)},
            ),
        )

        sem = asyncio.Semaphore(self.concurrency)
        tasks = [
            _extract_one(
                phase=self,
                sem=sem,
                vault_id=vault_id,
                raw_path=doc.file_path,
                document_id=doc.id,
                body_hash=doc.body_hash,
                rendered_template=rendered_template,
                prompt_hash=ph,
            )
            for doc in docs
        ]

        outcomes: list[_ExtractOutcome] = []
        docs_completed = 0
        for task in asyncio.as_completed(tasks):
            outcome = await task
            outcomes.append(outcome)
            docs_completed += 1
            if total_docs > 0:
                await self.progress.emit(
                    pipeline_run_id=pipeline_run_id,
                    phase="extract",
                    status="progress",
                    steps=self.progress_steps(
                        "extract_cards",
                        completed={"load_documents"},
                        counts={"extract_cards": (docs_completed, total_docs)},
                    ),
                )

        # Per-doc trackers for the embedding loop. Populated only inside
        # the success branch below where source_card is narrowed to non-None.
        # ``fresh_cards`` only carries cache misses — cache hits already have
        # their ideas+anchors and source_documents columns from a prior compile.
        fresh_cards: list[SourceCard] = []
        embedding_inputs: list[tuple[UUID, UUID, Idea]] = []
        existing_idea_ids = set(await self.ideas.get_ids_for_vault(vault_id))
        docs_extracted = 0
        cache_hits = 0
        cache_misses = 0
        docs_failed = 0
        ideas_emitted = 0

        for outcome in outcomes:
            if outcome.error is not None:
                docs_failed += 1
                log_event(
                    "doc_failed",
                    level=logging.WARNING,
                    path=outcome.raw_path,
                    error=outcome.error,
                )
                continue
            source_card = outcome.source_card
            if source_card is None:
                # Unreachable in practice: success path always sets source_card.
                continue
            docs_extracted += 1
            ideas_emitted += len(source_card.ideas)
            if outcome.cache_hit:
                cache_hits += 1
                for idea in source_card.ideas:
                    if idea.idea_id not in existing_idea_ids:
                        embedding_inputs.append((vault_id, outcome.document_id, idea))
            else:
                cache_misses += 1
                fresh_cards.append(source_card)
                await _write_cache(
                    compile_cache=self.compile_cache,
                    session=self.session,
                    vault_id=vault_id,
                    cache_key=outcome.cache_key,
                    source_card=source_card,
                )
                for idea in source_card.ideas:
                    embedding_inputs.append((vault_id, outcome.document_id, idea))

        # Extract cache stores only the LLM output (SourceCard). Embeddings are
        # derived vector-index rows in ideas; if a crash happens after caching
        # but before embedding upsert, replay reuses the SourceCard and
        # regenerates only missing embeddings.
        total_embedding_batches = (
            len(embedding_inputs) + EMBEDDING_BATCH_SIZE - 1
        ) // EMBEDDING_BATCH_SIZE
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="extract",
            status="progress",
            steps=self.progress_steps(
                "embed_ideas",
                completed={"load_documents", "extract_cards"},
                counts={
                    "extract_cards": (docs_completed, total_docs),
                    "embed_ideas": (0, total_embedding_batches),
                },
            ),
        )
        # Clear stale idea rows for cache-miss docs once, up front: the LLM
        # minted fresh uuid7s, so the prior rows are orphans. With this done,
        # embedding batches can stream straight into ``bulk_upsert`` without
        # accumulating a corpus-sized ``fresh_ideas`` list in Python memory.
        await self.ideas.delete_for_documents(c.document_id for c in fresh_cards)
        embedding_batches_done = 0
        async for batch in _embed_in_batches(self.client, embedding_inputs):
            await self.ideas.record_extractions(batch)
            embedding_batches_done += 1
            await self.progress.emit(
                pipeline_run_id=pipeline_run_id,
                phase="extract",
                status="progress",
                steps=self.progress_steps(
                    "embed_ideas",
                    completed={"load_documents", "extract_cards"},
                    counts={
                        "extract_cards": (docs_completed, total_docs),
                        "embed_ideas": (
                            embedding_batches_done,
                            total_embedding_batches,
                        ),
                    },
                ),
            )
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="extract",
            status="progress",
            steps=self.progress_steps(
                "save_index",
                completed={"load_documents", "extract_cards", "embed_ideas"},
                counts={
                    "extract_cards": (docs_completed, total_docs),
                    "embed_ideas": (embedding_batches_done, total_embedding_batches),
                },
            ),
        )
        await self.source_docs.update_metadata_from_cards(vault_id, fresh_cards)
        await self.session.commit()

        # Mirror LLM-derived fields back into on-disk frontmatter so the
        # vault is portable (a clone of R2 + a fresh DB reconstructs to
        # the same state). Only freshly-extracted docs need rewriting;
        # cache-hit docs already have correct frontmatter from a prior
        # compile.
        docs_by_id = {d.id: d for d in docs}
        for card in fresh_cards:
            await _mirror_frontmatter(self.storage, docs_by_id[card.document_id], card)

        enrich(
            docs_extracted=docs_extracted,
            cache_hits=cache_hits,
            cache_misses=cache_misses,
            docs_failed=docs_failed,
            ideas_emitted=ideas_emitted,
        )
        log_event(
            "completed",
            docs_extracted=docs_extracted,
            cache_hits=cache_hits,
            cache_misses=cache_misses,
            docs_failed=docs_failed,
            ideas_emitted=ideas_emitted,
        )
        await self.progress.emit(
            pipeline_run_id=pipeline_run_id,
            phase="extract",
            status="completed",
            steps=self.progress_steps(
                "save_index",
                completed={
                    "load_documents",
                    "extract_cards",
                    "embed_ideas",
                    "save_index",
                },
                counts={
                    "extract_cards": (docs_completed, total_docs),
                    "embed_ideas": (embedding_batches_done, total_embedding_batches),
                },
            ),
        )


# ---------------------------------------------------------------------------
# Per-doc extraction
# ---------------------------------------------------------------------------


@dataclass
class _ExtractOutcome:
    raw_path: str
    document_id: UUID
    source_card: SourceCard | None = None
    embeddings: list[IdeaCreate] = field(default_factory=list)
    cache_key: str = ""
    cache_hit: bool = False
    error: str | None = None


async def _extract_one(
    *,
    phase: ExtractPhase,
    sem: asyncio.Semaphore,
    vault_id: UUID,
    raw_path: str,
    document_id: UUID,
    body_hash: str,
    rendered_template: str,
    prompt_hash: str,
) -> _ExtractOutcome:
    outcome = _ExtractOutcome(raw_path=raw_path, document_id=document_id)
    try:
        cache_key = _cache_key(
            document_id=document_id, body_hash=body_hash, prompt_hash=prompt_hash
        )
        outcome.cache_key = cache_key

        cached = await phase.compile_cache.get(
            vault_id=vault_id,
            phase=PHASE,
            cache_key=cache_key,
        )
        if cached is not None:
            outcome.source_card = SourceCard.model_validate(cached["source_card"])
            outcome.cache_hit = True
            return outcome

        # Cache miss: only now do we need the body to feed the LLM.
        content = await phase.storage.read(raw_path, strict=False)
        if content is None:
            outcome.error = "file_not_found"
            return outcome
        _, body = parse_frontmatter(content)

        async with sem:
            prompt = rendered_template.replace("{doc_content}", body)
            data = await json_llm_call(
                phase.client,
                model=EXTRACT_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
            )
        outcome.source_card = _validate_extract_output(
            data=data,
            document_id=document_id,
            allowed_kinds=phase.config.kinds,
        )
        _localize_anchors(outcome.source_card, body)
    except json.JSONDecodeError as e:
        outcome.error = f"json_parse_exhausted:{e}"
    except ValidationError as e:
        outcome.error = f"schema_invalid:{str(e)[:200]}"
    except Exception as e:
        outcome.error = f"llm_call:{repr(e)[:200]}"
        log_event(
            "doc_failed",
            level=logging.WARNING,
            path=raw_path,
            error=outcome.error,
        )
    return outcome


def _cache_key(*, document_id: UUID, body_hash: str, prompt_hash: str) -> str:
    """Per-doc extract cache key.

    ``document_id`` is in the key so each doc owns its own cache entry.
    Cross-doc sharing on identical body content created two failure
    modes — a cached ``source_card``'s idea_ids could end up
    referenced by a second doc's ``outcome.document_id`` on cache hit,
    producing either ``CardinalityViolationError`` (two outcomes queue
    the same idea_id) or ``title=NULL``-with-ideas (the second doc
    skips ``fresh_cards`` and never gets its metadata written). Per-doc
    keys eliminate both classes.

    Trade-off: identical-content docs each pay one LLM call instead of
    sharing. With ingest-time client-hash dedup at upload, that's a
    rare case in practice.
    """
    return content_hash(
        f"doc={document_id}",
        body_hash,
        f"prompt={prompt_hash}",
        f"model={EXTRACT_MODEL}",
    )


def _render_template_for_hash(prompt_template: str, config: VaultConfig) -> str:
    """Substitute everything except ``{doc_content}`` into the template.

    The result is identical for every doc in this compile, so we hash
    it once and pass that as the cache-key component. Per-doc rendering
    is a single ``replace("{doc_content}", body)``.
    """
    return prompt_template.replace("{kinds}", ", ".join(config.kinds)).replace(
        "{vault_enriched_fields}",
        _format_enriched_fields(config.enriched_fields),
    )


def _format_enriched_fields(specs: tuple[EnrichedFieldSpec, ...]) -> str:
    """Render the vault's enriched fields as nested prompt lines.

    Matches the indentation of the surrounding ``derived_extras`` block
    in extract.md. Empty when the vault has no enriched fields.
    """
    if not specs:
        return ""
    lines = []
    for spec in specs:
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
                claim=a.get("claim") or "",
                quote=a.get("quote") or "",
            )
            for a in raw_idea.get("anchors") or []
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

    return SourceCard(
        document_id=document_id,
        title=data.get("title") or "",
        precis=data.get("precis") or "",
        author=data.get("author") or None,
        published_date=data.get("published_date") or None,
        genre=data.get("genre") or None,
        tags=data.get("tags") or [],
        derived_extras=data.get("derived_extras") or {},
        ideas=ideas,
    )


# ---------------------------------------------------------------------------
# Cache write
# ---------------------------------------------------------------------------


async def _write_cache(
    *,
    compile_cache: CompileCacheRepository,
    session: AsyncSession,
    vault_id: UUID,
    cache_key: str,
    source_card: SourceCard,
) -> None:
    await compile_cache.put(
        vault_id=vault_id,
        phase=PHASE,
        cache_key=cache_key,
        value={"source_card": source_card.model_dump(mode="json")},
    )
    await session.commit()


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------


async def _embed_in_batches(
    client: AsyncOpenAI,
    inputs: list[tuple[UUID, UUID, Idea]],
) -> AsyncIterator[list[IdeaCreate]]:
    """Yield ``IdeaCreate`` batches as embeddings come back.

    Per-batch yielding lets the caller checkpoint cache writes as docs
    finish embedding, instead of waiting for the whole list to complete.
    A 300s per-batch timeout prevents the queue from deadlocking on a
    stalled embeddings call.
    """
    for start in range(0, len(inputs), EMBEDDING_BATCH_SIZE):
        batch_inputs = inputs[start : start + EMBEDDING_BATCH_SIZE]
        texts = [
            f"{idea.label}. {idea.description}".strip() for _, _, idea in batch_inputs
        ]
        try:
            response = await asyncio.wait_for(
                client.embeddings.create(model=EMBEDDING_MODEL, input=texts),
                timeout=300,
            )
        except asyncio.TimeoutError:
            log_event(
                "embed_batch.timeout",
                level=logging.WARNING,
                batch_size=len(batch_inputs),
            )
            continue
        yield [
            IdeaCreate(
                idea_id=idea.idea_id,
                vault_id=vault_id,
                document_id=document_id,
                kind=idea.kind,
                label=idea.label,
                description=idea.description,
                anchors=idea.anchors,
                embedding=truncate_and_normalize(item.embedding, EMBEDDING_DIMENSIONS),
            )
            for (vault_id, document_id, idea), item in zip(batch_inputs, response.data)
        ]


# ---------------------------------------------------------------------------
# Frontmatter mirror (post-extract)
# ---------------------------------------------------------------------------


async def _mirror_frontmatter(
    storage: Storage, doc: SourceDocument, card: SourceCard
) -> None:
    """Rewrite this doc's on-disk frontmatter to reflect the new extract.

    Identity / provenance comes from the (already-committed) DB row;
    LLM-derived fields come from the SourceCard; vault-configured extras
    are flattened to top-level frontmatter keys. Body is preserved
    verbatim — anchors were injected at ingest time.

    Raises if the file vanished between extract and mirror. The DB
    update has already committed, so a missing file here is a real
    inconsistency, not a silent-skip case.
    """
    existing = await storage.read(doc.file_path)
    if existing is None:
        raise RuntimeError(
            f"document file missing during frontmatter mirror: {doc.file_path}"
        )
    _, body = parse_frontmatter(existing)
    new_fm: dict = {
        "source_type": doc.source_type,
        "url": doc.url,
        "origin": doc.origin,
        "session_id": (
            str(doc.provenance_session_id) if doc.provenance_session_id else None
        ),
        "exchange_id": doc.provenance_exchange_id,
        "session_query": doc.provenance_session_query,
        "source_doc_path": doc.provenance_source_doc_path,
        "source_anchor": doc.provenance_source_anchor,
        "source_paragraph_index": doc.provenance_source_paragraph_index,
        "anchored_to": doc.provenance_anchored_to,
        "anchored_section": doc.provenance_anchored_section,
        "intent": doc.provenance_intent,
        "title": card.title,
        "precis": card.precis,
        "author": card.author,
        "date": card.published_date,
        "genre": card.genre,
        "tags": card.tags or None,
        **card.derived_extras,
    }
    await storage.write(doc.file_path, build_frontmatter(new_fm) + body)
