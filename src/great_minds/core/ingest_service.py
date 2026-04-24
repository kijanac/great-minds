"""Ingest service: content conversion, ingestion, and indexing."""

import asyncio
import hashlib
import io
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import PurePosixPath
from uuid import UUID

import httpx
from markitdown import MarkItDown, StreamInfo

from great_minds.core.brain import load_config
from great_minds.core.markdown import parse_frontmatter
from great_minds.core.documents.schemas import DocumentCreate
from great_minds.core.documents.service import DocumentService
from great_minds.core.ingester import (
    build_document,
    ingest_document,
    normalize_url,
    slugify,
)
from great_minds.core.storage import Storage


class UserSuggestionIntent(StrEnum):
    DISAGREE = "disagree"
    CORRECT = "correct"
    ADD_CONTEXT = "add_context"
    RESTRUCTURE = "restructure"


BULK_CONVERT_CONCURRENCY = 4
BULK_BATCH_SIZE = 50


class BulkFileStatus(StrEnum):
    DONE = "done"
    SKIPPED = "skipped"
    ERROR = "error"


@dataclass
class BulkFileInput:
    filename: str
    raw_bytes: bytes
    mimetype: str


@dataclass
class BulkFileEvent:
    index: int
    filename: str
    status: BulkFileStatus
    file_path: str | None = None
    title: str | None = None
    error: str | None = None


class IngestService:
    def __init__(self, doc_service: DocumentService) -> None:
        self.doc_service = doc_service

    async def ingest_text(
        self,
        brain_id: UUID,
        storage: Storage,
        content: str,
        content_type: str,
        dest: str,
        *,
        title: str | None = None,
        author: str | None = None,
        date: str | None = None,
        origin: str | None = None,
        url: str | None = None,
        source_type: str = "document",
    ) -> tuple[str, str]:
        """Ingest raw text content. Returns (file_path, title)."""
        config = load_config(storage)
        kwargs = _build_kwargs(
            title=title, author=author, date=date, origin=origin, url=url
        )
        result = ingest_document(
            storage,
            config,
            content,
            content_type,
            dest=dest,
            source_type=source_type,
            **kwargs,
        )
        await self.doc_service.index_raw_doc(brain_id, dest, result)
        return dest, title or dest

    async def ingest_upload(
        self,
        brain_id: UUID,
        storage: Storage,
        raw_bytes: bytes,
        filename: str,
        content_type: str,
        *,
        mimetype: str = "",
        author: str | None = None,
        date: str | None = None,
        origin: str | None = None,
        url: str | None = None,
        dest_path: str | None = None,
        source_type: str = "document",
    ) -> tuple[str, str]:
        """Ingest an uploaded file. Returns (file_path, title)."""
        content = await _convert_to_markdown(raw_bytes, filename, mimetype)

        if dest_path:
            dest = _safe_upload_dest(content_type, dest_path)
        else:
            slug = slugify(filename.rsplit(".", 1)[0])
            dest = _safe_upload_dest(content_type, f"{slug}.md")

        config = load_config(storage)
        kwargs = _build_kwargs(author=author, date=date, origin=origin, url=url)
        result = ingest_document(
            storage,
            config,
            content,
            content_type,
            dest=dest,
            source_type=source_type,
            **kwargs,
        )
        await self.doc_service.index_raw_doc(brain_id, dest, result)
        return dest, filename

    async def ingest_bulk(
        self,
        brain_id: UUID,
        storage: Storage,
        files: list[BulkFileInput],
        content_type: str,
        *,
        source_type: str = "document",
    ) -> AsyncIterator[BulkFileEvent]:
        """Ingest N uploaded files, yielding a per-file event as each completes.

        - Converts with bounded concurrency (BULK_CONVERT_CONCURRENCY).
        - Skips files whose final hash matches an existing row (idempotent re-ingest).
        - Batches DB writes (BULK_BATCH_SIZE per commit).

        Caller is responsible for compile-spawn after the iterator is exhausted.
        """
        config = load_config(storage)
        existing_hashes = await self.doc_service.get_raw_file_hashes(brain_id)
        semaphore = asyncio.Semaphore(BULK_CONVERT_CONCURRENCY)

        tasks = [
            asyncio.create_task(
                _process_bulk_file(
                    index=i,
                    item=item,
                    storage=storage,
                    config=config,
                    content_type=content_type,
                    source_type=source_type,
                    existing_hashes=existing_hashes,
                    semaphore=semaphore,
                )
            )
            for i, item in enumerate(files)
        ]
        pending_docs: list[DocumentCreate] = []

        for coro in asyncio.as_completed(tasks):
            event, doc = await coro
            if doc is not None:
                pending_docs.append(doc)
                if len(pending_docs) >= BULK_BATCH_SIZE:
                    await self.doc_service.batch_index_raw_docs(brain_id, pending_docs)
                    pending_docs.clear()
            yield event

        if pending_docs:
            await self.doc_service.batch_index_raw_docs(brain_id, pending_docs)

    async def ingest_user_suggestion(
        self,
        brain_id: UUID,
        storage: Storage,
        *,
        body: str,
        intent: UserSuggestionIntent,
        anchored_to: str = "",
        anchored_section: str = "",
    ) -> tuple[str, str]:
        """Persist a user suggestion as a source document.

        Writes to raw/user/<ts>-<slug>.md with source_type=user. body is
        expected to be substantive prose (either user-written or
        UI-reframed); this method does no reframing — it persists the
        authored content as a first-class source that enters the
        pipeline through the same rail as ingested documents.
        """
        if not body.strip():
            raise ValueError("body is empty")

        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        anchor_slug = slugify(anchored_to) if anchored_to else "general"
        filename = f"{ts}-{anchor_slug}-{intent.value}.md"
        dest = _safe_upload_dest("user", filename)

        config = load_config(storage)
        result = ingest_document(
            storage,
            config,
            body,
            "user",
            dest=dest,
            origin="user-suggestion",
            source_type="user",
            intent=intent.value,
            anchored_to=anchored_to,
            anchored_section=anchored_section,
        )
        await self.doc_service.index_raw_doc(brain_id, dest, result)
        return dest, filename

    async def ingest_url(
        self,
        brain_id: UUID,
        storage: Storage,
        url: str,
        content_type: str,
        *,
        source_type: str = "document",
    ) -> tuple[str, str]:
        """Fetch a URL, convert to markdown, and ingest. Returns (file_path, title)."""
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

        title = result.title or url
        dest = f"raw/{content_type}/{slugify(title)}.md"

        config = load_config(storage)
        ingested = ingest_document(
            storage,
            config,
            result.text_content,
            content_type,
            dest=dest,
            title=title,
            url=url,
            source_type=source_type,
        )
        await self.doc_service.index_raw_doc(brain_id, dest, ingested)
        return dest, title


