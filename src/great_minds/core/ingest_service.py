"""Ingestion service — write source documents into the vault.

Five entry points, one per ingest shape: text body, uploaded file, URL,
user suggestion, promoted session exchange. All paths share two
guarantees:

1. Only ingest-known fields are written (paths, hashes, etag,
   source_type, url, origin, and per-source-kind provenance). Title,
   precis, author, published_date, genre, tags, and any
   vault-configured ``derived_extras`` are left for the extract phase
   on first compile.
2. A pending compile intent is emitted in the same transaction as the
   row write, via the compile-intents outbox. Either both land or
   neither does.
"""

from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import PurePosixPath
from urllib.parse import urlparse
from uuid import UUID

import httpx
from markitdown import MarkItDown, StreamInfo

from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.documents.builder import write_document
from great_minds.core.documents.schemas import IngestedDocument
from great_minds.core.documents.service import SourceDocumentService
from great_minds.core.ingest_schemas import StagedFileInput, StagedFileSignedUpload
from great_minds.core.paths import raw_path, session_exchange_path
from great_minds.core.pipeline_runs.repository import PipelineRunRepository
from great_minds.core.r2_admin import R2Admin
from great_minds.core.sessions.schemas import ExchangeEvent, SessionOrigin
from great_minds.core.sessions.service import SessionService
from great_minds.core.settings import Settings
from great_minds.core.storage import Storage
from great_minds.core.text import normalize_url, slugify
from great_minds.core.vaults.service import VaultService

log = logging.getLogger(__name__)


class UserSuggestionIntent(StrEnum):
    DISAGREE = "disagree"
    CORRECT = "correct"
    ADD_CONTEXT = "add_context"
    RESTRUCTURE = "restructure"


# Source-kind directories under raw/. Curator docs live under raw/docs/,
# system-generated kinds under their own dirs so lifecycle/cleanup code
# can distinguish them by path.
_RAW_DIR_FOR_KIND = {
    "document": "docs",
    "session": "sessions",
    "user": "user",
}


class IngestService:
    """All entry points share the same write contract; see module docstring."""

    def __init__(
        self,
        doc_service: SourceDocumentService,
        *,
        intent_repo: CompileIntentRepository,
        pipeline_run_repo: PipelineRunRepository,
        vault_service: VaultService,
        settings: Settings,
    ) -> None:
        self.doc_service = doc_service
        self.intent_repo = intent_repo
        self.pipeline_run_repo = pipeline_run_repo
        self.vault_service = vault_service
        self.settings = settings

    async def _emit_compile_intent(
        self, vault_id: UUID, pipeline_run_id: UUID | None
    ) -> None:
        intent = await self.intent_repo.ensure_pending(
            vault_id, pipeline_run_id=pipeline_run_id
        )
        if pipeline_run_id is None:
            return
        if intent.pipeline_run_id is None:
            await self.intent_repo.attach_pipeline_run(intent.id, pipeline_run_id)
        await self.pipeline_run_repo.attach_compile_intent(pipeline_run_id, intent.id)

    async def sign_staged_files(
        self,
        vault_id: UUID,
        files: list[StagedFileInput],
    ) -> list[StagedFileSignedUpload]:
        """Generate presigned PUT URLs for direct-to-R2 staged uploads."""
        vault = await self.vault_service.get(vault_id, strict=True)
        if vault.r2_bucket_name is None:
            raise ValueError(f"Vault {vault_id} has no r2_bucket_name")
        admin = R2Admin(
            account_id=self.settings.r2_account_id,
            access_key_id=self.settings.r2_access_key_id,
            secret_access_key=self.settings.r2_secret_access_key,
        )
        signed: list[StagedFileSignedUpload] = []
        for f in files:
            url = admin.presigned_put_url(
                bucket=vault.r2_bucket_name,
                key=f"staging/{vault_id}/{f.hash}",
                content_type=f.mimetype or "application/octet-stream",
                content_length=f.size,
            )
            signed.append(StagedFileSignedUpload(hash=f.hash, url=url))
        return signed

    async def _write_and_index(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        content: str,
        dest: str,
        pipeline_run_id: UUID | None,
        **build_args,
    ) -> UUID:
        """Build markdown, persist to storage, upsert the DB row, and
        emit a pending compile intent — all in one transaction."""
        rendered = await write_document(storage, content, dest=dest, **build_args)
        doc_id = await self.doc_service.index(vault_id, dest, rendered)
        await self._emit_compile_intent(vault_id, pipeline_run_id)
        return doc_id

    async def ingest_text(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        content: str,
        dest: str,
        origin: str | None = None,
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Ingest raw markdown text. source_type='document'."""
        await self._write_and_index(
            vault_id,
            storage,
            content=content,
            dest=dest,
            pipeline_run_id=pipeline_run_id,
            source_type="document",
            origin=origin,
        )
        return IngestedDocument(file_path=dest)

    async def ingest_upload(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        raw_bytes: bytes,
        filename: str,
        mimetype: str = "",
        dest_path: str | None = None,
        origin: str | None = None,
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Convert an uploaded file to markdown and ingest. source_type='document'."""
        content = await _convert_to_markdown(raw_bytes, filename, mimetype)
        if dest_path:
            dest = _safe_doc_dest(dest_path)
        else:
            slug = slugify(filename.rsplit(".", 1)[0])
            dest = _safe_doc_dest(f"{slug}.md")
        await self._write_and_index(
            vault_id,
            storage,
            content=content,
            dest=dest,
            pipeline_run_id=pipeline_run_id,
            source_type="document",
            origin=origin,
        )
        return IngestedDocument(file_path=dest)

    async def ingest_url(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        url: str,
        origin: str | None = None,
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Fetch a URL, convert to markdown, and ingest. source_type='document'.

        ``origin`` defaults to the URL's netloc when not supplied.
        """
        url = normalize_url(url)
        response = await _fetch_url(url)
        converter = MarkItDown()
        result = await asyncio.to_thread(
            converter.convert_stream,
            io.BytesIO(response.content),
            stream_info=StreamInfo(
                extension=".html",
                mimetype=response.headers.get("content-type", "text/html"),
            ),
        )
        # Filename for dest path: best-effort from the URL path tail.
        # Extract owns the real title — this is just the on-disk slug.
        url_tail = PurePosixPath(urlparse(url).path).stem or "doc"
        dest = raw_path("docs", f"{slugify(url_tail)}.md")
        await self._write_and_index(
            vault_id,
            storage,
            content=result.text_content,
            dest=dest,
            pipeline_run_id=pipeline_run_id,
            source_type="document",
            url=url,
            origin=origin or urlparse(url).netloc,
        )
        return IngestedDocument(file_path=dest)

    async def ingest_user_suggestion(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        body: str,
        intent: UserSuggestionIntent,
        anchored_to: str = "",
        anchored_section: str = "",
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Persist a user suggestion as a source document. source_type='user'."""
        if not body.strip():
            raise ValueError("body is empty")
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        anchor_slug = slugify(anchored_to) if anchored_to else "general"
        filename = f"{ts}-{anchor_slug}-{intent.value}.md"
        dest = raw_path("user", filename)
        await self._write_and_index(
            vault_id,
            storage,
            content=body,
            dest=dest,
            pipeline_run_id=pipeline_run_id,
            source_type="user",
            origin="user-suggestion",
            anchored_to=anchored_to,
            anchored_section=anchored_section,
            intent=intent.value,
        )
        return IngestedDocument(file_path=dest)

    async def ingest_session_exchange(
        self,
        vault_id: UUID,
        storage: Storage,
        *,
        session_id: str,
        exchange: ExchangeEvent,
        session_origin: SessionOrigin | None = None,
        pipeline_run_id: UUID | None = None,
    ) -> IngestedDocument:
        """Persist a promoted session exchange. source_type='session'.

        The path is content-addressable on ``exchange.exId`` so the
        documents-table upsert is idempotent on re-promotion.
        """
        dest = session_exchange_path(exchange.exId)
        args = SessionService.session_exchange_build_args(
            session_id=session_id,
            exchange=exchange,
            session_origin=session_origin,
        )
        await self._write_and_index(
            vault_id,
            storage,
            dest=dest,
            pipeline_run_id=pipeline_run_id,
            **args,
        )
        return IngestedDocument(file_path=dest)


# ---------------------------------------------------------------------------
# Path-safety + markdown conversion helpers
# ---------------------------------------------------------------------------


def _safe_doc_dest(dest_path: str) -> str:
    """Compose a safe ``raw/docs/...`` destination from a user-supplied subpath."""
    if "\\" in dest_path:
        raise ValueError(f"Invalid dest_path: {dest_path}")
    rel = PurePosixPath(dest_path)
    if not rel.parts or rel.is_absolute() or ".." in rel.parts:
        raise ValueError(f"Invalid dest_path: {dest_path}")
    return str(PurePosixPath("raw") / "docs" / rel.with_suffix(".md"))


async def _convert_to_markdown(raw_bytes: bytes, filename: str, mimetype: str) -> str:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".txt"
    if ext in (".md", ".txt", ".text", ".markdown"):
        return raw_bytes.decode("utf-8")
    converter = MarkItDown()
    result = await asyncio.to_thread(
        converter.convert_stream,
        io.BytesIO(raw_bytes),
        stream_info=StreamInfo(extension=ext, mimetype=mimetype),
    )
    return result.text_content


async def _fetch_url(url: str) -> httpx.Response:
    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        response = await client.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            },
        )
        response.raise_for_status()
    return response