async def _process_bulk_file(
    *,
    index: int,
    item: BulkFileInput,
    storage: Storage,
    config: dict,
    content_type: str,
    source_type: str,
    existing_hashes: dict[str, str],
    semaphore: asyncio.Semaphore,
) -> tuple[BulkFileEvent, DocumentCreate | None]:
    """Convert one file, write it if new, return (event, doc_to_upsert).

    Returns doc=None when the file was skipped (hash match) or errored.
    """
    async with semaphore:
        try:
            content = await _convert_to_markdown(
                item.raw_bytes, item.filename, item.mimetype
            )
            slug = slugify(item.filename.rsplit(".", 1)[0])
            dest = _safe_upload_dest(content_type, f"{slug}.md")
            content_with_fm = build_document(
                config, content, content_type, source_type=source_type
            )
        except Exception as exc:
            return (
                BulkFileEvent(
                    index=index,
                    filename=item.filename,
                    status=BulkFileStatus.ERROR,
                    error=str(exc),
                ),
                None,
            )

    file_hash = hashlib.sha256(content_with_fm.encode()).hexdigest()
    if existing_hashes.get(dest) == file_hash:
        return (
            BulkFileEvent(
                index=index,
                filename=item.filename,
                status=BulkFileStatus.SKIPPED,
                file_path=dest,
            ),
            None,
        )

    storage.write(dest, content_with_fm)
    fm, _ = parse_frontmatter(content_with_fm)
    doc = DocumentCreate.from_frontmatter(fm, dest, content_with_fm)
    return (
        BulkFileEvent(
            index=index,
            filename=item.filename,
            status=BulkFileStatus.DONE,
            file_path=dest,
            title=fm.get("title") or item.filename,
        ),
        doc,
    )


def _build_kwargs(**fields: str | int | None) -> dict:
    return {k: v for k, v in fields.items() if v is not None}


def _safe_upload_dest(content_type: str, dest_path: str) -> str:
    content_type_path = PurePosixPath(content_type)
    if (
        not content_type
        or "\\" in content_type
        or content_type_path.is_absolute()
        or content_type_path.parts != (content_type,)
        or content_type in {".", ".."}
    ):
        raise ValueError(f"Invalid content_type: {content_type}")

    if "\\" in dest_path:
        raise ValueError(f"Invalid dest_path: {dest_path}")

    rel = PurePosixPath(dest_path)
    if not rel.parts or rel.is_absolute() or ".." in rel.parts:
        raise ValueError(f"Invalid dest_path: {dest_path}")

    return str(PurePosixPath("raw") / content_type / rel.with_suffix(".md"))


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
